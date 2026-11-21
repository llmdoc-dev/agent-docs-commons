import { HOUSE_WALLET, isInternalWallet } from "./payout.ts";
import { reputationDelta, type ReputationEvent } from "./quality.ts";

export type Db = {
  exec(sql: string): Promise<void>;
  run(sql: string, ...params: unknown[]): Promise<void>;
  get(sql: string, ...params: unknown[]): Promise<Record<string, unknown> | undefined>;
  all(sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]>;
};

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
  houseOwned: boolean;
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

export const SCHEMA_SQL = `
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
  house_owned INTEGER NOT NULL DEFAULT 0,
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
  settlement_tx TEXT,
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
  payout_tx TEXT,
  payout_run_id TEXT,
  paid_at TEXT,
  FOREIGN KEY (query_id) REFERENCES queries(id)
);
CREATE TABLE IF NOT EXISTS payout_runs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  created_at TEXT NOT NULL,
  summary_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settled_payments (
  id TEXT PRIMARY KEY,
  payer_wallet TEXT,
  transaction_sig TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS referral_attributions (
  payer_wallet TEXT PRIMARY KEY,
  referrer_wallet TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  first_paid_at TEXT,
  window_ends_at TEXT,
  spend_unlocked_at TEXT,
  earned_micros INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS free_lookup_usage (
  identity_key TEXT NOT NULL,
  period TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (identity_key, period)
);
CREATE INDEX IF NOT EXISTS idx_snippets_library ON snippets(library);
CREATE INDEX IF NOT EXISTS idx_ledger_wallet ON ledger_entries(wallet);
CREATE INDEX IF NOT EXISTS idx_referral_referrer ON referral_attributions(referrer_wallet);
`;

export async function migrate(db: Db): Promise<void> {
  await db.exec(SCHEMA_SQL);
  const cols = await db.all(`PRAGMA table_info(snippets)`);
  if (!cols.some((c) => String(c.name) === "house_owned")) {
    await db.exec("ALTER TABLE snippets ADD COLUMN house_owned INTEGER NOT NULL DEFAULT 0");
  }
  const qcols = await db.all(`PRAGMA table_info(queries)`);
  if (qcols.length > 0 && !qcols.some((c) => String(c.name) === "settlement_tx")) {
    await db.exec("ALTER TABLE queries ADD COLUMN settlement_tx TEXT");
  }
  const lcols = await db.all(`PRAGMA table_info(ledger_entries)`);
  for (const col of ["payout_tx", "payout_run_id", "paid_at"]) {
    if (lcols.length > 0 && !lcols.some((c) => String(c.name) === col)) {
      await db.exec(`ALTER TABLE ledger_entries ADD COLUMN ${col} TEXT`);
    }
  }
  await db.exec("CREATE INDEX IF NOT EXISTS idx_ledger_status ON ledger_entries(status)");
  await db.exec(
    `CREATE TABLE IF NOT EXISTS referral_attributions (
      payer_wallet TEXT PRIMARY KEY,
      referrer_wallet TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      first_paid_at TEXT,
      window_ends_at TEXT,
      spend_unlocked_at TEXT,
      earned_micros INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL
    )`,
  );
  await db.exec(
    `CREATE TABLE IF NOT EXISTS free_lookup_usage (
      identity_key TEXT NOT NULL,
      period TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (identity_key, period)
    )`,
  );
  await db.exec("CREATE INDEX IF NOT EXISTS idx_referral_referrer ON referral_attributions(referrer_wallet)");
  await db.exec(
    `UPDATE snippets
     SET house_owned = 1, submitter_wallet = '${HOUSE_WALLET}'
     WHERE submitter_wallet IN ('platform', 'house')`,
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return crypto.randomUUID();
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
    houseOwned: Number(row.house_owned ?? 0) === 1,
    status: String(row.status) as SnippetStatus,
    createdAt: String(row.created_at),
    retrievedAt: String(row.retrieved_at),
  };
}

export async function upsertWallet(db: Db, address: string): Promise<void> {
  await db.run(
    `INSERT INTO wallets (address, reputation, queries_paid, contributions, verifications)
     VALUES (?, 0, 0, 0, 0)
     ON CONFLICT(address) DO NOTHING`,
    address,
  );
}

