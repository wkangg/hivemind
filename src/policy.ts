// The spending rules, and the checks on a seller's quote. Nothing here talks to a model:
// an agent can ask for anything, and this code decides.
import { isAddress, parseUnits, type Address } from "viem";
import { TOKEN_DECIMALS, USDC } from "./goatflow.ts";

// All amounts are in the token's smallest unit (USDC has 6 decimals).
export type Policy = {
  /** Total the whole fleet may spend. */
  budget: bigint;
  /** Total one agent may spend. */
  agentLimit: bigint;
  /** Most the gateway will pay for one purchase. */
  maxPrice: bigint;
  /** The only token the gateway pays in. */
  token: Address;
  /** Approved sellers: the origin of their API mapped to the only address they may be paid at. */
  sellers: Map<string, Address>;
};

export type Quote = { orderId: string; price: bigint; payTo: Address; token: Address; chainId: number };

/**
 * Reads a GOAT Flow x402 "Payment Required" body. Returns null if anything is missing,
 * malformed, or asks for a kind of payment the gateway doesn't make.
 */
export function parseQuote(body: unknown): Quote | null {
  if (typeof body !== "object" || body === null) return null;
  const { order_id, accepts, extensions } = body as Record<string, any>;
  const option = Array.isArray(accepts) ? accepts[0] : undefined;
  if (typeof order_id !== "string" || !/^[\w.:-]{1,200}$/.test(order_id)) return null;
  if (typeof option !== "object" || option === null) return null;
  const { scheme, network, amount, asset, payTo } = option as Record<string, unknown>;
  const chain = typeof network === "string" ? /^eip155:(\d{1,10})$/.exec(network)?.[1] : undefined;
  if (scheme !== "exact" || !chain) return null;
  if (typeof amount !== "string" || !/^[1-9]\d{0,18}$/.test(amount)) return null;
  if (typeof asset !== "string" || !isAddress(asset)) return null;
  if (typeof payTo !== "string" || !isAddress(payTo)) return null;
  // The gateway only pays by a plain token transfer. It never signs anything a seller sends.
  const method = extensions?.goatx402?.paymentMethod;
  if (method !== undefined && method !== "transfer") return null;
  return { orderId: order_id, price: BigInt(amount), payTo, token: asset, chainId: Number(chain) };
}

/** Returns why the quote is refused, or null if it's acceptable. */
export function checkQuote(policy: Policy, chainId: number, seller: string, quote: Quote): string | null {
  const approved = policy.sellers.get(seller);
  if (!approved) return "seller is not on the allowlist";
  if (quote.payTo.toLowerCase() !== approved.toLowerCase()) return "seller quoted an address that is not on its allowlist";
  if (quote.chainId !== chainId) return "seller quoted a different chain";
  if (quote.token.toLowerCase() !== policy.token.toLowerCase()) return "seller quoted a token the gateway doesn't pay in";
  if (quote.price > policy.maxPrice) return "price is over the per-purchase cap";
  return null;
}

/** Reads the policy from the environment. Amounts are in whole tokens, such as 0.5. */
export function policyFromEnv(env = process.env): Policy {
  const sellers = new Map<string, Address>();
  for (const pair of (env.SELLERS ?? "").split(",").filter(Boolean)) {
    const at = pair.lastIndexOf("=");
    const address = pair.slice(at + 1).trim();
    if (at < 0 || !isAddress(address)) throw new Error(`SELLERS entry "${pair}" must look like https://seller.example=0x...`);
    sellers.set(new URL(pair.slice(0, at).trim()).origin, address);
  }
  const token = env.TOKEN_ADDRESS || USDC;
  if (!isAddress(token)) throw new Error("TOKEN_ADDRESS is not an address");
  return {
    budget: parseUnits(env.BUDGET || "5", TOKEN_DECIMALS),
    agentLimit: parseUnits(env.AGENT_LIMIT || "1", TOKEN_DECIMALS),
    maxPrice: parseUnits(env.MAX_PRICE || "0.5", TOKEN_DECIMALS),
    token,
    sellers,
  };
}
