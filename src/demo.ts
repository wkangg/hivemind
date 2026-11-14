// The demo: one agent buys data from one seller on GOAT Testnet3, paid in USDC through
// GOAT Flow x402. It starts the seller and the gateway in this process, so one command
// shows the whole loop.
import "./env.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { formatEther, formatUnits, isAddress, parseUnits } from "viem";
import { FAUCET, goatChain } from "./chain.ts";
import { createGateway, gatewayAccount } from "./gateway.ts";
import { goatFlow, TOKEN_DECIMALS } from "./goatflow.ts";
import { openLedger } from "./ledger.ts";
import { policyFromEnv } from "./policy.ts";
import { createSeller } from "./seller.ts";
import { createSequencer } from "./sequencer.ts";
import { serve } from "./serve.ts";

const chain = goatChain();
const account = gatewayAccount();
const policy = policyFromEnv();
const payTo = process.env.SELLER_ADDRESS;
if (!payTo || !isAddress(payTo))
  throw new Error("Set SELLER_ADDRESS in .env to the receiving address configured in the GOAT Flow merchant portal.");
const price = parseUnits(process.env.PRICE || "0.1", TOKEN_DECIMALS);

const [gas, tokens] = await Promise.all([chain.balance(account.address), chain.tokenBalance(policy.token, account.address)]);
console.log(`Gateway wallet ${account.address}`);
console.log(`  ${formatEther(gas)} test BTC for gas, ${formatUnits(tokens, TOKEN_DECIMALS)} USDC to spend`);
if (gas === 0n) {
  console.log(`\nThe wallet needs test BTC for gas. Get some at ${FAUCET}`);
  process.exit(1);
}
if (tokens < price) {
  console.log("\nThe wallet needs USDC. Run the `wallet` script with `claim` to get 20 from the token faucet.");
  process.exit(1);
}

const seller = await serve(createSeller({ flow: goatFlow(), price }), 3001);
const token = randomBytes(24).toString("hex");
const admin = randomBytes(24).toString("hex");
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
const asAdmin = (path: string, method = "GET") =>
  fetch(`${gateway.url}${path}`, { method, headers: { authorization: `Bearer ${admin}` } });

const url = `${seller.url}/data/BTC`;
const reason = "Need the current BTC price for the morning report";
const requestId = randomUUID();
console.log(`\nagent-1 asks to buy ${url}`);
const first = await buy(url, reason, requestId);
console.log(`→ ${first.status} in ${first.seconds}s`, first.body);

console.log("\nagent-1 thinks the request timed out and sends it again");
const again = await buy(url, reason, requestId);
console.log(`→ ${again.status} in ${again.seconds}s, replayed: ${again.body.replayed === true}, same transaction: ${again.body.tx_hash === first.body.tx_hash}`);

console.log("\nThe admin switches agent-1 off, and it tries to buy again");
await asAdmin("/agents/agent-1/off", "POST");
const off = await buy(url, reason, randomUUID());
console.log(`→ ${off.status}`, off.body);

console.log("\nAudit log:");
console.table(await (await asAdmin("/audit")).json(), ["at", "agent", "event", "amount", "pay_to", "tx_hash", "detail"]);

seller.stop();
gateway.stop();
process.exit(first.status === 200 ? 0 : 1);
