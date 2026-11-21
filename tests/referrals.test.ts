import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig, MAINNET_PAY_TO } from "../src/config.ts";
import { listPendingLedgerEntries } from "../src/db.ts";
import { openMigratedDb } from "../src/sqlite.ts";
import { createApp, type App } from "../src/app.ts";
import { formatUsd, usdToMicros } from "../src/money.ts";
import { BACKUP_WALLET_ADDRESS, REFERRAL_CAP_MICROS, REFERRAL_HOLD_MS, unlockHeldReferralLines } from "../src/referrals.ts";

const REFERRER = "BDkdaa5aHZZooaG2dRRMzBNe33PzTqZoZyQaBxVrdzi7";
const PAYER = "3fNDHnonA7xWsvLFkMoBmvSMCwcfvgjvT9PNdP6hLtGr";
const PAYER_2 = "BtWTZbXWs9Zbpawja3NxC6Rj4E1HGPF8P6y1fvX9nXJx";
const OTHER_REF = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

let app: App;
let dbPath = "";

async function http(path: string, init: RequestInit = {}) {
  const res = await app.handle(new Request(`http://127.0.0.1${path}`, init));
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* raw */
  }
  return { status: res.status, body, headers: res.headers };
}

function paidLookup(payer: string, extra: Record<string, string> = {}, query = "library=react&q=useState") {
  return http(`/v1/docs/lookup?${query}`, {
    headers: { "X-PAYMENT": `mock:${payer}`, ...extra },
  });
}

beforeAll(async () => {
  dbPath = join(mkdtempSync(join(tmpdir(), "docs-referrals-")), "t.sqlite");
  const cfg = loadConfig({
    port: 0,
    paymentMode: "mock",
    dbPath,
    publicBaseUrl: "http://127.0.0.1",
  });
  const db = await openMigratedDb(dbPath);
  app = await createApp(cfg, db);
});

