// The spending rules, and the checks on a seller's quote. Nothing here talks to a model:
// an agent can ask for anything, and this code decides.
import { isAddress, parseEther, type Address, type Hex } from "viem";

export type Policy = {
  /** Total the whole fleet may spend, in wei. */
  budget: bigint;
  /** Total one agent may spend, in wei. */
  agentLimit: bigint;
  /** Most the gateway will pay for one purchase, in wei. */
  maxPrice: bigint;
  /** Approved sellers: the origin of their API mapped to the only address they may be paid at. */
  sellers: Map<string, Address>;
};

export type Quote = { orderId: Hex; price: bigint; payTo: Address; chainId: number };

/** Reads a seller's 402 body. Returns null if anything is missing or malformed. */
export function parseQuote(body: unknown): Quote | null {
  if (typeof body !== "object" || body === null) return null;
  const { order_id, price, pay_to, chain_id } = body as Record<string, unknown>;
  if (typeof order_id !== "string" || !/^0x[0-9a-f]{64}$/.test(order_id)) return null;
  if (typeof price !== "string" || !/^[1-9]\d{0,18}$/.test(price)) return null;
  if (typeof pay_to !== "string" || !isAddress(pay_to)) return null;
  if (typeof chain_id !== "number") return null;
  return { orderId: order_id as Hex, price: BigInt(price), payTo: pay_to, chainId: chain_id };
}

/** Returns why the quote is refused, or null if it's acceptable. */
export function checkQuote(policy: Policy, chainId: number, seller: string, quote: Quote): string | null {
  const approved = policy.sellers.get(seller);
  if (!approved) return "seller is not on the allowlist";
  if (quote.payTo.toLowerCase() !== approved.toLowerCase()) return "seller quoted an address that is not on its allowlist";
  if (quote.chainId !== chainId) return "seller quoted a different chain";
  if (quote.price > policy.maxPrice) return "price is over the per-purchase cap";
  return null;
}

/** Reads the policy from the environment. Amounts are in BTC. */
export function policyFromEnv(env = process.env): Policy {
  const sellers = new Map<string, Address>();
  for (const pair of (env.SELLERS ?? "").split(",").filter(Boolean)) {
    const at = pair.lastIndexOf("=");
    const address = pair.slice(at + 1).trim();
    if (at < 0 || !isAddress(address)) throw new Error(`SELLERS entry "${pair}" must look like https://seller.example=0x...`);
    sellers.set(new URL(pair.slice(0, at).trim()).origin, address);
  }
  return {
    budget: parseEther(env.BUDGET_BTC || "0.0001"),
    agentLimit: parseEther(env.AGENT_LIMIT_BTC || "0.00002"),
    maxPrice: parseEther(env.MAX_PRICE_BTC || "0.00001"),
    sellers,
  };
}
