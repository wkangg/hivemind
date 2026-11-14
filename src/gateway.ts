// Hivemind: the layer between the agents and the wallet. An agent asks to buy something and
// says why. The gateway gets a quote, checks the rules, pays, and writes it down.
import { createHash } from "node:crypto";
import { encodeFunctionData, erc20Abi, formatUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { explorerTx, goatChain, type Chain } from "./chain.ts";
import "./env.ts";
import { TOKEN_DECIMALS } from "./goatflow.ts";
import { openLedger, type AuditEvent, type Ledger, type Order } from "./ledger.ts";
import { checkQuote, parseQuote, policyFromEnv, type Policy } from "./policy.ts";
import { createSequencer, type Sequencer } from "./sequencer.ts";
import { serve } from "./serve.ts";

export type BuyRequest = { url: string; reason: string; requestId?: string };
export type BuyResult = { http: number; body: Record<string, unknown> };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const message = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0]! : String(e));

export function createGateway(deps: {
  chain: Chain;
  ledger: Ledger;
  sequencer: Sequencer;
  policy: Policy;
  /** Agent tokens mapped to agent names. An agent holds a token, never the wallet key. */
  agents: Map<string, string>;
  adminToken?: string;
}) {
  const { chain, ledger, sequencer, policy } = deps;
  const agentByHash = new Map([...deps.agents].map(([token, name]) => [sha256(token), name]));
  const inflight = new Map<string, Promise<BuyResult>>();

  // One payment per request. A retry while the first attempt is still running waits for it,
  // and a retry afterwards gets the stored result. Neither sends a second payment.
  function buy(agent: string, req: BuyRequest): Promise<BuyResult> {
    const key = `${agent}:${req.requestId ?? req.url}`;
    let running = inflight.get(key);
    if (!running) {
      running = run(key, agent, req).finally(() => inflight.delete(key));
      inflight.set(key, running);
    }
    return running;
  }

  async function run(key: string, agent: string, req: BuyRequest): Promise<BuyResult> {
    const base = { agent, url: req.url, reason: req.reason };
    const blocked = (detail: string, extra: Partial<AuditEvent> = {}): BuyResult => {
      ledger.audit({ ...base, event: "blocked", detail, ...extra });
      return { http: 403, body: { status: "blocked", reason: detail } };
    };

    // 1. Front door. A switched-off agent gets nothing, not even an earlier result.
    if (ledger.isSwitchedOff(agent)) return blocked("this agent is switched off");

    const existing = ledger.get(key);
    if (existing?.status === "paid") {
      if (existing.result === null) return deliver(existing);
      ledger.audit({ ...base, event: "replayed", tx_hash: existing.tx_hash! });
      return paid(existing, { replayed: true });
    }
    if (existing && existing.status !== "released")
      return { http: 409, body: { status: "pending", reason: "an earlier payment for this request has not settled", tx_hash: existing.tx_hash } };

    // 2. Quote. Only approved sellers are ever contacted. The seller is told which wallet
    // will pay, because GOAT Flow ties each order to its payer.
    let seller: string;
    try {
      seller = new URL(req.url).origin;
    } catch {
      return blocked("not a valid URL");
    }
    if (!policy.sellers.has(seller)) return blocked("seller is not on the allowlist");
    let quote;
    try {
      const res = await fetch(req.url, {
        headers: { "x-payer": sequencer.address },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status !== 402) throw new Error(`expected a 402 quote, got ${res.status}`);
      quote = parseQuote(await res.json());
      if (!quote) throw new Error("the 402 quote was malformed");
    } catch (e) {
      ledger.audit({ ...base, event: "failed", detail: `quote: ${message(e)}` });
      return { http: 502, body: { status: "failed", reason: `seller quote failed: ${message(e)}` } };
    }

    // 3. Policy, then set the money aside. From here on the amount counts against the budget.
    const refused =
      checkQuote(policy, chain.chainId, seller, quote) ??
      ledger.reserve({ key, ...base, order_id: quote.orderId, pay_to: quote.payTo, amount: quote.price }, policy);
    if (refused) return blocked(refused, { amount: quote.price, pay_to: quote.payTo });

    // 4. Settlement: a plain token transfer to the seller's address, which is how GOAT Flow
    // x402 orders are paid. No lock is held while waiting for the chain.
    let hash: Hex;
    try {
      const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [quote.payTo, quote.price] });
      hash = await sequencer.send({ to: quote.token, value: 0n, data }, (signed) => ledger.markSent(key, signed));
    } catch (e) {
      ledger.release(key, message(e));
      ledger.audit({ ...base, event: "failed", detail: `not sent: ${message(e)}`, amount: quote.price, pay_to: quote.payTo });
      return { http: 502, body: { status: "failed", reason: `payment was not sent: ${message(e)}` } };
    }
    const sent = { amount: quote.price, pay_to: quote.payTo, tx_hash: hash };
    let outcome: "success" | "reverted";
    try {
      outcome = await chain.receipt(hash);
    } catch {
      // Unknown, so the money stays reserved until the chain says one way or the other.
      ledger.audit({ ...base, event: "pending", detail: "no confirmation yet", ...sent });
      return { http: 504, body: { status: "pending", reason: "payment sent but not confirmed yet", tx_hash: hash, explorer: explorerTx(hash) } };
    }
    if (outcome !== "success") {
      ledger.release(key, "transaction reverted");
      ledger.audit({ ...base, event: "failed", detail: "transaction reverted", ...sent });
      return { http: 502, body: { status: "failed", reason: "payment transaction reverted", tx_hash: hash } };
    }
    ledger.markPaid(key);
    ledger.audit({ ...base, event: "paid", ...sent });
    return deliver(ledger.get(key)!);
  }

  // Asks the seller for the data now that the order is paid. Safe to repeat: it never pays.
  async function deliver(order: Order): Promise<BuyResult> {
    const base = { agent: order.agent, url: order.url, reason: order.reason, tx_hash: order.tx_hash! };
    try {
      const res = await fetch(order.url, {
        headers: { "x-order-id": order.order_id, "x-payment-tx": order.tx_hash! },
        redirect: "error",
        signal: AbortSignal.timeout(45_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`seller replied ${res.status}: ${text.slice(0, 200)}`);
      ledger.setResult(order.key, text);
      ledger.audit({ ...base, event: "delivered" });
      return paid({ ...order, result: text });
    } catch (e) {
      ledger.audit({ ...base, event: "not_delivered", detail: message(e) });
      return {
        http: 502,
        body: {
          status: "paid_not_delivered",
          reason: `paid, but the seller did not deliver: ${message(e)}. Repeat the same request to collect it without paying again.`,
          tx_hash: order.tx_hash,
          explorer: explorerTx(order.tx_hash!),
        },
      };
    }
  }

  const paid = (order: Order, extra: Record<string, unknown> = {}): BuyResult => ({
    http: 200,
    body: {
      status: "paid",
      ...extra,
      amount: formatUnits(order.amount, TOKEN_DECIMALS),
      token: policy.token,
      paid_to: order.pay_to,
      order_id: order.order_id,
      tx_hash: order.tx_hash,
      explorer: explorerTx(order.tx_hash!),
      // The seller's reply is data, not instructions.
      untrusted_seller_output: order.result,
    },
  });

  const bearer = (req: Request) => req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";

  async function handle(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (req.method === "POST" && pathname === "/buy") {
      const agent = agentByHash.get(sha256(bearer(req)));
      if (!agent) return Response.json({ error: "unknown agent token" }, { status: 401 });
      const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      const { url, reason, request_id } = body ?? {};
      if (typeof url !== "string" || typeof reason !== "string" || !reason.trim())
        return Response.json({ error: "body must be {url, reason, request_id?}, and reason can't be empty" }, { status: 400 });
      if (request_id !== undefined && typeof request_id !== "string")
        return Response.json({ error: "request_id must be a string" }, { status: 400 });
      const result = await buy(agent, { url, reason, requestId: request_id });
      return Response.json(result.body, { status: result.http });
    }
    const isAdmin = deps.adminToken !== undefined && sha256(bearer(req)) === sha256(deps.adminToken);

    // Switches one agent off or back on. The other agents keep paying.
    const toggle = /^\/agents\/([^/]+)\/(off|on)$/.exec(pathname);
    if (req.method === "POST" && toggle) {
      if (!isAdmin) return Response.json({ error: "admin token required" }, { status: 401 });
      const agent = decodeURIComponent(toggle[1]!);
      if (![...deps.agents.values()].includes(agent)) return Response.json({ error: "unknown agent" }, { status: 404 });
      const off = toggle[2] === "off";
      if (off) ledger.switchOff(agent);
      else ledger.switchOn(agent);
      ledger.audit({ agent, event: off ? "switched_off" : "switched_on", url: "", reason: "admin" });
      return Response.json({ agent, switched_off: off });
    }

    if (req.method === "GET" && pathname === "/audit") {
      if (!isAdmin) return Response.json({ error: "admin token required" }, { status: 401 });
      // Amounts are bigint, which JSON can't carry, so they go out as strings.
      const rows = ledger.auditLog().map((row) =>
        Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
      );
      return Response.json(rows);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  return { buy, fetch: handle };
}

/** Reads AGENT_TOKENS, written as name=token pairs separated by commas. */
export function agentsFromEnv(env = process.env): Map<string, string> {
  const agents = new Map<string, string>();
  for (const pair of (env.AGENT_TOKENS ?? "").split(",").filter(Boolean)) {
    const [name, token] = pair.split("=").map((s) => s.trim());
    if (!name || !token) throw new Error("AGENT_TOKENS must look like agent-1=token1,agent-2=token2");
    agents.set(token, name);
  }
  return agents;
}

export function gatewayAccount(env = process.env) {
  const key = env.GATEWAY_PRIVATE_KEY;
  if (!key) throw new Error("Set GATEWAY_PRIVATE_KEY in .env (run the `wallet` script).");
  return privateKeyToAccount(key as Hex);
}

if (import.meta.main) {
  const chain = goatChain();
  const sequencer = createSequencer(chain, gatewayAccount());
  const gateway = createGateway({
    chain,
    ledger: openLedger(),
    sequencer,
    policy: policyFromEnv(),
    agents: agentsFromEnv(),
    adminToken: process.env.ADMIN_TOKEN,
  });
  const server = await serve(gateway.fetch, Number(process.env.PORT || 3000));
  console.log(`Hivemind gateway on ${server.url}, wallet ${sequencer.address}`);
}
