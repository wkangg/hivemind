// An in-memory chain and an in-memory GOAT Flow for tests. The chain rejects a wrong nonce
// the way a real node would, so the tests also check the sequencer's ordering.
import { decodeFunctionData, erc20Abi, keccak256, parseTransaction, type Address, type Hex } from "viem";
import type { Chain } from "../src/chain.ts";
import type { Flow } from "../src/goatflow.ts";

export const TOKEN: Address = "0x29D1Ee93e9ecf6E50F309f498e40a6b42D352Fa1";

export function fakeChain() {
  const txs = new Map<Hex, { to: Address | null; value: bigint; input: Hex }>();
  const chain: Chain & { txs: typeof txs; failNextBroadcast: boolean; transfers(): { to: Address; amount: bigint }[] } = {
    chainId: 48816,
    txs,
    failNextBroadcast: false,
    /** Every token transfer sent so far. */
    transfers: () =>
      [...txs.values()].map((tx) => {
        const { args } = decodeFunctionData({ abi: erc20Abi, data: tx.input });
        return { to: args[0] as Address, amount: args[1] as bigint };
      }),
    balance: async () => 10n ** 18n,
    tokenBalance: async () => 10n ** 9n,
    nonce: async () => txs.size,
    fees: async () => ({ maxFeePerGas: 200_000n, maxPriorityFeePerGas: 130_000n }),
    broadcast: async (raw) => {
      if (chain.failNextBroadcast) {
        chain.failNextBroadcast = false;
        throw new Error("node is down");
      }
      const tx = parseTransaction(raw);
      if (tx.nonce !== txs.size) throw new Error(`nonce ${tx.nonce} but expected ${txs.size}`);
      // Mining takes a moment, so concurrent payments really overlap.
      await new Promise((resolve) => setTimeout(resolve, 5));
      txs.set(keccak256(raw), { to: tx.to ?? null, value: tx.value ?? 0n, input: tx.data ?? "0x" });
    },
    receipt: async (hash) => {
      if (!txs.has(hash)) throw new Error("timed out");
      return "success";
    },
    transaction: async (hash) => txs.get(hash) ?? null,
  };
  return chain;
}

// Stands in for GOAT Flow. It issues orders in the documented x402 shape. Each transfer to
// the merchant pays for one order: an order counts as paid once there is a transfer that
// no other order has already been matched to.
export function fakeFlow(chain: ReturnType<typeof fakeChain>, payTo: Address): Flow {
  const orders: string[] = [];
  const paid = new Set<string>();
  return {
    createOrder: async (_payer, amount) => {
      const orderId = `order-${orders.length + 1}`;
      orders.push(orderId);
      return {
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: `eip155:${chain.chainId}`,
            amount: amount.toString(),
            asset: TOKEN,
            payTo,
            maxTimeoutSeconds: 600,
            extra: { flow: "ERC20_DIRECT", tokenSymbol: "USDC" },
          },
        ],
        extensions: { goatx402: { paymentMethod: "transfer", receiveType: "DIRECT" } },
        order_id: orderId,
        flow: "ERC20_DIRECT",
        token_symbol: "USDC",
      };
    },
    isPaid: async (orderId) => {
      if (!orders.includes(orderId)) return false;
      const received = chain.transfers().filter((t) => t.to.toLowerCase() === payTo.toLowerCase()).length;
      if (!paid.has(orderId) && received > paid.size) paid.add(orderId);
      return paid.has(orderId);
    },
  };
}