export async function bumpReputation(db: Db, address: string, event: ReputationEvent): Promise<void> {
  if (isInternalWallet(address)) return;
  await upsertWallet(db, address);
  await db.run(`UPDATE wallets SET reputation = reputation + ? WHERE address = ?`, reputationDelta(event), address);
}

export async function getWallet(db: Db, address: string): Promise<WalletRow | null> {
  const row = await db.get(`SELECT * FROM wallets WHERE address = ?`, address);
  if (!row) return null;
  return {
    address: String(row.address),
    reputation: Number(row.reputation),
    queriesPaid: Number(row.queries_paid),
    contributions: Number(row.contributions),
    verifications: Number(row.verifications),
  };
}

export async function insertSnippet(
  db: Db,
  snippet: Omit<Snippet, "id" | "createdAt" | "houseOwned"> & { id?: string; houseOwned?: boolean },
): Promise<Snippet> {
  const id = snippet.id ?? newId();
  const createdAt = nowIso();
  const houseOwned = snippet.houseOwned === true || isInternalWallet(snippet.submitterWallet);
  const submitter = houseOwned ? HOUSE_WALLET : snippet.submitterWallet;
  await db.run(
    `INSERT INTO snippets (
      id, library, library_version, title, body, source_url, license,
      content_hash, submitter_wallet, house_owned, status, created_at, retrieved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    snippet.library,
    snippet.libraryVersion,
    snippet.title,
    snippet.body,
    snippet.sourceUrl,
    snippet.license,
    snippet.contentHash,
    submitter,
    houseOwned ? 1 : 0,
    snippet.status,
    createdAt,
    snippet.retrievedAt,
  );
  if (!isInternalWallet(submitter)) {
    await upsertWallet(db, submitter);
    await db.run(`UPDATE wallets SET contributions = contributions + 1 WHERE address = ?`, submitter);
  }
  return (await getSnippet(db, id))!;
}

export async function getSnippet(db: Db, id: string): Promise<Snippet | null> {
  const row = await db.get(`SELECT * FROM snippets WHERE id = ?`, id);
  return row ? mapSnippet(row) : null;
}

export async function getSnippetByHash(db: Db, hash: string): Promise<Snippet | null> {
  const row = await db.get(`SELECT * FROM snippets WHERE content_hash = ?`, hash);
  return row ? mapSnippet(row) : null;
}

export async function listSnippets(db: Db, library?: string): Promise<Snippet[]> {
  const rows = library
    ? await db.all(`SELECT * FROM snippets WHERE library = ? ORDER BY created_at ASC`, library)
    : await db.all(`SELECT * FROM snippets ORDER BY created_at ASC`);
  return rows.map(mapSnippet);
}

export async function listLibraries(db: Db): Promise<{ library: string; count: number }[]> {
  const rows = await db.all(
    `SELECT library, COUNT(*) AS count FROM snippets GROUP BY library ORDER BY library`,
  );
  return rows.map((r) => ({ library: String(r.library), count: Number(r.count) }));
}

export async function insertVerification(
  db: Db,
  input: { snippetId: string; verifierWallet: string; verdict: "confirm" | "stale" | "reject"; note?: string },
): Promise<Verification> {
  const id = newId();
  const createdAt = nowIso();
  await db.run(
    `INSERT INTO verifications (id, snippet_id, verifier_wallet, verdict, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    input.snippetId,
    input.verifierWallet,
    input.verdict,
    input.note ?? null,
    createdAt,
  );
  await upsertWallet(db, input.verifierWallet);
  await db.run(`UPDATE wallets SET verifications = verifications + 1 WHERE address = ?`, input.verifierWallet);
  return {
    id,
    snippetId: input.snippetId,
    verifierWallet: input.verifierWallet,
    verdict: input.verdict,
    note: input.note ?? null,
    createdAt,
  };
}

export async function listVerifications(db: Db, snippetId: string): Promise<Verification[]> {
  const rows = await db.all(
    `SELECT * FROM verifications WHERE snippet_id = ? ORDER BY created_at ASC`,
    snippetId,
  );
  return rows.map((r) => ({
    id: String(r.id),
    snippetId: String(r.snippet_id),
    verifierWallet: String(r.verifier_wallet),
    verdict: r.verdict as Verification["verdict"],
    note: r.note == null ? null : String(r.note),
    createdAt: String(r.created_at),
  }));
}

export async function standingConfirmers(db: Db, snippetId: string): Promise<string[]> {
  const rows = await db.all(
    `SELECT verifier_wallet FROM verifications WHERE snippet_id = ? AND verdict = 'confirm'`,
    snippetId,
  );
  return rows.map((r) => String(r.verifier_wallet));
}

export async function setSnippetStatus(db: Db, id: string, status: SnippetStatus): Promise<void> {
  await db.run(`UPDATE snippets SET status = ? WHERE id = ?`, status, id);
}

export async function recordQuery(
  db: Db,
  input: {
    payerWallet: string | null;
    library: string | null;
    question: string;
    feeMicros: number;
    paymentMode: string;
    snippetIds: string[];
    settlementTx?: string | null;
  },
): Promise<string> {
  const id = newId();
  const createdAt = nowIso();
  await db.run(
    `INSERT INTO queries (id, payer_wallet, library, question, fee_micros, payment_mode, settlement_tx, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.payerWallet,
    input.library,
    input.question,
    input.feeMicros,
    input.paymentMode,
    input.settlementTx ?? null,
    createdAt,
  );
  for (const snippetId of input.snippetIds) {
    await db.run(`INSERT INTO query_facts (query_id, snippet_id) VALUES (?, ?)`, id, snippetId);
  }
  if (input.payerWallet) {
    await upsertWallet(db, input.payerWallet);
    await db.run(`UPDATE wallets SET queries_paid = queries_paid + 1 WHERE address = ?`, input.payerWallet);
  }
  return id;
}

export async function insertLedgerLines(
  db: Db,
  queryId: string,
  lines: { wallet: string; role: string; snippetId: string | null; amountMicros: number; status?: string }[],
): Promise<void> {
  const createdAt = nowIso();
  for (const line of lines) {
    const status = line.status ?? (line.role === "referral" ? "held" : "pending");
    await db.run(
      `INSERT INTO ledger_entries (id, query_id, snippet_id, wallet, role, amount_micros, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      newId(),
      queryId,
      line.snippetId,
      line.wallet,
      line.role,
      line.amountMicros,
      status,
      createdAt,
    );
  }
}

export type PendingPayout = {
  wallet: string;
  amountMicros: number;
  roles: string[];
  entryCount: number;
};

export async function pendingPayouts(db: Db): Promise<PendingPayout[]> {
  const rows = await db.all(
    `SELECT wallet, SUM(amount_micros) AS amount_micros, GROUP_CONCAT(DISTINCT role) AS roles, COUNT(*) AS entry_count
     FROM ledger_entries
     WHERE status = 'pending' AND wallet NOT IN ('platform', 'reserve', 'house', 'treasury')
     GROUP BY wallet
     ORDER BY amount_micros DESC`,
  );
  return rows.map((r) => ({
    wallet: String(r.wallet),
    amountMicros: Number(r.amount_micros),
    roles: String(r.roles).split(","),
    entryCount: Number(r.entry_count),
  }));
}

export async function ledgerSummary(db: Db): Promise<{
  pendingMicros: number;
  platformMicros: number;
  reserveMicros: number;
  treasuryMicros: number;
  entryCount: number;
}> {
  const row = (await db.get(
    `SELECT
       COALESCE(SUM(CASE WHEN wallet NOT IN ('platform','reserve','house','treasury') AND status='pending' THEN amount_micros END), 0) AS pending_micros,
       COALESCE(SUM(CASE WHEN wallet='platform' THEN amount_micros END), 0) AS platform_micros,
       COALESCE(SUM(CASE WHEN wallet='reserve' THEN amount_micros END), 0) AS reserve_micros,
       COALESCE(SUM(CASE WHEN wallet IN ('house','treasury') THEN amount_micros END), 0) AS treasury_micros,
       COUNT(*) AS entry_count
     FROM ledger_entries`,
  )) ?? {};
  return {
    pendingMicros: Number(row.pending_micros ?? 0),
    platformMicros: Number(row.platform_micros ?? 0),
    reserveMicros: Number(row.reserve_micros ?? 0),
    treasuryMicros: Number(row.treasury_micros ?? 0),
    entryCount: Number(row.entry_count ?? 0),
  };
}

export async function recordDryRun(db: Db, summary: unknown): Promise<string> {
  const id = newId();
  await db.run(
    `INSERT INTO payout_runs (id, mode, created_at, summary_json) VALUES (?, 'dry_run', ?, ?)`,
    id,
    nowIso(),
    JSON.stringify(summary, null, 2),
  );
  return id;
}

export async function findSettledPayment(
  db: Db,
  id: string,
): Promise<{ id: string; payerWallet: string | null; transactionSig: string | null } | null> {
  const row = await db.get(`SELECT * FROM settled_payments WHERE id = ?`, id);
  if (!row) return null;
  return {
    id: String(row.id),
    payerWallet: row.payer_wallet == null ? null : String(row.payer_wallet),
    transactionSig: row.transaction_sig == null ? null : String(row.transaction_sig),
  };
}

export async function recordSettledPayment(
  db: Db,
  input: { id: string; payerWallet: string | null; transactionSig: string | null },
): Promise<void> {
  await db.run(
    `INSERT OR IGNORE INTO settled_payments (id, payer_wallet, transaction_sig, created_at) VALUES (?, ?, ?, ?)`,
    input.id,
    input.payerWallet,
    input.transactionSig,
    nowIso(),
  );
}

export type LedgerEntryRow = {
  id: string;
  queryId: string;
  snippetId: string | null;
  wallet: string;
  role: string;
  amountMicros: number;
  status: string;
  createdAt: string;
  payoutTx: string | null;
  payoutRunId: string | null;
  paidAt: string | null;
};

function mapLedgerRow(row: Record<string, unknown>): LedgerEntryRow {
  return {
    id: String(row.id),
    queryId: String(row.query_id),
    snippetId: row.snippet_id == null ? null : String(row.snippet_id),
    wallet: String(row.wallet),
    role: String(row.role),
    amountMicros: Number(row.amount_micros),
    status: String(row.status),
    createdAt: String(row.created_at),
    payoutTx: row.payout_tx == null ? null : String(row.payout_tx),
    payoutRunId: row.payout_run_id == null ? null : String(row.payout_run_id),
    paidAt: row.paid_at == null ? null : String(row.paid_at),
  };
}

export async function listPendingLedgerEntries(db: Db): Promise<LedgerEntryRow[]> {
  const rows = await db.all(`SELECT * FROM ledger_entries WHERE status = 'pending' ORDER BY created_at ASC, id ASC`);
  return rows.map(mapLedgerRow);
}

export async function markLedgerEntries(
  db: Db,
  ids: string[],
  update: { status: string; payoutTx: string | null; payoutRunId: string; paidAt: string },
): Promise<number> {
  if (ids.length === 0) return 0;
  const unique = [...new Set(ids)];
  const placeholders = unique.map(() => "?").join(", ");
  // Count eligible rows first so a partial match cannot silently mark a mixed set.
  const eligible = await db.get(
    `SELECT COUNT(*) AS n FROM ledger_entries WHERE status = 'pending' AND id IN (${placeholders})`,
    ...unique,
  );
  const n = Number(eligible?.n ?? 0);
  if (n !== unique.length) {
    throw new Error(`ledger mark expected ${unique.length} pending rows, found ${n}`);
  }
  await db.run(
    `UPDATE ledger_entries
     SET status = ?, payout_tx = ?, payout_run_id = ?, paid_at = ?
     WHERE status = 'pending' AND id IN (${placeholders})`,
    update.status,
    update.payoutTx,
    update.payoutRunId,
    update.paidAt,
    ...unique,
  );
  return n;
}

export async function recordPayoutRun(
  db: Db,
  input: { id: string; mode: string; summary: unknown },
): Promise<void> {
  await db.run(
    `INSERT INTO payout_runs (id, mode, created_at, summary_json) VALUES (?, ?, ?, ?)`,
    input.id,
    input.mode,
    nowIso(),
    JSON.stringify(input.summary, null, 2),
  );
}
