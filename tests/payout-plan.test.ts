import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openMigratedDb } from "../src/sqlite.ts";
import { insertLedgerLines, listPendingLedgerEntries, markLedgerEntries, recordPayoutRun } from "../src/db.ts";
import { PLATFORM_WALLET, RESERVE_WALLET, TREASURY_WALLET } from "../src/payout.ts";
import {
  MIN_PAYOUT_MICROS,
  MIN_ATA_CREATE_MICROS,
  MAX_RUN_MICROS,
  MAX_RECIPIENT_MICROS,
  planPayouts,
  packRows,
  type PendingLedgerRow,
} from "../src/payout-plan.ts";

const OWNER = "7vUCMQL5U5RtyLskFrrW7L5i7YV4pTtqg72qG87BoxSB";
const AGENT_A = "BDkdaa5aHZZooaG2dRRMzBNe33PzTqZoZyQaBxVrdzi7";
const AGENT_B = "BtWTZbXWs9Zbpawja3NxC6Rj4E1HGPF8P6y1fvX9nXJx";
const MAIN_BAL = 30_000_000; // 30 USDC

function row(partial: Partial<PendingLedgerRow> & { id: string; wallet: string; amountMicros: number }): PendingLedgerRow {
  return {
    role: "submitter",
    status: "pending",
    createdAt: `2026-11-20T00:00:00.${partial.id.slice(-3)}Z`,
    ...partial,
  };
}

const baseOpts = { ownerAddress: OWNER, mainBalanceMicros: MAIN_BAL, existingAtas: new Set([OWNER, AGENT_A, AGENT_B]) };

describe("planPayouts", () => {
  it("marks treasury and reserve as internal settles and carries platform below $0.10", () => {
    const plan = planPayouts(
      [
        row({ id: "p1", wallet: PLATFORM_WALLET, role: "platform", amountMicros: 3_000 }),
        row({ id: "r1", wallet: RESERVE_WALLET, role: "reserve", amountMicros: 1_000 }),
        row({ id: "t1", wallet: TREASURY_WALLET, role: "house", amountMicros: 6_000 }),
      ],
      baseOpts,
    );
    expect(plan.transfers).toHaveLength(0);
    expect(plan.internals).toHaveLength(2);
    expect(plan.internals.find((i) => i.wallet === TREASURY_WALLET)?.amountMicros).toBe(6_000);
    expect(plan.internals.find((i) => i.wallet === RESERVE_WALLET)?.amountMicros).toBe(1_000);
    expect(plan.carries).toHaveLength(1);
    expect(plan.carries[0]!.recipient).toBe(OWNER);
    expect(plan.carries[0]!.amountMicros).toBe(3_000);
    expect(plan.carries[0]!.reason).toMatch(/0\.10 USDC minimum/);
  });

  it("pays the owner once platform accrual reaches the minimum", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      row({ id: `p${i}`, wallet: PLATFORM_WALLET, role: "platform", amountMicros: 3_000 }),
    );
    const plan = planPayouts(rows, baseOpts);
    expect(plan.transfers).toHaveLength(1);
    expect(plan.transfers[0]!.recipient).toBe(OWNER);
    expect(plan.transfers[0]!.source).toBe("platform");
    expect(plan.transfers[0]!.amountMicros).toBe(120_000);
    expect(plan.transfers[0]!.entryIds).toHaveLength(40);
    expect(plan.carries).toHaveLength(0);
  });

  it("pays a contributor at or above $0.10 and ignores already-paid rows", () => {
    const plan = planPayouts(
      [
        row({ id: "a1", wallet: AGENT_A, amountMicros: 150_000 }),
        row({ id: "a2", wallet: AGENT_A, amountMicros: 50_000, status: "paid" }),
      ],
      baseOpts,
    );
    expect(plan.transfers).toEqual([
      expect.objectContaining({ recipient: AGENT_A, amountMicros: 150_000, entryIds: ["a1"], needsAta: false }),
    ]);
  });

  it("carries amounts under 1 USDC when the recipient has no ATA", () => {
    const plan = planPayouts(
      [row({ id: "a1", wallet: AGENT_A, amountMicros: 150_000 })],
      { ...baseOpts, existingAtas: new Set() },
    );
    expect(plan.transfers).toHaveLength(0);
    expect(plan.carries[0]!.reason).toMatch(/no USDC token account/);
    expect(plan.carries[0]!.amountMicros).toBe(150_000);
  });

  it("creates an ATA when sending at least 1 USDC to a new recipient", () => {
    const plan = planPayouts(
      [row({ id: "a1", wallet: AGENT_A, amountMicros: MIN_ATA_CREATE_MICROS })],
      { ...baseOpts, existingAtas: new Set() },
    );
    expect(plan.transfers[0]!.needsAta).toBe(true);
    expect(plan.transfers[0]!.amountMicros).toBe(1_000_000);
  });

  it("caps one recipient at 5 USDC per run and carries the rest", () => {
    const rows = [
      row({ id: "a1", wallet: AGENT_A, amountMicros: 3_000_000, createdAt: "2026-11-20T00:00:01Z" }),
      row({ id: "a2", wallet: AGENT_A, amountMicros: 3_000_000, createdAt: "2026-11-20T00:00:02Z" }),
    ];
    const plan = planPayouts(rows, baseOpts);
    expect(plan.transfers[0]!.amountMicros).toBe(3_000_000);
    expect(plan.transfers[0]!.entryIds).toEqual(["a1"]);
    expect(plan.carries[0]!.amountMicros).toBe(3_000_000);
    expect(plan.carries[0]!.entryIds).toEqual(["a2"]);
  });

  it("caps the whole run at 25 USDC", () => {
    const wallets = [AGENT_A, AGENT_B, OWNER, "Gm3Ae1UTwJsLj5NKHhznJccYiGLMMdfJiZUJ39hLAsoH", "EAJiExxSG5K3G4nnqeCZd1DmWMaK6CmisXi53yYa5SJJ"];
    const rows = wallets.flatMap((w, i) => [
      row({ id: `w${i}a`, wallet: w, amountMicros: MAX_RECIPIENT_MICROS, createdAt: `2026-11-20T00:00:0${i}Z` }),
      row({ id: `w${i}b`, wallet: w, amountMicros: 1_000_000, createdAt: `2026-11-20T00:01:0${i}Z` }),
    ]);
    const plan = planPayouts(rows, {
      ...baseOpts,
      existingAtas: new Set(wallets),
      mainBalanceMicros: 100_000_000,
    });
    expect(plan.transferTotalMicros).toBe(MAX_RUN_MICROS);
    expect(plan.transfers).toHaveLength(5);
    expect(plan.transfers.every((t) => t.amountMicros === MAX_RECIPIENT_MICROS)).toBe(true);
    const carried = plan.carries.reduce((s, c) => s + c.amountMicros, 0);
    expect(carried).toBe(5_000_000);
  });

  it("does not send more than the main wallet balance", () => {
    const plan = planPayouts(
      [row({ id: "a1", wallet: AGENT_A, amountMicros: 5_000_000 })],
      { ...baseOpts, mainBalanceMicros: 200_000 },
    );
    expect(plan.transfers).toHaveLength(0);
    expect(plan.carries[0]!.reason).toMatch(/cap|later run/i);
  });

  it("does not split a single row that exceeds the per-recipient cap", () => {
    const plan = planPayouts(
      [row({ id: "a1", wallet: AGENT_A, amountMicros: MAX_RECIPIENT_MICROS + 1 })],
      baseOpts,
    );
    expect(plan.transfers).toHaveLength(0);
    expect(plan.carries[0]!.reason).toMatch(/exceeds the 5 USDC/);
  });
});

