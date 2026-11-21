import { usdToMicros } from "./money.ts";

export const CONTRIBUTOR_POOL_BPS = 6000; // 60%
export const PLATFORM_BPS = 3000; // 30%
export const RESERVE_BPS = 1000; // 10%
export const SUBMITTER_BPS = 7000; // 70% of a fact slice
export const VERIFIER_BPS = 3000; // 30% of a fact slice
export const REFERRER_BPS = 1000; // 10% of a referred lookup, taken from the owner share
export const PLATFORM_REFERRED_BPS = 2000; // 20% owner share while a referral is active

/** Identity of the site as a contributor of official seed facts. */
export const HOUSE_WALLET = "house";
/** Where the house contributor share accrues. Not paid out to external agents. */
export const TREASURY_WALLET = "treasury";
export const PLATFORM_WALLET = "platform";
export const RESERVE_WALLET = "reserve";

const INTERNAL_WALLETS = new Set([HOUSE_WALLET, TREASURY_WALLET, PLATFORM_WALLET, RESERVE_WALLET]);

export function isInternalWallet(wallet: string): boolean {
  return INTERNAL_WALLETS.has(wallet);
}

export function isHouseOwnedFact(fact: Pick<FactForPayout, "houseOwned" | "submitterWallet">): boolean {
  return fact.houseOwned === true || isInternalWallet(fact.submitterWallet);
}

export type FactForPayout = {
  snippetId: string;
  submitterWallet: string;
  verifierWallets: string[];
  /** Official site-seeded facts. The submitter cut goes to the treasury, not to external agents. */
  houseOwned?: boolean;
};

export type LedgerLine = {
  wallet: string;
  role: "submitter" | "verifier" | "platform" | "reserve" | "house" | "referral";
  snippetId: string | null;
  amountMicros: number;
  houseOwned?: boolean;
};

function bps(amount: number, basisPoints: number): number {
  return Math.floor((amount * basisPoints) / 10_000);
}

/**
 * Split a query fee across the accepted facts used in the answer.
 * House-owned (site-seeded) facts send the submitter cut of the 60% pool to the treasury.
 * External agents earn only on facts they submitted, or on the verifier cut if they later verified a fact.
 * Remainder micros after integer division go to the reserve so the lines sum to the fee.
 */
export type SplitOptions = {
  /** When set, 10% of the fee goes to this wallet and the owner share drops to 20%. */
  referrerWallet?: string;
  /** Remaining room under the $10 per-referred-agent cap, in atomic USDC. */
  referralCapRemainingMicros?: number;
};

export function splitQueryFee(feeUsd: number, facts: FactForPayout[], opts: SplitOptions = {}): LedgerLine[] {
  if (feeUsd <= 0) throw new Error("fee must be positive");
  const fee = usdToMicros(feeUsd);
  const lines: LedgerLine[] = [];

  const referrer = opts.referrerWallet && !isInternalWallet(opts.referrerWallet) ? opts.referrerWallet : undefined;
  const reservedReferral = referrer ? bps(fee, REFERRER_BPS) : 0;
  const remainingCap = opts.referralCapRemainingMicros;
  const referralAmt = referrer
    ? Math.min(reservedReferral, remainingCap == null ? reservedReferral : Math.max(0, remainingCap))
    : 0;
  const unusedReferral = reservedReferral - referralAmt;
  const platformFixed = referrer ? bps(fee, PLATFORM_REFERRED_BPS) + unusedReferral : bps(fee, PLATFORM_BPS);
  const reserveFixed = bps(fee, RESERVE_BPS);
  const pool = fee - platformFixed - reserveFixed - referralAmt;

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
  if (referrer && referralAmt > 0) {
    lines.push({
      wallet: referrer,
      role: "referral",
      snippetId: null,
      amountMicros: referralAmt,
    });
  }

  if (facts.length === 0) {
    lines.push({
      wallet: TREASURY_WALLET,
      role: "house",
      snippetId: null,
      amountMicros: pool,
      houseOwned: true,
    });
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
    const house = isHouseOwnedFact(fact);
    const submitterAmt = bps(slice, SUBMITTER_BPS);
    let verifierPool = slice - submitterAmt;
    const verifiers = [
      ...new Set(
        fact.verifierWallets.filter((w) => w && w !== fact.submitterWallet && !isInternalWallet(w)),
      ),
    ];

    if (house) {
      lines.push({
        wallet: TREASURY_WALLET,
        role: "house",
        snippetId: fact.snippetId,
        amountMicros: submitterAmt,
        houseOwned: true,
      });
    } else {
      lines.push({
        wallet: fact.submitterWallet,
        role: "submitter",
        snippetId: fact.snippetId,
        amountMicros: submitterAmt,
      });
    }

    if (verifiers.length === 0) {
      // No external verifiers: leftover verifier cut stays with the treasury for house facts, else the reserve.
      if (house) {
        const houseLine = lines.find((l) => l.role === "house" && l.snippetId === fact.snippetId);
        if (houseLine) houseLine.amountMicros += verifierPool;
        else {
          lines.push({
            wallet: TREASURY_WALLET,
            role: "house",
            snippetId: fact.snippetId,
            amountMicros: verifierPool,
            houseOwned: true,
          });
        }
      } else {
        const reserve = lines.find((l) => l.role === "reserve" && l.snippetId === null);
        if (reserve) reserve.amountMicros += verifierPool;
        else lines.push({ wallet: RESERVE_WALLET, role: "reserve", snippetId: fact.snippetId, amountMicros: verifierPool });
      }
      continue;
    }

    const each = Math.floor(verifierPool / verifiers.length);
    let vLeft = verifierPool - each * verifiers.length;
    for (const wallet of verifiers) {
      let amt = each;
      if (vLeft > 0) {
        amt += 1;
        vLeft -= 1;
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

export function externalPayoutLines(lines: LedgerLine[]): LedgerLine[] {
  return lines.filter((l) => !isInternalWallet(l.wallet));
}
