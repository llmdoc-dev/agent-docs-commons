import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { openMigratedDb } from "../src/sqlite.ts";
import { insertLedgerLines, recordPayoutRun, recordQuery } from "../src/db.ts";
import { buildStats, skippedWallet, statsContainsSensitiveKeys } from "../src/stats.ts";

describe("buildStats", () => {
  it("buckets Phoenix-local days, hides payer wallets, and reports zeros honestly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llmdocs-stats-"));
    const db = await openMigratedDb(join(dir, "t.sqlite"));
    const cfg = loadConfig({ port: 0, paymentMode: "mock", dbPath: join(dir, "t.sqlite"), publicBaseUrl: "http://127.0.0.1" });

    const empty = await buildStats(db, cfg, skippedWallet("test", "skipped_in_non_mainnet"));
    expect(empty.lookups.total).toBe(0);
    expect(empty.lookups.paid).toBe(0);
    expect(empty.lookups.free).toBe(0);
    expect(empty.lookups.revenueUsdc).toBe("0.000000");
    expect(empty.lookups.byDay).toEqual([]);
    expect(empty.referrals.claims).toBe(0);
    expect(empty.payouts.onchainSentUsdc).toBe("0.000000");
    expect(empty.timezone).toBe("America/Phoenix");
    expect(statsContainsSensitiveKeys(empty)).toBe(false);

    await recordQuery(db, {
      payerWallet: "3fNDHnonA7xWsvLFkMoBmvSMCwcfvgjvT9PNdP6hLtGr",
      library: "react",
      question: "useState",
      feeMicros: 10000,
      paymentMode: "x402",
      snippetIds: [],
      settlementTx: "FakeSettlementSig111111111111111111111111111111111111111111111",
    });
    const paid = await db.get(`SELECT id FROM queries`);
    await db.run(
      `UPDATE queries SET created_at = ? WHERE id = ?`,
      "2026-11-21T00:10:01.131Z",
      paid!.id,
    );
    await insertLedgerLines(db, String(paid!.id), [
      { wallet: "treasury", role: "house", snippetId: null, amountMicros: 6000 },
      { wallet: "platform", role: "platform", snippetId: null, amountMicros: 3000 },
      { wallet: "reserve", role: "reserve", snippetId: null, amountMicros: 1000 },
    ]);

    await db.run(
      `INSERT INTO queries (id, payer_wallet, library, question, fee_micros, payment_mode, settlement_tx, created_at)
       VALUES (?, NULL, 'stripe', 'PaymentIntent', 0, 'free', NULL, '2026-11-21T01:08:00.000Z')`,
      "free-1",
    );
    await db.run(
      `INSERT INTO free_lookup_usage (identity_key, period, count) VALUES (?, ?, ?)`,
      "ip:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "2026-11-21",
      1,
    );
    await recordPayoutRun(db, {
      id: "run-1",
      mode: "live",
      summary: {
        plan: { transferTotalUsd: "0.000000", transfers: [], internals: [{ amountUsd: "0.006000" }], carries: [{ amountUsd: "0.003000" }] },
        results: [],
      },
    });

    const stats = await buildStats(db, cfg, skippedWallet("test", "skipped_in_non_mainnet"));
    expect(stats.lookups.total).toBe(2);
    expect(stats.lookups.paid).toBe(1);
    expect(stats.lookups.free).toBe(1);
    expect(stats.lookups.uniquePayers).toBe(1);
    expect(stats.lookups.uniqueFreeIdentities).toBe(1);
    expect(stats.lookups.revenueUsdc).toBe("0.010000");
    expect(stats.lookups.ownerShareUsdc).toBe("0.003000");
    expect(stats.lookups.contributorShareUsdc).toBe("0.006000");
    expect(stats.lookups.reserveShareUsdc).toBe("0.001000");
    expect(stats.lookups.byDay).toEqual([
      { day: "2026-11-20", paid: 1, free: 1, revenueUsdc: "0.010000" },
    ]);
    expect(stats.lookups.topLibraries[0]).toEqual({ library: "react", total: 1, paid: 1, free: 0 });
    expect(stats.lookups.topQueries.some((q) => q.question === "useState" && q.paid === 1)).toBe(true);
    const owner = stats.ledger.buckets.find((b) => b.bucket === "owner");
    expect(owner?.pendingUsdc).toBe("0.003000");
    expect(stats.payouts.liveRuns).toBe(1);
    expect(stats.payouts.onchainSentUsdc).toBe("0.000000");
    expect(stats.payouts.runs[0]!.carriedUsdc).toBe("0.003000");
    expect(stats.payouts.runs[0]!.onchainTransfers).toEqual([]);
    expect(statsContainsSensitiveKeys(stats)).toBe(false);
    const json = JSON.stringify(stats);
    expect(json).not.toContain("3fNDHnonA7xWsvLFkMoBmvSMCwcfvgjvT9PNdP6hLtGr");
    expect(json).not.toContain("ip:fff");
    expect(json).not.toContain("FakeSettlementSig");
  });
});