describe("packRows", () => {
  it("never splits a row and stays under the cap", () => {
    const { packed, leftover } = packRows(
      [
        row({ id: "1", wallet: AGENT_A, amountMicros: 80_000, createdAt: "t1" }),
        row({ id: "2", wallet: AGENT_A, amountMicros: 80_000, createdAt: "t2" }),
      ],
      100_000,
    );
    expect(packed.map((r) => r.id)).toEqual(["1"]);
    expect(leftover.map((r) => r.id)).toEqual(["2"]);
  });
});

describe("ledger marking", () => {
  it("marks pending rows once and refuses to mark them again", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "payout-plan-")), "t.sqlite");
    const db = await openMigratedDb(dbPath);
    await db.run(
      `INSERT INTO queries (id, payer_wallet, library, question, fee_micros, payment_mode, created_at)
       VALUES ('q1', null, 'react', 'useState', 10000, 'x402', '2026-11-20T00:00:00Z')`,
    );
    await insertLedgerLines(db, "q1", [
      { wallet: TREASURY_WALLET, role: "house", snippetId: "react-usestate", amountMicros: 6000 },
      { wallet: PLATFORM_WALLET, role: "platform", snippetId: null, amountMicros: 3000 },
      { wallet: RESERVE_WALLET, role: "reserve", snippetId: null, amountMicros: 1000 },
    ]);
    const pending = await listPendingLedgerEntries(db);
    expect(pending).toHaveLength(3);
    const runId = "run-1";
    await recordPayoutRun(db, { id: runId, mode: "live", summary: { ok: true } });
    const treasury = pending.filter((r) => r.wallet === TREASURY_WALLET || r.wallet === RESERVE_WALLET).map((r) => r.id);
    const n = await markLedgerEntries(db, treasury, {
      status: "settled_internal",
      payoutTx: null,
      payoutRunId: runId,
      paidAt: "2026-11-20T00:00:01Z",
    });
    expect(n).toBe(2);
    expect((await listPendingLedgerEntries(db)).map((r) => r.wallet)).toEqual([PLATFORM_WALLET]);
    await expect(
      markLedgerEntries(db, treasury, {
        status: "settled_internal",
        payoutTx: null,
        payoutRunId: runId,
        paidAt: "2026-11-20T00:00:02Z",
      }),
    ).rejects.toThrow(/expected 2 pending rows, found 0/);
  });
});
