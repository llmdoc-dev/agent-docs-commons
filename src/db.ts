import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { PLATFORM_WALLET } from "./payout.ts";
import { reputationDelta, type ReputationEvent } from "./quality.ts";

export type SnippetStatus = "pending" | "verified" | "rejected";

export type Snippet = {
  id: string;
  library: string;
  libraryVersion: string;
  title: string;
  body: string;
  sourceUrl: string;
  license: string;
  contentHash: string;
  submitterWallet: string;
  status: SnippetStatus;
  createdAt: string;
  retrievedAt: string;
};

export type Verification = {
  id: string;
  snippetId: string;
  verifierWallet: string;
  verdict: "confirm" | "stale" | "reject";
  note: string | null;
  createdAt: string;
};

export type WalletRow = {
  address: string;
  reputation: number;
  queriesPaid: number;
  contributions: number;
  verifications: number;
};

export function openDb(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath) || ".", { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS snippets (
      id TEXT PRIMARY KEY,
      library TEXT NOT NULL,
      library_version TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      source_url TEXT NOT NULL,
      license TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE,
      submitter_wallet TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      retrieved_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS verifications (
      id TEXT PRIMARY KEY,
      snippet_id TEXT NOT NULL,
      verifier_wallet TEXT NOT NULL,
      verdict TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (snippet_id, verifier_wallet),
      FOREIGN KEY (snippet_id) REFERENCES snippets(id)
    );
    CREATE TABLE IF NOT EXISTS wallets (
      address TEXT PRIMARY KEY,
      reputation INTEGER NOT NULL DEFAULT 0,
      queries_paid INTEGER NOT NULL DEFAULT 0,
      contributions INTEGER NOT NULL DEFAULT 0,
      verifications INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS queries (
      id TEXT PRIMARY KEY,
      payer_wallet TEXT,
      library TEXT,
      question TEXT NOT NULL,
      fee_micros INTEGER NOT NULL,
      payment_mode TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS query_facts (
      query_id TEXT NOT NULL,
      snippet_id TEXT NOT NULL,
      PRIMARY KEY (query_id, snippet_id),
      FOREIGN KEY (query_id) REFERENCES queries(id),
      FOREIGN KEY (snippet_id) REFERENCES snippets(id)
    );
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id TEXT PRIMARY KEY,
      query_id TEXT NOT NULL,
      snippet_id TEXT,
      wallet TEXT NOT NULL,
      role TEXT NOT NULL,
      amount_micros INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (query_id) REFERENCES queries(id)
    );
    CREATE TABLE IF NOT EXISTS payout_runs (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      summary_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snippets_library ON snippets(library);
    CREATE INDEX IF NOT EXISTS idx_ledger_wallet ON ledger_entries(wallet);
  `);
}

function nowIso(): string {
  return new Date().toISOString();
}

function mapSnippet(row: Record<string, unknown>): Snippet {
  return {
    id: String(row.id),
    library: String(row.library),
    libraryVersion: String(row.library_version),
    title: String(row.title),
    body: String(row.body),
    sourceUrl: String(row.source_url),
    license: String(row.license),
    contentHash: String(row.content_hash),
    submitterWallet: String(row.submitter_wallet),
    status: String(row.status) as SnippetStatus,
    createdAt: String(row.created_at),
    retrievedAt: String(row.retrieved_at),
  };
}

export function upsertWallet(db: DatabaseSync, address: string): void {
  db.prepare(
    `INSERT INTO wallets (address, reputation, queries_paid, contributions, verifications)
     VALUES (?, 0, 0, 0, 0)
     ON CONFLICT(address) DO NOTHING`,
  ).run(address);
}

export function bumpReputation(db: DatabaseSync, address: string, event: ReputationEvent): void {
  if (address === PLATFORM_WALLET || address === "reserve") return;
  upsertWallet(db, address);
  const delta = reputationDelta(event);
  db.prepare(`UPDATE wallets SET reputation = reputation + ? WHERE address = ?`).run(delta, address);
}

export function getWallet(db: DatabaseSync, address: string): WalletRow | null {
  const row = db.prepare(`SELECT * FROM wallets WHERE address = ?`).get(address) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    address: String(row.address),
    reputation: Number(row.reputation),
    queriesPaid: Number(row.queries_paid),
    contributions: Number(row.contributions),
    verifications: Number(row.verifications),
  };
}

export function insertSnippet(
  db: DatabaseSync,
  snippet: Omit<Snippet, "id" | "createdAt"> & { id?: string },
): Snippet {
  const id = snippet.id ?? randomUUID();
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO snippets (
      id, library, library_version, title, body, source_url, license,
      content_hash, submitter_wallet, status, created_at, retrieved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    snippet.library,
    snippet.libraryVersion,
    snippet.title,
    snippet.body,
    snippet.sourceUrl,
    snippet.license,
    snippet.contentHash,
    snippet.submitterWallet,
    snippet.status,
    createdAt,
    snippet.retrievedAt,
  );
  if (snippet.submitterWallet !== PLATFORM_WALLET) {
    upsertWallet(db, snippet.submitterWallet);
    db.prepare(`UPDATE wallets SET contributions = contributions + 1 WHERE address = ?`).run(
      snippet.submitterWallet,
    );
  }
  return getSnippet(db, id)!;
}

export function getSnippet(db: DatabaseSync, id: string): Snippet | null {
  const row = db.prepare(`SELECT * FROM snippets WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapSnippet(row) : null;
}

export function getSnippetByHash(db: DatabaseSync, hash: string): Snippet | null {
  const row = db.prepare(`SELECT * FROM snippets WHERE content_hash = ?`).get(hash) as
    | Record<string, unknown>
    | undefined;
  return row ? mapSnippet(row) : null;
}

export function listSnippets(db: DatabaseSync, library?: string): Snippet[] {
  const rows = library
    ? (db.prepare(`SELECT * FROM snippets WHERE library = ? ORDER BY created_at ASC`).all(library) as Record<string, unknown>[])
    : (db.prepare(`SELECT * FROM snippets ORDER BY created_at ASC`).all() as Record<string, unknown>[]);
  return rows.map(mapSnippet);
}

export function listLibraries(db: DatabaseSync): { library: string; count: number }[] {
  const rows = db.prepare(
    `SELECT library, COUNT(*) AS count FROM snippets GROUP BY library ORDER BY library`,
  ).all() as Record<string, unknown>[];
  return rows.map((r) => ({ library: String(r.library), count: Number(r.count) }));
}

export function insertVerification(
  db: DatabaseSync,
  input: { snippetId: string; verifierWallet: string; verdict: "confirm" | "stale" | "reject"; note?: string },
): Verification {
  const id = randomUUID();
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO verifications (id, snippet_id, verifier_wallet, verdict, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.snippetId, input.verifierWallet, input.verdict, input.note ?? null, createdAt);
  upsertWallet(db, input.verifierWallet);
  db.prepare(`UPDATE wallets SET verifications = verifications + 1 WHERE address = ?`).run(
    input.verifierWallet,
  );
  return {
    id,
    snippetId: input.snippetId,
    verifierWallet: input.verifierWallet,
    verdict: input.verdict,
    note: input.note ?? null,
    createdAt,
  };
}

export function listVerifications(db: DatabaseSync, snippetId: string): Verification[] {
  const rows = db.prepare(
    `SELECT * FROM verifications WHERE snippet_id = ? ORDER BY created_at ASC`,
  ).all(snippetId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    snippetId: String(r.snippet_id),
    verifierWallet: String(r.verifier_wallet),
    verdict: r.verdict as Verification["verdict"],
    note: r.note == null ? null : String(r.note),
    createdAt: String(r.created_at),
  }));
}

export function standingConfirmers(db: DatabaseSync, snippetId: string): string[] {
  const rows = db.prepare(
    `SELECT verifier_wallet FROM verifications WHERE snippet_id = ? AND verdict = 'confirm'`,
  ).all(snippetId) as Record<string, unknown>[];
  return rows.map((r) => String(r.verifier_wallet));
}

export function setSnippetStatus(db: DatabaseSync, id: string, status: SnippetStatus): void {
  db.prepare(`UPDATE snippets SET status = ? WHERE id = ?`).run(status, id);
}

export function recordQuery(
  db: DatabaseSync,
  input: {
    payerWallet: string | null;
    library: string | null;
    question: string;
    feeMicros: number;
    paymentMode: string;
    snippetIds: string[];
  },
): string {
  const id = randomUUID();
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO queries (id, payer_wallet, library, question, fee_micros, payment_mode, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.payerWallet,
    input.library,
    input.question,
    input.feeMicros,
    input.paymentMode,
    createdAt,
  );
  const factIns = db.prepare(`INSERT INTO query_facts (query_id, snippet_id) VALUES (?, ?)`);
  for (const snippetId of input.snippetIds) {
    factIns.run(id, snippetId);
  }
  if (input.payerWallet) {
    upsertWallet(db, input.payerWallet);
    db.prepare(`UPDATE wallets SET queries_paid = queries_paid + 1 WHERE address = ?`).run(
      input.payerWallet,
    );
  }
  return id;
}

export function insertLedgerLines(
  db: DatabaseSync,
  queryId: string,
  lines: { wallet: string; role: string; snippetId: string | null; amountMicros: number }[],
): void {
  const createdAt = nowIso();
  const ins = db.prepare(
    `INSERT INTO ledger_entries (id, query_id, snippet_id, wallet, role, amount_micros, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
  );
  for (const line of lines) {
    ins.run(randomUUID(), queryId, line.snippetId, line.wallet, line.role, line.amountMicros, createdAt);
  }
}

export type PendingPayout = {
  wallet: string;
  amountMicros: number;
  roles: string[];
  entryCount: number;
};

export function pendingPayouts(db: DatabaseSync): PendingPayout[] {
  const rows = db.prepare(
    `SELECT wallet, SUM(amount_micros) AS amount_micros, GROUP_CONCAT(DISTINCT role) AS roles, COUNT(*) AS entry_count
     FROM ledger_entries
     WHERE status = 'pending' AND wallet NOT IN ('platform', 'reserve')
     GROUP BY wallet
     ORDER BY amount_micros DESC`,
  ).all() as Record<string, unknown>[];
  return rows.map((r) => ({
    wallet: String(r.wallet),
    amountMicros: Number(r.amount_micros),
    roles: String(r.roles).split(","),
    entryCount: Number(r.entry_count),
  }));
}

export function ledgerSummary(db: DatabaseSync): {
  pendingMicros: number;
  platformMicros: number;
  reserveMicros: number;
  entryCount: number;
} {
  const row = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN wallet NOT IN ('platform','reserve') AND status='pending' THEN amount_micros END), 0) AS pending_micros,
       COALESCE(SUM(CASE WHEN wallet='platform' THEN amount_micros END), 0) AS platform_micros,
       COALESCE(SUM(CASE WHEN wallet='reserve' THEN amount_micros END), 0) AS reserve_micros,
       COUNT(*) AS entry_count
     FROM ledger_entries`,
  ).get() as Record<string, unknown>;
  return {
    pendingMicros: Number(row.pending_micros),
    platformMicros: Number(row.platform_micros),
    reserveMicros: Number(row.reserve_micros),
    entryCount: Number(row.entry_count),
  };
}

export function recordDryRun(db: DatabaseSync, summary: unknown): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO payout_runs (id, mode, created_at, summary_json) VALUES (?, 'dry_run', ?, ?)`,
  ).run(id, nowIso(), JSON.stringify(summary, null, 2));
  return id;
}
