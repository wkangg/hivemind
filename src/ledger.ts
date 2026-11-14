// Gateway state in SQLite: one row per order, plus an append-only audit log.
// Amounts are wei stored as 64-bit integers, which holds up to about 9.2 BTC.
import { DatabaseSync } from "node:sqlite";
import type { Signed } from "./sequencer.ts";

// reserved: money set aside, nothing sent yet
// sent:     transaction signed and stored; it may or may not be on-chain
// paid:     transaction confirmed
// released: payment failed before it was sent, money returned to the budget
export type Status = "reserved" | "sent" | "paid" | "released";

export type Order = {
  key: string;
  agent: string;
  url: string;
  reason: string;
  order_id: string;
  pay_to: string;
  amount: bigint;
  status: Status;
  nonce: bigint | null;
  tx_hash: string | null;
  raw_tx: string | null;
  result: string | null;
  error: string | null;
};

export type AuditEvent = {
  agent: string;
  event: "blocked" | "paid" | "delivered" | "not_delivered" | "failed" | "pending" | "replayed";
  url: string;
  reason: string;
  detail?: string;
  amount?: bigint;
  pay_to?: string;
  tx_hash?: string;
};

export type Limits = { budget: bigint; agentLimit: bigint };

export function openLedger(path = process.env.LEDGER_FILE || "hivemind.sqlite") {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS orders (
      key TEXT PRIMARY KEY,
      agent TEXT NOT NULL, url TEXT NOT NULL, reason TEXT NOT NULL,
      order_id TEXT NOT NULL, pay_to TEXT NOT NULL, amount INTEGER NOT NULL,
      status TEXT NOT NULL,
      nonce INTEGER, tx_hash TEXT, raw_tx TEXT, result TEXT, error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      agent TEXT NOT NULL, event TEXT NOT NULL, url TEXT NOT NULL, reason TEXT NOT NULL,
      detail TEXT, amount INTEGER, pay_to TEXT, tx_hash TEXT
    );
  `);

  // Amounts can be larger than a JavaScript number holds exactly, so integers are read as bigint.
  const query = (sql: string) => {
    const statement = db.prepare(sql);
    statement.setReadBigInts(true);
    return statement;
  };
  const run = (sql: string, ...params: (string | bigint | null)[]) => db.prepare(sql).run(...params);
  const total = (row: unknown) => (row as { total: bigint }).total;

  const held = query("SELECT COALESCE(SUM(amount), 0) AS total FROM orders WHERE status != 'released'");
  const heldBy = query(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM orders WHERE status != 'released' AND agent = ?",
  );
  const insert = db.prepare(
    `INSERT OR REPLACE INTO orders (key, agent, url, reason, order_id, pay_to, amount, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved')`,
  );
  const selectOrder = query("SELECT * FROM orders WHERE key = ?");
  const selectAudit = query("SELECT * FROM audit ORDER BY id");

  // Checking the budget and setting the money aside is one transaction, so two agents can
  // never both spend the same money. Returns why it was refused, or null if reserved.
  function reserve(
    o: Pick<Order, "key" | "agent" | "url" | "reason" | "order_id" | "pay_to" | "amount">,
    limits: Limits,
  ): string | null {
    db.exec("BEGIN IMMEDIATE");
    try {
      const refused =
        total(held.get()) + o.amount > limits.budget ? "over the shared budget"
        : total(heldBy.get(o.agent)) + o.amount > limits.agentLimit ? "over this agent's limit"
        : null;
      if (!refused) insert.run(o.key, o.agent, o.url, o.reason, o.order_id, o.pay_to, o.amount);
      db.exec("COMMIT");
      return refused;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  return {
    reserve,
    get: (key: string) => selectOrder.get(key) as Order | undefined,
    markSent: (key: string, s: Signed) =>
      run(
        "UPDATE orders SET status = 'sent', nonce = ?, tx_hash = ?, raw_tx = ? WHERE key = ?",
        BigInt(s.nonce),
        s.hash,
        s.raw,
        key,
      ),
    markPaid: (key: string) => run("UPDATE orders SET status = 'paid' WHERE key = ?", key),
    setResult: (key: string, result: string) => run("UPDATE orders SET result = ? WHERE key = ?", result, key),
    release: (key: string, error: string) =>
      run("UPDATE orders SET status = 'released', error = ? WHERE key = ?", error, key),
    spent: () => total(held.get()),
    audit: (e: AuditEvent) =>
      run(
        "INSERT INTO audit (agent, event, url, reason, detail, amount, pay_to, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        e.agent,
        e.event,
        e.url,
        e.reason,
        e.detail ?? null,
        e.amount ?? null,
        e.pay_to ?? null,
        e.tx_hash ?? null,
      ),
    auditLog: () => selectAudit.all() as Record<string, unknown>[],
    close: () => db.close(),
  };
}

export type Ledger = ReturnType<typeof openLedger>;
