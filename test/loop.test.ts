// Runs on Node (`node --test`) and on Bun (`bun test`).
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createGateway } from "../src/gateway.ts";
import { openLedger } from "../src/ledger.ts";
import { parseQuote } from "../src/policy.ts";
import { createSeller } from "../src/seller.ts";
import { createSequencer } from "../src/sequencer.ts";
import { serve } from "../src/serve.ts";
import { fakeChain, fakeFlow, TOKEN } from "./fake-chain.ts";

const PRICE = 100_000n; // 0.1 USDC
const sellerAddress = privateKeyToAccount(generatePrivateKey()).address;
const thiefAddress = privateKeyToAccount(generatePrivateKey()).address;
const servers: { stop(): void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.stop()));

// A seller and a gateway wired to a fake chain and a fake GOAT Flow. `quotedAddress` lets a
// seller ask to be paid somewhere other than its allowlisted address.
async function setup(
  opts: { budget?: bigint; agentLimit?: bigint; maxPrice?: bigint; quotedAddress?: Address; token?: Address } = {},
) {
  const chain = fakeChain();
  const flow = fakeFlow(chain, opts.quotedAddress ?? sellerAddress);
  const seller = await serve(createSeller({ flow, price: PRICE, confirmTimeoutMs: 0 }), 0);
  servers.push(seller);
  const ledger = openLedger(":memory:");
  const gateway = createGateway({
    chain,
    ledger,
    sequencer: createSequencer(chain, privateKeyToAccount(generatePrivateKey())),
    policy: {
      budget: opts.budget ?? PRICE * 100n,
      agentLimit: opts.agentLimit ?? PRICE * 100n,
      maxPrice: opts.maxPrice ?? PRICE * 10n,
      token: opts.token ?? TOKEN,
      sellers: new Map([[seller.url, sellerAddress]]),
    },
    agents: new Map([
      ["token-1", "agent-1"],
      ["token-2", "agent-2"],
    ]),
    adminToken: "admin",
  });
  const url = `${seller.url}/data/BTC`;
  const events = () => ledger.auditLog().map((row) => row.event);
  const call = (method: string, path: string, token: string, body?: unknown) =>
    gateway.fetch(
      new Request(`http://gateway${path}`, {
        method,
        headers: { authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  return { chain, gateway, ledger, url, events, call };
}

test("pays the seller the quoted price as a token transfer, and returns the data", async () => {
  const { chain, gateway, url, events } = await setup();
  const { http, body } = await gateway.buy("agent-1", { url, reason: "need the price" });
  assert.equal(http, 200);
  assert.equal(JSON.parse(body.untrusted_seller_output as string).symbol, "BTC");
  assert.equal(body.amount, "0.1");
  assert.equal(chain.txs.size, 1);
  const tx = [...chain.txs.values()][0]!;
  assert.equal(tx.to, TOKEN.toLowerCase());
  assert.equal(tx.value, 0n);
  assert.deepEqual(chain.transfers(), [{ to: sellerAddress, amount: PRICE }]);
  assert.deepEqual(events(), ["paid", "delivered"]);
});

test("a retry of the same request returns the first result and pays once", async () => {
  const { chain, gateway, url } = await setup();
  const req = { url, reason: "need the price", requestId: "r1" };
  const [a, b] = await Promise.all([gateway.buy("agent-1", req), gateway.buy("agent-1", req)]);
  const c = await gateway.buy("agent-1", req);
  assert.equal(chain.txs.size, 1);
  assert.equal(b.body.tx_hash, a.body.tx_hash);
  assert.equal(c.body.tx_hash, a.body.tx_hash);
  assert.equal(c.body.replayed, true);
});

test("50 buys at once against a budget that covers 10: exactly 10 are paid", async () => {
  const { chain, gateway, ledger, url } = await setup({ budget: PRICE * 10n });
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) => gateway.buy("agent-1", { url, reason: "race", requestId: `r${i}` })),
  );
  assert.equal(results.filter((r) => r.http === 200).length, 10);
  assert.equal(results.filter((r) => r.body.reason === "over the shared budget").length, 40);
  assert.equal(chain.txs.size, 10);
  assert.equal(ledger.spent(), PRICE * 10n);
});

test("an agent can't spend past its own limit", async () => {
  const { chain, gateway, url } = await setup({ agentLimit: PRICE * 2n });
  const results = [];
  for (let i = 0; i < 3; i++) results.push(await gateway.buy("agent-1", { url, reason: "loop", requestId: `r${i}` }));
  assert.deepEqual(results.map((r) => r.http), [200, 200, 403]);
  assert.equal(results[2]!.body.reason, "over this agent's limit");
  assert.equal(chain.txs.size, 2);
});

test("a switched-off agent is refused while the others keep paying, and can be switched back on", async () => {
  const { chain, url, events, call } = await setup();
  const buy = (token: string, id: string) => call("POST", "/buy", token, { url, reason: "need the price", request_id: id });

  assert.equal((await call("POST", "/agents/agent-1/off", "token-1")).status, 401); // an agent can't do it
  assert.equal((await call("POST", "/agents/nobody/off", "admin")).status, 404);
  assert.equal((await call("POST", "/agents/agent-1/off", "admin")).status, 200);

  const refused = await buy("token-1", "a");
  assert.equal(refused.status, 403);
  assert.equal(((await refused.json()) as { reason: string }).reason, "this agent is switched off");
  assert.equal((await buy("token-2", "b")).status, 200);
  assert.equal(chain.txs.size, 1);

  assert.equal((await call("POST", "/agents/agent-1/on", "admin")).status, 200);
  assert.equal((await buy("token-1", "c")).status, 200);
  assert.deepEqual(events(), ["switched_off", "blocked", "paid", "delivered", "switched_on", "paid", "delivered"]);
});

test("a seller that quotes a different address is not paid", async () => {
  const { chain, gateway, url, events } = await setup({ quotedAddress: thiefAddress });
  const { http, body } = await gateway.buy("agent-1", { url, reason: "need the price" });
  assert.equal(http, 403);
  assert.equal(body.reason, "seller quoted an address that is not on its allowlist");
  assert.equal(chain.txs.size, 0);
  assert.deepEqual(events(), ["blocked"]);
});

test("a seller off the allowlist is never contacted or paid", async () => {
  const { chain, gateway } = await setup();
  const { http, body } = await gateway.buy("agent-1", { url: "http://127.0.0.1:1/data/BTC", reason: "injected" });
  assert.equal(http, 403);
  assert.equal(body.reason, "seller is not on the allowlist");
  assert.equal(chain.txs.size, 0);
});

test("a price over the cap, or a quote in another token, is refused", async () => {
  const capped = await setup({ maxPrice: PRICE - 1n });
  assert.equal(
    (await capped.gateway.buy("agent-1", { url: capped.url, reason: "need the price" })).body.reason,
    "price is over the per-purchase cap",
  );
  const otherToken = await setup({ token: thiefAddress });
  assert.equal(
    (await otherToken.gateway.buy("agent-1", { url: otherToken.url, reason: "need the price" })).body.reason,
    "seller quoted a token the gateway doesn't pay in",
  );
  assert.equal(capped.chain.txs.size + otherToken.chain.txs.size, 0);
});

test("a quote that asks for anything but a plain transfer is rejected", () => {
  const quote = (change: (q: any) => void) => {
    const q = {
      order_id: "order-1",
      accepts: [{ scheme: "exact", network: "eip155:48816", amount: "100000", asset: TOKEN, payTo: sellerAddress }],
      extensions: { goatx402: { paymentMethod: "transfer" } },
    };
    change(q);
    return parseQuote(q);
  };
  assert.equal(quote(() => {})?.price, 100_000n);
  assert.equal(quote((q) => (q.extensions.goatx402.paymentMethod = "eip3009-signature")), null);
  assert.equal(quote((q) => (q.accepts[0].amount = "-5")), null);
  assert.equal(quote((q) => (q.accepts[0].payTo = "0x123")), null);
  assert.equal(quote((q) => (q.accepts = [])), null);
  assert.equal(quote((q) => delete q.order_id), null);
});

test("a payment that fails to send returns its money to the budget, and a retry can pay", async () => {
  const { chain, gateway, ledger, url } = await setup();
  chain.failNextBroadcast = true;
  const req = { url, reason: "need the price", requestId: "r1" };
  assert.equal((await gateway.buy("agent-1", req)).http, 502);
  assert.equal(ledger.spent(), 0n);
  assert.equal((await gateway.buy("agent-1", req)).http, 200);
  assert.equal(chain.txs.size, 1);
  assert.equal(ledger.spent(), PRICE);
});

test("the seller doesn't deliver an order that GOAT Flow hasn't seen paid", async () => {
  const { gateway, url } = await setup();
  await gateway.buy("agent-1", { url, reason: "need the price" }); // one paid order exists
  const quote = (await (await fetch(url, { headers: { "x-payer": sellerAddress } })).json()) as { order_id: string };
  const unpaid = await fetch(url, { headers: { "x-order-id": quote.order_id } });
  assert.equal(unpaid.status, 402);
  const unknown = await fetch(url, { headers: { "x-order-id": "order-999" } });
  assert.equal(unknown.status, 404);
});

test("the HTTP API needs an agent token to buy and the admin token to read the audit log", async () => {
  const { url, call } = await setup();
  const body = { url, reason: "need the price" };
  assert.equal((await call("POST", "/buy", "stolen-guess", body)).status, 401);
  assert.equal((await call("POST", "/buy", "token-1", body)).status, 200);
  assert.equal((await call("GET", "/audit", "token-1")).status, 401);
  const rows = (await (await call("GET", "/audit", "admin")).json()) as { event: string; amount: string }[];
  assert.equal(rows[0]!.event, "paid");
  assert.equal(rows[0]!.amount, PRICE.toString());
});

test("the server passes the request body and headers through to the handler", async () => {
  const echo = await serve(async (req) => Response.json({ auth: req.headers.get("authorization"), body: await req.json() }), 0);
  servers.push(echo);
  const res = await fetch(echo.url, { method: "POST", headers: { authorization: "Bearer t" }, body: '{"a":1}' });
  assert.deepEqual(await res.json(), { auth: "Bearer t", body: { a: 1 } });
});