describe("referral program", () => {
  it("claims a first-touch referrer and splits a paid lookup 60/10/20/10", async () => {
    const claim = await http("/v1/referrals/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payerWallet: PAYER, referrerWallet: REFERRER }),
    });
    expect(claim.status).toBe(201);

    const again = await http("/v1/referrals/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payerWallet: PAYER, referrerWallet: REFERRER }),
    });
    expect(again.status).toBe(200);

    const conflict = await http("/v1/referrals/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payerWallet: PAYER, referrerWallet: OTHER_REF }),
    });
    expect(conflict.status).toBe(409);

    const lookup = await paidLookup(PAYER, { "X-Llmdocs-Ref": OTHER_REF });
    expect(lookup.status).toBe(200);
    const lines = (lookup.body as { payout: { lines: Array<{ wallet: string; role: string; amountUsd: string }> } }).payout.lines;
    const byRole = Object.fromEntries(lines.map((l) => [l.role, l]));
    expect(byRole.platform.amountUsd).toBe(formatUsd(usdToMicros(0.002)));
    expect(byRole.reserve.amountUsd).toBe(formatUsd(usdToMicros(0.001)));
    expect(byRole.referral.wallet).toBe(REFERRER);
    expect(byRole.referral.amountUsd).toBe(formatUsd(usdToMicros(0.001)));
    expect(byRole.house.amountUsd).toBe(formatUsd(usdToMicros(0.006)));
    expect((lookup.body as { payout: { split: string } }).payout.split).toMatch(/10% referrer/);

    const db = await openMigratedDb(dbPath);
    const referral = await db.get(`SELECT * FROM ledger_entries WHERE role = 'referral' AND wallet = ?`, REFERRER);
    expect(referral?.status).toBe("held");
    expect(Number(referral?.amount_micros)).toBe(1_000);
    expect(String(referral?.wallet)).toBe(REFERRER);
  });

  it("ignores self-referral and platform wallets without failing the lookup", async () => {
    const selfClaim = await http("/v1/referrals/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payerWallet: PAYER_2, referrerWallet: PAYER_2 }),
    });
    expect(selfClaim.status).toBe(400);

    const self = await paidLookup(PAYER_2, {}, `library=react&q=useState&ref=${PAYER_2}`);
    expect(self.status).toBe(200);
    const selfLines = (self.body as { payout: { lines: Array<{ role: string; amountUsd: string }> } }).payout.lines;
    expect(selfLines.some((l) => l.role === "referral")).toBe(false);
    expect(selfLines.find((l) => l.role === "platform")?.amountUsd).toBe(formatUsd(usdToMicros(0.003)));

    const blocked = await paidLookup(PAYER_2, { "X-Llmdocs-Ref": MAINNET_PAY_TO });
    expect(blocked.status).toBe(200);
    expect((blocked.body as { payout: { lines: Array<{ role: string }> } }).payout.lines.some((l) => l.role === "referral")).toBe(false);

    const backup = await http("/v1/referrals/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payerWallet: "7vUCMQL5U5RtyLskFrrW7L5i7YV4pTtqg72qG87BoxSB", referrerWallet: BACKUP_WALLET_ADDRESS }),
    });
    expect(backup.status).toBe(400);
    // PAYER_2 already paid without a referrer, so a later ref cannot attach.
    const late = await paidLookup(PAYER_2, { "X-Llmdocs-Ref": REFERRER });
    expect((late.body as { payout: { lines: Array<{ role: string }> } }).payout.lines.some((l) => l.role === "referral")).toBe(false);
  });

  it("holds rewards until $0.10 spend and a 7-day wait, then marks them pending", async () => {
    const db = await openMigratedDb(dbPath);
    // One paid lookup so far for PAYER ($0.01). Unlock should do nothing.
    expect(await unlockHeldReferralLines(db)).toBe(0);
    const stillHeld = (await listPendingLedgerEntries(db)).filter((r) => r.role === "referral");
    expect(stillHeld).toHaveLength(0);

    // Nine more paid lookups reach the $0.10 unlock threshold, but the hold has not elapsed.
    for (let i = 0; i < 9; i++) {
      const res = await paidLookup(PAYER);
      expect(res.status).toBe(200);
      expect((res.body as { payout: { lines: Array<{ role: string }> } }).payout.lines.some((l) => l.role === "referral")).toBe(true);
    }
    expect(await unlockHeldReferralLines(db, new Date())).toBe(0);

    const heldRows = await db.all(`SELECT id, created_at, amount_micros FROM ledger_entries WHERE role = 'referral' AND status = 'held'`);
    expect(heldRows.length).toBe(10);
    const old = new Date(Date.now() - REFERRAL_HOLD_MS - 60_000).toISOString();
    for (const row of heldRows) {
      await db.run(`UPDATE ledger_entries SET created_at = ? WHERE id = ?`, old, String(row.id));
    }
    // Spend is unlocked now, but spend_unlocked_at was set at lookup 10, which is recent.
    expect(await unlockHeldReferralLines(db, new Date())).toBe(0);
    await db.run(`UPDATE referral_attributions SET spend_unlocked_at = ? WHERE payer_wallet = ?`, old, PAYER);
    expect(await unlockHeldReferralLines(db, new Date())).toBe(10);
    const pending = (await listPendingLedgerEntries(db)).filter((r) => r.role === "referral");
    expect(pending).toHaveLength(10);
    expect(pending.reduce((s, r) => s + r.amountMicros, 0)).toBe(10_000);
    // Idempotent.
    expect(await unlockHeldReferralLines(db, new Date())).toBe(0);
  });

  it("stops referring after the $10 cap and reports balances", async () => {
    const db = await openMigratedDb(dbPath);
    await db.run(`UPDATE referral_attributions SET earned_micros = ? WHERE payer_wallet = ?`, REFERRAL_CAP_MICROS - 500, PAYER);
    const partial = await paidLookup(PAYER);
    expect(partial.status).toBe(200);
    const partialLines = (partial.body as { payout: { lines: Array<{ role: string; amountUsd: string }> } }).payout.lines;
    expect(partialLines.find((l) => l.role === "referral")?.amountUsd).toBe(formatUsd(500));
    expect(partialLines.find((l) => l.role === "platform")?.amountUsd).toBe(formatUsd(usdToMicros(0.002) + 500));

    const capped = await paidLookup(PAYER);
    expect(capped.status).toBe(200);
    const cappedLines = (capped.body as { payout: { lines: Array<{ role: string; amountUsd: string }> } }).payout.lines;
    expect(cappedLines.some((l) => l.role === "referral")).toBe(false);
    expect(cappedLines.find((l) => l.role === "platform")?.amountUsd).toBe(formatUsd(usdToMicros(0.003)));

    const status = await http(`/v1/referrals?wallet=${REFERRER}`);
    expect(status.status).toBe(200);
    const body = status.body as { referredAgents: Array<{ payerWallet: string }>; balances: { heldUsd: string; pendingUsd: string } };
    expect(body.referredAgents.some((a) => a.payerWallet === PAYER)).toBe(true);
    expect(Number(body.balances.pendingUsd)).toBeGreaterThan(0);
  });
});
