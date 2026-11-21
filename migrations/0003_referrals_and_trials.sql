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
CREATE INDEX IF NOT EXISTS idx_referral_referrer ON referral_attributions(referrer_wallet);
