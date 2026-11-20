import { usdToMicros } from "./money.ts";

export const CONTRIBUTOR_POOL_BPS = 6000; // 60%
export const PLATFORM_BPS = 3000; // 30%
export const RESERVE_BPS = 1000; // 10%
export const SUBMITTER_BPS = 7000; // 70% of a fact slice
export const VERIFIER_BPS = 3000; // 30% of a fact slice
export const PLATFORM_WALLET = "platform";
export const RESERVE_WALLET = "reserve";

export type FactForPayout = {
  snippetId: string;
  submitterWallet: string;
  verifierWallets: string[];
};

export type LedgerLine = {
  wallet: string;
  role: "submitter" | "verifier" | "platform" | "reserve";
  snippetId: string | null;
  amountMicros: number;
};

function bps(amount: number, basisPoints: number): number {
  return Math.floor((amount * basisPoints) / 10_000);
}

/**
 * Split a query fee across the accepted facts used in the answer.
 * Platform-ingested facts (submitter === "platform") keep their pool slice on the platform.
 * Remainder micros after integer division go to the reserve so the lines sum to the fee.
 */
export function splitQueryFee(feeUsd: number, facts: FactForPayout[]): LedgerLine[] {
  if (feeUsd <= 0) throw new Error("fee must be positive");
  const fee = usdToMicros(feeUsd);
  const lines: LedgerLine[] = [];

  const platformFixed = bps(fee, PLATFORM_BPS);
  const reserveFixed = bps(fee, RESERVE_BPS);
  const pool = fee - platformFixed - reserveFixed;

  lines.push({
    wallet: PLATFORM_WALLET,
    role: "platform",
    snippetId: null,
    amountMicros: platformFixed,
  });
  lines.push({
    wallet: RESERVE_WALLET,
    role: "reserve",
    snippetId: null,
    amountMicros: reserveFixed,
  });

  if (facts.length === 0) {
    // No attributed facts: the whole contributor pool stays with the platform.
    lines[0]!.amountMicros += pool;
    return lines;
  }

  const baseSlice = Math.floor(pool / facts.length);
  let leftover = pool - baseSlice * facts.length;

  for (const fact of facts) {
    let slice = baseSlice;
    if (leftover > 0) {
      slice += 1;
      leftover -= 1;
    }
    const isPlatformOwned =
      fact.submitterWallet === PLATFORM_WALLET || fact.submitterWallet === "platform";
    if (isPlatformOwned) {
      lines.push({
        wallet: PLATFORM_WALLET,
        role: "platform",
        snippetId: fact.snippetId,
        amountMicros: slice,
      });
      continue;
    }
    const submitterAmt = bps(slice, SUBMITTER_BPS);
    let verifierPool = slice - submitterAmt;
    lines.push({
      wallet: fact.submitterWallet,
      role: "submitter",
      snippetId: fact.snippetId,
      amountMicros: submitterAmt,
    });
    const verifiers = [...new Set(fact.verifierWallets.filter((w) => w && w !== fact.submitterWallet))];
    if (verifiers.length === 0) {
      // No standing verifiers: leftover verifier cut stays in the reserve.
      const reserve = lines.find((l) => l.role === "reserve" && l.snippetId === null);
      if (reserve) reserve.amountMicros += verifierPool;
      else lines.push({ wallet: RESERVE_WALLET, role: "reserve", snippetId: fact.snippetId, amountMicros: verifierPool });
      continue;
    }
    const each = Math.floor(verifierPool / verifiers.length);
    leftover = verifierPool - each * verifiers.length;
    for (const wallet of verifiers) {
      let amt = each;
      if (leftover > 0) {
        amt += 1;
        leftover -= 1;
      }
      lines.push({
        wallet,
        role: "verifier",
        snippetId: fact.snippetId,
        amountMicros: amt,
      });
    }
  }

  const summed = lines.reduce((s, l) => s + l.amountMicros, 0);
  if (summed !== fee) {
    const reserve = lines.find((l) => l.role === "reserve" && l.snippetId === null);
    if (reserve) reserve.amountMicros += fee - summed;
  }
  return lines.filter((l) => l.amountMicros > 0);
}

export function totalsByWallet(lines: LedgerLine[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of lines) {
    map.set(line.wallet, (map.get(line.wallet) ?? 0) + line.amountMicros);
  }
  return map;
}
