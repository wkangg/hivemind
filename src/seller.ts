// A mock data seller. Asking for data gets a 402 with a quote. Asking again with the order ID
// and the hash of a payment gets the data, once the seller has checked the payment on-chain.
import { createHash, randomBytes } from "node:crypto";
import { isAddress, parseEther, type Address, type Hex } from "viem";
import { goatChain, type Chain } from "./chain.ts";
import "./env.ts";
import { serve } from "./serve.ts";

type SellerOrder = { path: string; txHash?: string };

/** Made-up market data, the same every time for the same symbol. */
export function marketData(symbol: string) {
  const h = createHash("sha256").update(symbol.toUpperCase()).digest();
  return {
    symbol: symbol.toUpperCase(),
    price_usd: Number((10 + (h.readUInt32BE(0) % 99_000) / 100).toFixed(2)),
    change_24h_pct: Number((((h.readUInt16BE(4) % 2000) - 1000) / 100).toFixed(2)),
    note: "Mock data for a demo.",
  };
}

export function createSeller(opts: { chain: Chain; payTo: Address; price: bigint }) {
  const orders = new Map<string, SellerOrder>();
  const json = (status: number, body: unknown) => Response.json(body, { status });

  return async function fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const symbol = /^\/data\/([A-Za-z0-9]{1,10})$/.exec(path)?.[1];
    if (req.method !== "GET" || !symbol) return json(404, { error: "not found" });

    const orderId = req.headers.get("x-order-id");
    if (!orderId) {
      const id = `0x${randomBytes(32).toString("hex")}`;
      orders.set(id, { path });
      return json(402, {
        order_id: id,
        price: opts.price.toString(),
        pay_to: opts.payTo,
        chain_id: opts.chain.chainId,
        how_to_pay: "Send `price` wei to `pay_to` with `order_id` as the transaction data, then repeat this request with headers X-Order-Id and X-Payment-Tx.",
      });
    }

    const order = orders.get(orderId);
    if (!order || order.path !== path) return json(404, { error: "unknown order" });
    const txHash = req.headers.get("x-payment-tx")?.toLowerCase() ?? "";
    if (!/^0x[0-9a-f]{64}$/.test(txHash)) return json(402, { error: "X-Payment-Tx must be a transaction hash" });

    if (order.txHash !== txHash) {
      if (order.txHash) return json(402, { error: "order was paid by a different transaction" });
      const problem = await checkPayment(opts, orderId, txHash as Hex);
      if (problem) return json(402, { error: problem });
      order.txHash = txHash;
    }
    return json(200, marketData(symbol));
  };
}

// The order ID in the transaction data ties a payment to one order, so a payment for
// one order can't be shown again to collect a different one.
async function checkPayment(opts: { chain: Chain; payTo: Address; price: bigint }, orderId: string, txHash: Hex) {
  try {
    if ((await opts.chain.receipt(txHash, 30_000)) !== "success") return "payment transaction failed";
  } catch {
    return "payment transaction not found on-chain";
  }
  const tx = await opts.chain.transaction(txHash);
  if (!tx) return "payment transaction not found on-chain";
  if (tx.to?.toLowerCase() !== opts.payTo.toLowerCase()) return "payment went to a different address";
  if (tx.value < opts.price) return "payment is less than the price";
  if (tx.input.toLowerCase() !== orderId) return "payment is for a different order";
  return null;
}

if (import.meta.main) {
  const payTo = process.env.SELLER_ADDRESS;
  if (!payTo || !isAddress(payTo)) throw new Error("Set SELLER_ADDRESS in .env (run the `wallet` script).");
  const server = await serve(
    createSeller({ chain: goatChain(), payTo, price: parseEther(process.env.PRICE_BTC || "0.000001") }),
    Number(process.env.SELLER_PORT || 3001),
  );
  console.log(`Seller on ${server.url}/data/<symbol>, paid at ${payTo}`);
}
