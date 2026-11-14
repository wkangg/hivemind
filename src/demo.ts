// The demo: one agent buys data from one seller on GOAT Testnet3, end to end.
// It starts the seller and the gateway in this process, so one command shows the whole loop.
import "./env.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { formatEther, isAddress, parseEther } from "viem";
import { FAUCET, goatChain } from "./chain.ts";
import { createGateway, gatewayAccount } from "./gateway.ts";
import { openLedger } from "./ledger.ts";
import { policyFromEnv } from "./policy.ts";
import { createSeller } from "./seller.ts";
import { createSequencer } from "./sequencer.ts";
import { serve } from "./serve.ts";

const chain = goatChain();
const account = gatewayAccount();
const payTo = process.env.SELLER_ADDRESS;
if (!payTo || !isAddress(payTo)) throw new Error("Set SELLER_ADDRESS in .env (run the `wallet` script).");
const price = parseEther(process.env.PRICE_BTC || "0.000001");

const balance = await chain.balance(account.address);
console.log(`Gateway wallet ${account.address} holds ${formatEther(balance)} BTC`);
if (balance < price * 2n) {
  console.log(`\nThat's not enough to pay ${formatEther(price)} BTC plus gas. Get test BTC at ${FAUCET}`);
  process.exit(1);
}

const seller = await serve(createSeller({ chain, payTo, price }), 3001);
const token = randomBytes(24).toString("hex");
const admin = randomBytes(24).toString("hex");
const policy = policyFromEnv();
policy.sellers.set(seller.url, payTo);
const gateway = await serve(
  createGateway({
    chain,
    ledger: openLedger(":memory:"),
    sequencer: createSequencer(chain, account),
    policy,
    agents: new Map([[token, "agent-1"]]),
    adminToken: admin,
  }).fetch,
  3000,
);

// The agent's whole view of payments: it asks, and says why. It has a token, not a key.
async function buy(url: string, reason: string, requestId: string) {
  const started = performance.now();
  const res = await fetch(`${gateway.url}/buy`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ url, reason, request_id: requestId }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, seconds: ((performance.now() - started) / 1000).toFixed(1) };
}

const url = `${seller.url}/data/BTC`;
const requestId = randomUUID();
console.log(`\nagent-1 asks to buy ${url}`);
const first = await buy(url, "Need the current BTC price for the morning report", requestId);
console.log(`→ ${first.status} in ${first.seconds}s`, first.body);

console.log("\nagent-1 thinks the request timed out and sends it again");
const again = await buy(url, "Need the current BTC price for the morning report", requestId);
console.log(`→ ${again.status} in ${again.seconds}s, replayed: ${again.body.replayed === true}, same transaction: ${again.body.tx_hash === first.body.tx_hash}`);

console.log("\nAudit log:");
const audit = await fetch(`${gateway.url}/audit`, { headers: { authorization: `Bearer ${admin}` } });
console.table(await audit.json(), ["at", "agent", "event", "amount", "pay_to", "tx_hash", "reason"]);

seller.stop();
gateway.stop();
process.exit(first.status === 200 ? 0 : 1);
