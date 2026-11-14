// A mock data seller that takes payment through GOAT Flow x402. Asking for data gets a 402
// carrying a GOAT Flow order. Asking again with the order ID gets the data, once GOAT Flow
// confirms the order has been paid.
import { createHash } from "node:crypto";
import { isAddress, parseUnits } from "viem";
import "./env.ts";
import { goatFlow, TOKEN_DECIMALS, type Flow } from "./goatflow.ts";
import { serve } from "./serve.ts";

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

export function createSeller(opts: { flow: Flow; price: bigint; confirmTimeoutMs?: number }) {
  // Which resource each order was sold for, so an order can't be used to collect another one.
  const orders = new Map<string, string>();
  const json = (status: number, body: unknown) => Response.json(body, { status });

  return async function fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const symbol = /^\/data\/([A-Za-z0-9]{1,10})$/.exec(path)?.[1];
    if (req.method !== "GET" || !symbol) return json(404, { error: "not found" });

    const orderId = req.headers.get("x-order-id");
    if (!orderId) {
      // GOAT Flow ties each order to the wallet that will pay it.
      const payer = req.headers.get("x-payer") ?? "";
      if (!isAddress(payer)) return json(400, { error: "send the paying wallet's address in X-Payer" });
      try {
        const x402 = await opts.flow.createOrder(payer, opts.price);
        if (typeof x402.order_id !== "string") throw new Error("GOAT Flow returned no order ID");
        orders.set(x402.order_id, path);
        return json(402, x402);
      } catch (e) {
        console.error("GOAT Flow order failed:", e);
        return json(502, { error: "could not create a payment order" });
      }
    }

    if (orders.get(orderId) !== path) return json(404, { error: "unknown order" });
    // GOAT Flow watches the chain, so the payment can take a few seconds to show as confirmed.
    const deadline = Date.now() + (opts.confirmTimeoutMs ?? 30_000);
    for (;;) {
      const paid = await opts.flow.isPaid(orderId).catch(() => false);
      if (paid) return json(200, marketData(symbol));
      if (Date.now() >= deadline) return json(402, { error: "GOAT Flow has not confirmed payment for this order" });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  };
}

if (import.meta.main) {
  const server = await serve(
    createSeller({ flow: goatFlow(), price: parseUnits(process.env.PRICE || "0.1", TOKEN_DECIMALS) }),
    Number(process.env.SELLER_PORT || 3001),
  );
  console.log(`Seller on ${server.url}/data/<symbol>, paid through GOAT Flow`);
}
