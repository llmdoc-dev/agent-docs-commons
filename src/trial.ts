import { createHash } from "node:crypto";
import type { Db } from "./db.ts";

/** Unpaid GET lookups with a `q` parameter share this daily cap per client IP. */
export const FREE_LOOKUPS_PER_IP_PER_UTC_DAY = 5;

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function clientIp(req: Request): string {
  const cf = req.headers.get("CF-Connecting-IP") ?? req.headers.get("cf-connecting-ip");
  if (cf && cf.trim()) return cf.trim();
  const trueIp = req.headers.get("True-Client-IP") ?? req.headers.get("true-client-ip");
  if (trueIp && trueIp.trim()) return trueIp.trim();
  const forwarded = req.headers.get("X-Forwarded-For") ?? req.headers.get("x-forwarded-for");
  if (forwarded && forwarded.trim()) return forwarded.split(",")[0]!.trim();
  return "unknown";
}

/** Hash the IP so the database stores a daily identity key, not a raw address. */
export function trialIdentityKey(req: Request): { key: string; period: string; ipPresent: boolean } {
  const ip = clientIp(req);
  const digest = createHash("sha256").update(`llmdocs-trial:${ip}`).digest("hex");
  return { key: `ip:${digest}`, period: utcDay(), ipPresent: ip !== "unknown" };
}

export async function freeLookupsUsed(db: Db, key: string, period: string): Promise<number> {
  const row = await db.get(
    `SELECT count FROM free_lookup_usage WHERE identity_key = ? AND period = ?`,
    key,
    period,
  );
  return Number(row?.count ?? 0);
}

/**
 * Try to consume one free lookup for this IP and UTC day.
 * Returns remaining after a successful consume, or used==cap when denied.
 */
export async function consumeFreeLookup(
  db: Db,
  req: Request,
): Promise<{ ok: true; used: number; remaining: number } | { ok: false; used: number; remaining: 0 }> {
  const { key, period } = trialIdentityKey(req);
  const used = await freeLookupsUsed(db, key, period);
  if (used >= FREE_LOOKUPS_PER_IP_PER_UTC_DAY) {
    return { ok: false, used, remaining: 0 };
  }
  await db.run(
    `INSERT INTO free_lookup_usage (identity_key, period, count) VALUES (?, ?, 1)
     ON CONFLICT(identity_key, period) DO UPDATE SET count = count + 1
     WHERE count < ?`,
    key,
    period,
    FREE_LOOKUPS_PER_IP_PER_UTC_DAY,
  );
  const next = await freeLookupsUsed(db, key, period);
  if (next > used && next <= FREE_LOOKUPS_PER_IP_PER_UTC_DAY) {
    return { ok: true, used: next, remaining: FREE_LOOKUPS_PER_IP_PER_UTC_DAY - next };
  }
  return { ok: false, used: Math.max(used, next), remaining: 0 };
}

export const TRIAL_RULES_TEXT =
  "The first 5 unpaid GET /v1/docs/lookup requests that include a q parameter are free, counted per client IP per UTC day (using CF-Connecting-IP, then X-Forwarded-For). HEAD and the canonical lookup URL without q always return HTTP 402 so payment discovery probes keep working. After the daily quota, unpaid lookups return 402 as usual. Paid requests with a PAYMENT-SIGNATURE do not consume the trial.";
