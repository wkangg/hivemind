# hivemind

Agentic Payments Hackathon Toronto.

Many AI agents share one crypto wallet on GOAT Network. Hivemind is the layer between the agents and the wallet: agents never touch the wallet, they ask Hivemind to buy something and say why. Hivemind checks the rules, pays, and writes it down.

## What it does

1. Keeps the team inside a shared budget.
2. Gives each agent its own spending limit.
3. Never pays twice for the same thing.
4. Only pays sellers you've approved, at the address you approved.
5. Records every payment, with the transaction hash as proof.

## Run it

It runs on [Bun](https://bun.sh), or on Node 22.18 or newer with pnpm. There is no build step.

| | Bun | Node and pnpm |
|---|---|---|
| Install | `bun install` | `pnpm install` |
| Test (offline, against a fake chain) | `bun test` | `pnpm test` |
| Create testnet wallets in `.env` | `bun run wallet` | `pnpm wallet` |
| Run the demo | `bun run demo` | `pnpm demo` |

Before the demo, fund the gateway wallet with test BTC at the [GOAT Testnet3 faucet](https://bridge.testnet3.goat.network/faucet). The demo has one agent buy data from one seller, end to end.

## How a purchase works

1. **Intent:** the agent calls `POST /buy` with `{url, reason}` and its agent token. It holds no wallet key.
2. **Quote:** the gateway asks the seller, which replies `402` with a price, an address and an order ID.
3. **Policy:** the gateway checks the seller, the address and the price, then sets the money aside against the shared budget and the agent's limit in one database transaction.
4. **Settlement:** the gateway pays in test BTC with the order ID as the transaction data. The seller checks the payment on-chain and returns the data.
5. **Audit:** every decision is logged, including refused ones, with the agent, the reason and the transaction hash.

## Licence

MIT
