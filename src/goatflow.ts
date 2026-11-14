// The seller's side of GOAT Flow x402. The seller is a GOAT Flow merchant: it creates an
// order for each sale and later asks GOAT Flow whether that order has been paid.
// Tests swap in a fake that implements the same interface.
import { randomUUID } from "node:crypto";
import { GoatFlowClient } from "goatflow-sdk-server";
import type { Address } from "viem";
import { goatTestnet3 } from "./chain.ts";

export const GOATFLOW_TESTNET = "https://flow-api.testnet3.goat.network";
export const USDC: Address = "0x29D1Ee93e9ecf6E50F309f498e40a6b42D352Fa1";
export const TOKEN_DECIMALS = 6;

export interface Flow {
  /** Creates an order and returns GOAT Flow's x402 "Payment Required" body, unchanged. */
  createOrder(payer: Address, amount: bigint): Promise<Record<string, unknown>>;
  /** True once GOAT Flow has seen the payment for this order on-chain. */
  isPaid(orderId: string): Promise<boolean>;
}

export function goatFlow(env = process.env): Flow {
  const { GOATFLOW_API_KEY: apiKey, GOATFLOW_API_SECRET: apiSecret } = env;
  if (!apiKey || !apiSecret) throw new Error("Set GOATFLOW_API_KEY and GOATFLOW_API_SECRET in .env (from the merchant portal).");
  const client = new GoatFlowClient({ baseUrl: env.GOATFLOW_BASE_URL || GOATFLOW_TESTNET, apiKey, apiSecret });
  return {
    createOrder: async (payer, amount) =>
      (await client.createOrderRaw({
        dappOrderId: randomUUID(),
        chainId: goatTestnet3.id,
        tokenSymbol: env.TOKEN_SYMBOL || "USDC",
        tokenContract: env.TOKEN_ADDRESS || USDC,
        fromAddress: payer,
        amountWei: amount.toString(),
      })) as unknown as Record<string, unknown>,
    isPaid: async (orderId) => {
      const { status } = await client.getOrderStatus(orderId);
      return status === "PAYMENT_CONFIRMED" || status === "INVOICED";
    },
  };
}
