import {
  PLATFORM_WALLET,
  RESERVE_WALLET,
  TREASURY_WALLET,
  HOUSE_WALLET,
  isInternalWallet,
} from "./payout.ts";
import { isSolanaAddress } from "./quality.ts";

/** Minimum accrued USDC that will trigger an on-chain transfer. */
export const MIN_PAYOUT_MICROS = 100_000; // 0.10 USDC
/** Create a recipient ATA only when sending at least this much. */
export const MIN_ATA_CREATE_MICROS = 1_000_000; // 1 USDC
/** Hard cap on total USDC sent in one run. */
export const MAX_RUN_MICROS = 25_000_000; // 25 USDC
/** Hard cap on USDC sent to one recipient in one run. */
export const MAX_RECIPIENT_MICROS = 5_000_000; // 5 USDC

export const INTERNAL_SETTLE_WALLETS = new Set([TREASURY_WALLET, RESERVE_WALLET, HOUSE_WALLET]);

export type PendingLedgerRow = {
  id: string;
  wallet: string;
  role: string;
  amountMicros: number;
  status: string;
  createdAt?: string;
};

export type PayoutTransfer = {
  kind: "transfer";
  recipient: string;
  amountMicros: number;
  entryIds: string[];
  needsAta: boolean;
  source: "platform" | "contributor";
};

export type PayoutInternal = {
  kind: "internal";
  wallet: string;
  amountMicros: number;
  entryIds: string[];
  reason: string;
};

export type PayoutCarry = {
  kind: "carry";
  recipient: string;
  amountMicros: number;
  entryIds: string[];
  reason: string;
};

export type PayoutPlan = {
  transfers: PayoutTransfer[];
  internals: PayoutInternal[];
  carries: PayoutCarry[];
  transferTotalMicros: number;
};

export type PlanOptions = {
  ownerAddress: string;
  mainBalanceMicros: number;
  /** Recipients that already have a USDC associated token account. */
  existingAtas: Set<string>;
};

function sortRows(rows: PendingLedgerRow[]): PendingLedgerRow[] {
  return [...rows].sort((a, b) => String(a.createdAt ?? a.id).localeCompare(String(b.createdAt ?? b.id)));
}

/** Pack whole rows up to a cap, never splitting a row. */
export function packRows(rows: PendingLedgerRow[], capMicros: number): { packed: PendingLedgerRow[]; leftover: PendingLedgerRow[] } {
  const packed: PendingLedgerRow[] = [];
  const leftover: PendingLedgerRow[] = [];
  let sum = 0;
  for (const row of sortRows(rows)) {
    if (row.amountMicros > capMicros || sum + row.amountMicros > capMicros) {
      leftover.push(row);
      continue;
    }
    packed.push(row);
    sum += row.amountMicros;
  }
  return { packed, leftover };
}

function sumRows(rows: PendingLedgerRow[]): number {
  return rows.reduce((s, r) => s + r.amountMicros, 0);
}

/**
 * Build an idempotent payout plan from pending ledger rows.
 * Platform share is paid to the owner's Phantom. Treasury, reserve, and house
 * shares stay in the main wallet and are marked settled internally.
 * Only pending rows are considered. Transfers use whole rows only.
 */
export function planPayouts(rows: PendingLedgerRow[], opts: PlanOptions): PayoutPlan {
  const pending = rows.filter((r) => r.status === "pending" && r.amountMicros > 0);
  const internals: PayoutInternal[] = [];
  const carries: PayoutCarry[] = [];
  const transfers: PayoutTransfer[] = [];

  const internalGroups = new Map<string, PendingLedgerRow[]>();
  const payable = new Map<string, { source: "platform" | "contributor"; rows: PendingLedgerRow[] }>();

  for (const row of pending) {
    if (INTERNAL_SETTLE_WALLETS.has(row.wallet) || row.role === "house") {
      const key = INTERNAL_SETTLE_WALLETS.has(row.wallet) ? row.wallet : TREASURY_WALLET;
      const list = internalGroups.get(key) ?? [];
      list.push(row);
      internalGroups.set(key, list);
      continue;
    }
    if (row.wallet === PLATFORM_WALLET || row.role === "platform") {
      const group = payable.get(opts.ownerAddress) ?? { source: "platform", rows: [] };
      group.rows.push(row);
      payable.set(opts.ownerAddress, group);
      continue;
    }
    if (isInternalWallet(row.wallet) || !isSolanaAddress(row.wallet)) {
      carries.push({
        kind: "carry",
        recipient: row.wallet,
        amountMicros: row.amountMicros,
        entryIds: [row.id],
        reason: "not a payable Solana address",
      });
      continue;
    }
    const group = payable.get(row.wallet) ?? { source: "contributor", rows: [] };
    group.rows.push(row);
    payable.set(row.wallet, group);
  }

  for (const [wallet, groupRows] of internalGroups) {
    internals.push({
      kind: "internal",
      wallet,
      amountMicros: sumRows(groupRows),
      entryIds: groupRows.map((r) => r.id),
      reason: "house-owned contributor share and reserve stay in the main wallet",
    });
  }

  let remainingRun = Math.min(MAX_RUN_MICROS, Math.max(0, opts.mainBalanceMicros));

  // Pay larger accrued balances first so we don't spend the run cap on dust packing.
  const recipients = [...payable.entries()].sort((a, b) => sumRows(b[1].rows) - sumRows(a[1].rows));

  for (const [recipient, group] of recipients) {
    if (!isSolanaAddress(recipient)) {
      carries.push({
        kind: "carry",
        recipient,
        amountMicros: sumRows(group.rows),
        entryIds: group.rows.map((r) => r.id),
        reason: "owner payout address is not a valid Solana address",
      });
      continue;
    }
    const cap = Math.min(MAX_RECIPIENT_MICROS, remainingRun);
    const { packed, leftover } = packRows(group.rows, cap);
    const packedSum = sumRows(packed);

    if (leftover.length > 0) {
      carries.push({
        kind: "carry",
        recipient,
        amountMicros: sumRows(leftover),
        entryIds: leftover.map((r) => r.id),
        reason:
          leftover.some((r) => r.amountMicros > MAX_RECIPIENT_MICROS)
            ? "single ledger row exceeds the 5 USDC per-recipient cap; not split"
            : "held for a later run (per-recipient or per-run cap)",
      });
    }

    if (packed.length === 0) {
      continue;
    }
    if (packedSum < MIN_PAYOUT_MICROS) {
      carries.push({
        kind: "carry",
        recipient,
        amountMicros: packedSum,
        entryIds: packed.map((r) => r.id),
        reason: "below the 0.10 USDC minimum; carried forward",
      });
      continue;
    }

    const hasAta = opts.existingAtas.has(recipient);
    if (!hasAta && packedSum < MIN_ATA_CREATE_MICROS) {
      carries.push({
        kind: "carry",
        recipient,
        amountMicros: packedSum,
        entryIds: packed.map((r) => r.id),
        reason: "no USDC token account, and amount is under 1 USDC so one will not be created",
      });
      continue;
    }

    transfers.push({
      kind: "transfer",
      recipient,
      amountMicros: packedSum,
      entryIds: packed.map((r) => r.id),
      needsAta: !hasAta,
      source: group.source,
    });
    remainingRun -= packedSum;
  }

  return {
    transfers,
    internals,
    carries,
    transferTotalMicros: transfers.reduce((s, t) => s + t.amountMicros, 0),
  };
}
