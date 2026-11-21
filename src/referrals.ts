import { MAINNET_PAY_TO, DEFAULT_PAY_TO } from "./config.ts";
import type { Db } from "./db.ts";
import { isSolanaAddress } from "./quality.ts";
import { isInternalWallet } from "./payout.ts";

/** 10% of a referred paid lookup, taken from the owner's 30% share. */
export const REFERRER_BPS = 1000;
/** Owner share while a referral window is active. */
export const PLATFORM_REFERRED_BPS = 2000;
/** Accrue referral rewards for this many days after the first attributed payment. */
export const REFERRAL_WINDOW_DAYS = 180;
/** Maximum earned from one referred payer (atomic USDC). $10.00 */
export const REFERRAL_CAP_MICROS = 10_000_000;
/** Referred payer must spend this much before rewards can unlock. $0.10 */
export const REFERRAL_UNLOCK_SPEND_MICROS = 100_000;
/** Hold after both the line exists and spend has unlocked. */
export const REFERRAL_HOLD_MS = 7 * 24 * 60 * 60 * 1000;

/** Public site wallets that must never be recorded as referrers. */
export const BACKUP_WALLET_ADDRESS = "5qP4XpDyN2bnum8a4EHcT1Zj1xQyhmrLEGpv6fq3iVuJ";

export const BLOCKED_REFERRER_ADDRESSES = new Set([
  MAINNET_PAY_TO,
  DEFAULT_PAY_TO,
  BACKUP_WALLET_ADDRESS,
]);

export type ReferralAttribution = {
  payerWallet: string;
  referrerWallet: string;
  claimedAt: string;
  firstPaidAt: string | null;
  windowEndsAt: string | null;
  spendUnlockedAt: string | null;
  earnedMicros: number;
  source: "claim" | "lookup";
};

export function addDaysIso(iso: string, days: number): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error("invalid timestamp");
  return new Date(ms + days * 24 * 60 * 60 * 1000).toISOString();
}

export function parseReferrer(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!isSolanaAddress(value)) return null;
  if (isInternalWallet(value) || BLOCKED_REFERRER_ADDRESSES.has(value)) return null;
  return value;
}

export function readOfferedReferrer(req: Request, url: URL): string | null {
  return parseReferrer(url.searchParams.get("ref") ?? req.headers.get("X-Llmdocs-Ref") ?? req.headers.get("x-llmdocs-ref"));
}

export function isSelfReferral(payerWallet: string | null | undefined, referrerWallet: string): boolean {
  return Boolean(payerWallet && payerWallet === referrerWallet);
}

export async function getAttribution(db: Db, payerWallet: string): Promise<ReferralAttribution | null> {
  const row = await db.get(`SELECT * FROM referral_attributions WHERE payer_wallet = ?`, payerWallet);
  if (!row) return null;
  return mapAttribution(row);
}

export async function listAttributionsForReferrer(db: Db, referrerWallet: string): Promise<ReferralAttribution[]> {
  const rows = await db.all(
    `SELECT * FROM referral_attributions WHERE referrer_wallet = ? ORDER BY claimed_at ASC`,
    referrerWallet,
  );
  return rows.map(mapAttribution);
}

function mapAttribution(row: Record<string, unknown>): ReferralAttribution {
  return {
    payerWallet: String(row.payer_wallet),
    referrerWallet: String(row.referrer_wallet),
    claimedAt: String(row.claimed_at),
    firstPaidAt: row.first_paid_at == null ? null : String(row.first_paid_at),
    windowEndsAt: row.window_ends_at == null ? null : String(row.window_ends_at),
    spendUnlockedAt: row.spend_unlocked_at == null ? null : String(row.spend_unlocked_at),
    earnedMicros: Number(row.earned_micros ?? 0),
    source: String(row.source) === "lookup" ? "lookup" : "claim",
  };
}

