// An in-memory chain for tests. It rejects a wrong nonce the way a real node would,
// so the tests also check the sequencer's ordering.
import { keccak256, parseTransaction, type Address, type Hex } from "viem";
import type { Chain } from "../src/chain.ts";

export function fakeChain() {
  const txs = new Map<Hex, { to: Address | null; value: bigint; input: Hex }>();
  const chain: Chain & { txs: typeof txs; failNextBroadcast: boolean } = {
    chainId: 48816,
    txs,
    failNextBroadcast: false,
    balance: async () => 10n ** 18n,
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
