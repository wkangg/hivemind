// GOAT Testnet3, and the few chain calls the gateway and seller need.
// Tests swap in a fake that implements the same interface.
import { createPublicClient, defineChain, erc20Abi, http, TransactionNotFoundError, type Address, type Hex } from "viem";

export const EXPLORER = "https://explorer.testnet3.goat.network";
export const FAUCET = "https://bridge.testnet3.goat.network/faucet";
export const explorerTx = (hash: string) => `${EXPLORER}/tx/${hash}`;

export const goatTestnet3 = defineChain({
  id: 48816,
  name: "GOAT Testnet3",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet3.goat.network"] } },
  blockExplorers: { default: { name: "GOAT Explorer", url: EXPLORER } },
});

export interface Chain {
  chainId: number;
  /** Test BTC, which pays for gas. */
  balance(address: Address): Promise<bigint>;
  /** Balance of an ERC-20 token, in its smallest unit. */
  tokenBalance(token: Address, address: Address): Promise<bigint>;
  /** Next nonce for the address, counting transactions still pending. */
  nonce(address: Address): Promise<number>;
  fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  broadcast(raw: Hex): Promise<void>;
  /** Waits for the transaction to be mined. Throws if it isn't within the timeout. */
  receipt(hash: Hex, timeoutMs?: number): Promise<"success" | "reverted">;
  transaction(hash: Hex): Promise<{ to: Address | null; value: bigint; input: Hex } | null>;
}

export function goatChain(rpcUrl = process.env.RPC_URL || goatTestnet3.rpcUrls.default.http[0]): Chain {
  // The public RPC is rate-limited, so every call goes through this one client, with retries.
  const client = createPublicClient({ chain: goatTestnet3, transport: http(rpcUrl, { retryCount: 5 }) });
  return {
    chainId: goatTestnet3.id,
    balance: (address) => client.getBalance({ address }),
    tokenBalance: (token, address) =>
      client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    nonce: (address) => client.getTransactionCount({ address, blockTag: "pending" }),
    fees: () => client.estimateFeesPerGas(),
    broadcast: async (raw) => {
      await client.sendRawTransaction({ serializedTransaction: raw });
    },
    receipt: async (hash, timeoutMs = 60_000) =>
      (await client.waitForTransactionReceipt({ hash, timeout: timeoutMs, pollingInterval: 1_000 })).status,
    transaction: async (hash) => {
      try {
        const { to, value, input } = await client.getTransaction({ hash });
        return { to, value, input };
      } catch (e) {
        if (e instanceof TransactionNotFoundError) return null;
        throw e;
      }
    },
  };
}