export async function paidSpendMicros(db: Db, payerWallet: string): Promise<number> {
  const row = await db.get(
    `SELECT COALESCE(SUM(fee_micros), 0) AS n
     FROM queries
     WHERE payer_wallet = ? AND payment_mode != 'free' AND fee_micros > 0`,
    payerWallet,
  );
  return Number(row?.n ?? 0);
}

export type ClaimResult =
  | { ok: true; attribution: ReferralAttribution; created: boolean }
  | { ok: false; error: string; status: 400 | 409 };

/**
 * Bind a first-touch referrer before any paid lookup. Fails if the payer already
 * paid or already has a different referrer. Claiming the same pair again is idempotent.
 */
export async function claimReferral(
  db: Db,
  input: { payerWallet: string; referrerWallet: string; now?: Date },
): Promise<ClaimResult> {
  const payer = parseReferrer(input.payerWallet);
  const referrer = parseReferrer(input.referrerWallet);
  if (!isSolanaAddress((input.payerWallet ?? "").trim())) {
    return { ok: false, status: 400, error: "payerWallet must be a Solana address" };
  }
  if (!referrer) {
    return { ok: false, status: 400, error: "referrerWallet is missing or is not an allowed referrer" };
  }
  const payerWallet = (input.payerWallet ?? "").trim();
  if (isSelfReferral(payerWallet, referrer) || payer === referrer) {
    return { ok: false, status: 400, error: "self_referral" };
  }
  const existing = await getAttribution(db, payerWallet);
  if (existing) {
    if (existing.referrerWallet === referrer) return { ok: true, attribution: existing, created: false };
    return { ok: false, status: 409, error: "already_attributed" };
  }
  if ((await paidSpendMicros(db, payerWallet)) > 0) {
    return { ok: false, status: 409, error: "payer_already_paid" };
  }
  const claimedAt = (input.now ?? new Date()).toISOString();
  await db.run(
    `INSERT INTO referral_attributions (
       payer_wallet, referrer_wallet, claimed_at, first_paid_at, window_ends_at,
       spend_unlocked_at, earned_micros, source
     ) VALUES (?, ?, ?, NULL, NULL, NULL, 0, 'claim')`,
    payerWallet,
    referrer,
    claimedAt,
  );
  const saved = await getAttribution(db, payerWallet);
  if (!saved) return { ok: false, status: 400, error: "claim_failed" };
  return { ok: true, attribution: saved, created: true };
}

/**
 * First-touch bind on a first paid lookup. Invalid, self, or late refs are ignored.
 */
export async function bindReferrerOnFirstPaidLookup(
  db: Db,
  input: { payerWallet: string | null; offeredReferrer: string | null; now?: Date },
): Promise<ReferralAttribution | null> {
  const payer = input.payerWallet?.trim() || null;
  if (!payer || !isSolanaAddress(payer)) return null;
  const existing = await getAttribution(db, payer);
  if (existing) return existing;
  const referrer = parseReferrer(input.offeredReferrer);
  if (!referrer || isSelfReferral(payer, referrer)) return null;
  if ((await paidSpendMicros(db, payer)) > 0) return null;
  const claimedAt = (input.now ?? new Date()).toISOString();
  await db.run(
    `INSERT OR IGNORE INTO referral_attributions (
       payer_wallet, referrer_wallet, claimed_at, first_paid_at, window_ends_at,
       spend_unlocked_at, earned_micros, source
     ) VALUES (?, ?, ?, NULL, NULL, NULL, 0, 'lookup')`,
    payer,
    referrer,
    claimedAt,
  );
  return getAttribution(db, payer);
}

export function referralWindowActive(attr: ReferralAttribution, now: Date): boolean {
  if (!attr.firstPaidAt || !attr.windowEndsAt) return true; // window starts at first payment; still open until set and expired
  return now.toISOString() < attr.windowEndsAt;
}

export function referralAmountMicros(feeMicros: number, remainingCapMicros: number): number {
  const raw = Math.floor((feeMicros * REFERRER_BPS) / 10_000);
  return Math.min(raw, Math.max(0, remainingCapMicros));
}

