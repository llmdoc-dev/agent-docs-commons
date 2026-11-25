import { createHash } from "node:crypto";
import type { Db } from "./db.ts";

/** Unpaid GET lookups with a `q` parameter share this daily cap per client IP. */
export const FREE_LOOKUPS_PER_IP_PER_UTC_DAY = 5;
/** A client identity seen for the first time gets this larger cap for its first UTC day only. */
export const NEW_IDENTITY_FREE_LOOKUPS_FIRST_DAY = 20;
/**
 * Abuse guard: across all identities, at most this many first-day bonus lookups
 * (the ones above the normal 5) are granted per UTC day. Once used up, new
 * identities fall back to the normal 5/day for the rest of that day.
 */
export const NEW_IDENTITY_BONUS_GLOBAL_DAILY_CAP = 3000;
const BONUS_POOL_KEY = "global:new-identity-bonus";

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

/**
 * Group IPv6 clients by their /64 prefix, since one host usually controls a
 * whole /64 and could otherwise rotate addresses to reset the trial. IPv4
 * addresses are used as-is.
 */
export function trialIpBucket(ip: string): string {
  if (!ip.includes(":")) return ip;
  const zoneless = ip.split("%")[0]!.toLowerCase();
  const [head, tail = ""] = zoneless.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = zoneless.includes("::") ? Math.max(0, 8 - headParts.length - tailParts.length) : 0;
  const full = [...headParts, ...Array(missing).fill("0"), ...tailParts];
  const prefix = full.slice(0, 4).map((p) => (p || "0").replace(/^0+(?=.)/, ""));
  return `${prefix.join(":")}::/64`;
}

/** Hash the IP so the database stores an identity key, not a raw address. */
export function trialIdentityKey(req: Request): { key: string; period: string; ipPresent: boolean } {
  const ip = clientIp(req);
  const digest = createHash("sha256").update(`llmdocs-trial:${trialIpBucket(ip)}`).digest("hex");
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

/** True when this identity has no free-lookup usage on any earlier UTC day. */
export async function isFirstDayIdentity(db: Db, key: string, period: string): Promise<boolean> {
  const row = await db.get(
    `SELECT 1 AS seen FROM free_lookup_usage WHERE identity_key = ? AND period < ? LIMIT 1`,
    key,
    period,
  );
  return !row;
}

/** Daily cap for this identity: 20 on its first UTC day (while the global bonus pool lasts), else 5. */
export async function dailyFreeCap(
  db: Db,
  key: string,
  period: string,
  ipPresent: boolean,
): Promise<{ cap: number; firstDay: boolean }> {
  if (!ipPresent) return { cap: FREE_LOOKUPS_PER_IP_PER_UTC_DAY, firstDay: false };
  const firstDay = await isFirstDayIdentity(db, key, period);
  if (!firstDay) return { cap: FREE_LOOKUPS_PER_IP_PER_UTC_DAY, firstDay: false };
  return { cap: NEW_IDENTITY_FREE_LOOKUPS_FIRST_DAY, firstDay: true };
}

async function incrementBounded(db: Db, key: string, period: string, cap: number): Promise<boolean> {
  const before = await freeLookupsUsed(db, key, period);
  if (before >= cap) return false;
  await db.run(
    `INSERT INTO free_lookup_usage (identity_key, period, count) VALUES (?, ?, 1)
     ON CONFLICT(identity_key, period) DO UPDATE SET count = count + 1
     WHERE count < ?`,
    key,
    period,
    cap,
  );
  const after = await freeLookupsUsed(db, key, period);
  return after > before && after <= cap;
}

/**
 * Try to consume one free lookup for this client identity and UTC day.
 * Returns remaining after a successful consume, or used==cap when denied.
 */
export async function consumeFreeLookup(
  db: Db,
  req: Request,
): Promise<
  | { ok: true; used: number; remaining: number; cap: number; firstDay: boolean }
  | { ok: false; used: number; remaining: 0; cap: number; firstDay: boolean }
> {
  const { key, period, ipPresent } = trialIdentityKey(req);
  const { cap, firstDay } = await dailyFreeCap(db, key, period, ipPresent);
  const used = await freeLookupsUsed(db, key, period);
  if (used >= cap) {
    return { ok: false, used, remaining: 0, cap, firstDay };
  }
  // Lookups above the normal daily 5 draw from a global first-day bonus pool.
  if (used >= FREE_LOOKUPS_PER_IP_PER_UTC_DAY) {
    const granted = await incrementBounded(db, BONUS_POOL_KEY, period, NEW_IDENTITY_BONUS_GLOBAL_DAILY_CAP);
    if (!granted) {
      return { ok: false, used, remaining: 0, cap: FREE_LOOKUPS_PER_IP_PER_UTC_DAY, firstDay };
    }
  }
  const ok = await incrementBounded(db, key, period, cap);
  const next = await freeLookupsUsed(db, key, period);
  if (ok) {
    return { ok: true, used: next, remaining: cap - next, cap, firstDay };
  }
  return { ok: false, used: Math.max(used, next), remaining: 0, cap, firstDay };
}

export const TRIAL_SHORT_TEXT =
  "Free trial: 20 unpaid lookups on a client's first UTC day, then 5 per UTC day (per hashed client IP). Then $0.01 via x402 (USDC, PYUSD, or USDT on Solana).";

export const TRIAL_RULES_TEXT =
  "Free trial: a client seen for the first time gets 20 unpaid GET /v1/docs/lookup requests (with a q parameter) on its first UTC day; after that it is 5 per UTC day. Clients are counted per hashed IP (CF-Connecting-IP, then X-Forwarded-For; IPv6 grouped by /64). First-day bonus lookups come from a shared daily pool, and when it runs out new clients get the normal 5. HEAD and the canonical lookup URL without q always return HTTP 402 so payment discovery probes keep working. After the daily quota, unpaid lookups return 402 as usual. The same cap and price also apply to GET /v1/check/preflight, /v1/check/status, /v1/check/pricing, and /v1/check/package (and the matching MCP tools). Paid requests with a PAYMENT-SIGNATURE do not consume the trial.";
