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
CREATE INDEX IF NOT EXISTS idx_snippets_library ON snippets(library);
CREATE INDEX IF NOT EXISTS idx_ledger_wallet ON ledger_entries(wallet);