export async function markFirstPaidAndAccrual(
  db: Db,
  input: {
    payerWallet: string;
    amountMicros: number;
    now?: Date;
  },
): Promise<ReferralAttribution | null> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const attr = await getAttribution(db, input.payerWallet);
  if (!attr) return null;
  let firstPaidAt = attr.firstPaidAt;
  let windowEndsAt = attr.windowEndsAt;
  if (!firstPaidAt) {
    firstPaidAt = nowIso;
    windowEndsAt = addDaysIso(firstPaidAt, REFERRAL_WINDOW_DAYS);
    await db.run(
      `UPDATE referral_attributions SET first_paid_at = ?, window_ends_at = ? WHERE payer_wallet = ? AND first_paid_at IS NULL`,
      firstPaidAt,
      windowEndsAt,
      input.payerWallet,
    );
  }
  if (input.amountMicros > 0) {
    await db.run(
      `UPDATE referral_attributions SET earned_micros = earned_micros + ? WHERE payer_wallet = ?`,
      input.amountMicros,
      input.payerWallet,
    );
  }
  const spend = await paidSpendMicros(db, input.payerWallet);
  if (spend >= REFERRAL_UNLOCK_SPEND_MICROS) {
    await db.run(
      `UPDATE referral_attributions SET spend_unlocked_at = ? WHERE payer_wallet = ? AND spend_unlocked_at IS NULL`,
      nowIso,
      input.payerWallet,
    );
  }
  return getAttribution(db, input.payerWallet);
}

/** Flip eligible held referral lines to pending. Idempotent. */
export async function unlockHeldReferralLines(db: Db, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - REFERRAL_HOLD_MS).toISOString();
  const rows = await db.all(
    `SELECT le.id AS id
     FROM ledger_entries le
     JOIN queries q ON q.id = le.query_id
     JOIN referral_attributions ra
       ON ra.payer_wallet = q.payer_wallet AND ra.referrer_wallet = le.wallet
     WHERE le.status = 'held' AND le.role = 'referral'
       AND ra.spend_unlocked_at IS NOT NULL
       AND le.created_at <= ?
       AND ra.spend_unlocked_at <= ?`,
    cutoff,
    cutoff,
  );
  const ids = rows.map((r) => String(r.id));
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(", ");
  await db.run(
    `UPDATE ledger_entries SET status = 'pending' WHERE status = 'held' AND role = 'referral' AND id IN (${placeholders})`,
    ...ids,
  );
  return ids.length;
}

export const UNLOCK_HELD_REFERRAL_SQL = (cutoffIso: string): string => {
  const safe = cutoffIso.replaceAll("'", "''");
  return `UPDATE ledger_entries
SET status = 'pending'
WHERE status = 'held' AND role = 'referral' AND id IN (
  SELECT le.id
  FROM ledger_entries le
  JOIN queries q ON q.id = le.query_id
  JOIN referral_attributions ra
    ON ra.payer_wallet = q.payer_wallet AND ra.referrer_wallet = le.wallet
  WHERE le.status = 'held' AND le.role = 'referral'
    AND ra.spend_unlocked_at IS NOT NULL
    AND le.created_at <= '${safe}'
    AND ra.spend_unlocked_at <= '${safe}'
)`;
};

export async function referralBalances(db: Db, wallet: string): Promise<{
  heldMicros: number;
  pendingMicros: number;
  paidMicros: number;
}> {
  const row =
    (await db.get(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'held' THEN amount_micros END), 0) AS held_micros,
         COALESCE(SUM(CASE WHEN status = 'pending' THEN amount_micros END), 0) AS pending_micros,
         COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_micros END), 0) AS paid_micros
       FROM ledger_entries
       WHERE wallet = ? AND role = 'referral'`,
      wallet,
    )) ?? {};
  return {
    heldMicros: Number(row.held_micros ?? 0),
    pendingMicros: Number(row.pending_micros ?? 0),
    paidMicros: Number(row.paid_micros ?? 0),
  };
}
