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

Payments are made in test USDC through [GOAT Flow x402](https://docs.goat.network/docs/build/goat-flow/overview). Before the demo:

1. Fund the gateway wallet with test BTC for gas at the [GOAT Testnet3 faucet](https://bridge.testnet3.goat.network/faucet).
2. Get test USDC for it: `bun run wallet claim` (or `pnpm wallet claim`).
3. Register a merchant at the [Testnet3 merchant portal](https://flow-merchant.testnet3.goat.network), then put its API key and secret in `.env` as `GOATFLOW_API_KEY` and `GOATFLOW_API_SECRET`.
4. Set `SELLER_ADDRESS` in `.env` to the merchant's receiving address.

The demo has one agent buy data from one seller, retry the same request, and then get switched off.

## How a purchase works

1. **Intent:** the agent calls `POST /buy` with `{url, reason}` and its agent token. It holds no wallet key.
2. **Quote:** the gateway asks the seller. The seller creates a GOAT Flow order and replies `402` with its x402 payment terms: a price, a token, an address and an order ID.
3. **Policy:** the gateway checks the seller, the address, the token and the price, then sets the money aside against the shared budget and the agent's limit in one database transaction.
4. **Settlement:** the gateway sends a USDC transfer to the seller's address. The seller asks GOAT Flow whether the order is paid, then returns the data.
5. **Audit:** every decision is logged, including refused ones, with the agent, the reason and the transaction hash.

An admin can switch one agent off with `POST /agents/<name>/off`. That agent is refused from then on, and the others keep paying.

## Licence

MIT
