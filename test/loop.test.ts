// Runs on Node (`node --test`) and on Bun (`bun test`).
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createGateway } from "../src/gateway.ts";
import { openLedger } from "../src/ledger.ts";
import { createSeller } from "../src/seller.ts";
import { createSequencer } from "../src/sequencer.ts";
import { serve } from "../src/serve.ts";
import { fakeChain } from "./fake-chain.ts";

const PRICE = 1_000n;
const sellerAddress = privateKeyToAccount(generatePrivateKey()).address;
const thiefAddress = privateKeyToAccount(generatePrivateKey()).address;
const servers: { stop(): void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.stop()));

// A seller and a gateway wired to a fake chain. `quotedAddress` lets a seller ask to be paid
// somewhere other than its allowlisted address.
async function setup(opts: { budget?: bigint; agentLimit?: bigint; maxPrice?: bigint; quotedAddress?: Hex } = {}) {
  const chain = fakeChain();
  const seller = await serve(createSeller({ chain, payTo: opts.quotedAddress ?? sellerAddress, price: PRICE }), 0);
  servers.push(seller);
  const ledger = openLedger(":memory:");
  const gateway = createGateway({
    chain,
    ledger,
    sequencer: createSequencer(chain, privateKeyToAccount(generatePrivateKey())),
    policy: {
      budget: opts.budget ?? 100_000n,
      agentLimit: opts.agentLimit ?? 100_000n,
      maxPrice: opts.maxPrice ?? 10_000n,
      sellers: new Map([[seller.url, sellerAddress]]),
    },
    agents: new Map([["token-1", "agent-1"]]),
    adminToken: "admin",
  });
  const url = `${seller.url}/data/BTC`;
  const events = () => ledger.auditLog().map((row) => row.event);
  return { chain, gateway, ledger, url, events };
}

test("pays the seller the quoted price with the order ID as data, and returns the data", async () => {
  const { chain, gateway, url, events } = await setup();
  const { http, body } = await gateway.buy("agent-1", { url, reason: "need the price" });
  assert.equal(http, 200);
  assert.equal(JSON.parse(body.untrusted_seller_output as string).symbol, "BTC");
  assert.equal(chain.txs.size, 1);
  const tx = chain.txs.get(body.tx_hash as Hex)!;
  assert.equal(tx.to, sellerAddress.toLowerCase());
  assert.equal(tx.value, PRICE);
  assert.equal(tx.input, body.order_id);
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

test("a price over the cap is refused", async () => {
  const { chain, gateway, url } = await setup({ maxPrice: PRICE - 1n });
  const { body } = await gateway.buy("agent-1", { url, reason: "need the price" });
  assert.equal(body.reason, "price is over the per-purchase cap");
  assert.equal(chain.txs.size, 0);
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

test("the seller refuses a payment that was made for a different order", async () => {
  const { gateway, url } = await setup();
  const paid = await gateway.buy("agent-1", { url, reason: "need the price" });
  const quote = (await (await fetch(url)).json()) as { order_id: string };
  const res = await fetch(url, { headers: { "x-order-id": quote.order_id, "x-payment-tx": paid.body.tx_hash as string } });
  assert.equal(res.status, 402);
  assert.equal(((await res.json()) as { error: string }).error, "payment is for a different order");
});

test("the HTTP API needs an agent token to buy and the admin token to read the audit log", async () => {
  const { gateway, url } = await setup();
  const post = (token: string) =>
    gateway.fetch(
      new Request("http://gateway/buy", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ url, reason: "need the price" }),
      }),
    );
  assert.equal((await post("stolen-guess")).status, 401);
  assert.equal((await post("token-1")).status, 200);
  const audit = (token: string) =>
    gateway.fetch(new Request("http://gateway/audit", { headers: { authorization: `Bearer ${token}` } }));
  assert.equal((await audit("token-1")).status, 401);
  const rows = (await (await audit("admin")).json()) as { event: string; amount: string }[];
  assert.equal(rows[0]!.event, "paid");
  assert.equal(rows[0]!.amount, PRICE.toString());
});

test("the server passes the request body and headers through to the handler", async () => {
  const echo = await serve(async (req) => Response.json({ auth: req.headers.get("authorization"), body: await req.json() }), 0);
  servers.push(echo);
  const res = await fetch(echo.url, { method: "POST", headers: { authorization: "Bearer t" }, body: '{"a":1}' });
  assert.deepEqual(await res.json(), { auth: "Bearer t", body: { a: 1 } });
});
