import { describe, expect, it } from "vitest";
import {
  splitQueryFee,
  totalsByWallet,
  isHouseOwnedFact,
  HOUSE_WALLET,
  TREASURY_WALLET,
  PLATFORM_WALLET,
  RESERVE_WALLET,
} from "../src/payout.ts";
import { usdToMicros } from "../src/money.ts";

const AGENT_A = "BDkdaa5aHZZooaG2dRRMzBNe33PzTqZoZyQaBxVrdzi7";
const AGENT_B = "BtWTZbXWs9Zbpawja3NxC6Rj4E1HGPF8P6y1fvX9nXJx";
const AGENT_C = "3fNDHnonA7xWsvLFkMoBmvSMCwcfvgjvT9PNdP6hLtGr";

describe("splitQueryFee", () => {
  it("splits 60/30/10 and sums to the fee", () => {
    const fee = 0.01;
    const lines = splitQueryFee(fee, [
      {
        snippetId: "s1",
        submitterWallet: AGENT_A,
        verifierWallets: [AGENT_B],
      },
    ]);
    const sum = lines.reduce((s, l) => s + l.amountMicros, 0);
    expect(sum).toBe(usdToMicros(fee));
    const byRole = Object.fromEntries(
      ["platform", "reserve", "submitter", "verifier"].map((role) => [
        role,
        lines.filter((l) => l.role === role).reduce((s, l) => s + l.amountMicros, 0),
      ]),
    );
    expect(byRole.platform).toBe(usdToMicros(0.003));
    expect(byRole.reserve).toBe(usdToMicros(0.001));
    // 60% pool = 6000 micros; 70% of that to submitter = 4200; 30% to verifier = 1800
    expect(byRole.submitter).toBe(4200);
    expect(byRole.verifier).toBe(1800);
  });

  it("routes a house-owned seed fact's contributor share to the treasury, not to external wallets", () => {
    const lines = splitQueryFee(0.01, [
      { snippetId: "seed", submitterWallet: HOUSE_WALLET, verifierWallets: [], houseOwned: true },
    ]);
    const byWallet = totalsByWallet(lines);
    expect(byWallet.get(TREASURY_WALLET)).toBe(usdToMicros(0.006));
    expect(byWallet.get(PLATFORM_WALLET)).toBe(usdToMicros(0.003));
    expect(byWallet.get(RESERVE_WALLET)).toBe(usdToMicros(0.001));
    expect(byWallet.has(HOUSE_WALLET)).toBe(false);
    expect(lines.filter((l) => l.role === "house").every((l) => l.wallet === TREASURY_WALLET)).toBe(true);
    expect(lines.some((l) => l.role === "submitter")).toBe(false);
    expect(lines.reduce((s, l) => s + l.amountMicros, 0)).toBe(usdToMicros(0.01));
  });

  it("treats a legacy platform submitter as house-owned and still accrues to the treasury", () => {
    const lines = splitQueryFee(0.01, [
      { snippetId: "legacy", submitterWallet: PLATFORM_WALLET, verifierWallets: [] },
    ]);
    expect(isHouseOwnedFact({ submitterWallet: PLATFORM_WALLET })).toBe(true);
    const byWallet = totalsByWallet(lines);
    expect(byWallet.get(TREASURY_WALLET)).toBe(usdToMicros(0.006));
    expect(byWallet.get(PLATFORM_WALLET)).toBe(usdToMicros(0.003));
  });

  it("pays an external verifier of a house fact, and sends only the submitter cut to the treasury", () => {
    const lines = splitQueryFee(0.01, [
      {
        snippetId: "seed",
        submitterWallet: HOUSE_WALLET,
        verifierWallets: [AGENT_B],
        houseOwned: true,
      },
    ]);
    const byWallet = totalsByWallet(lines);
    expect(byWallet.get(TREASURY_WALLET)).toBe(4200);
    expect(byWallet.get(AGENT_B)).toBe(1800);
    expect(lines.some((l) => l.wallet === AGENT_B && l.role === "verifier")).toBe(true);
    expect(lines.some((l) => l.role === "submitter")).toBe(false);
    expect(lines.reduce((s, l) => s + l.amountMicros, 0)).toBe(usdToMicros(0.01));
  });

  it("splits a mixed lookup so house facts go to the treasury and agent facts pay the submitter", () => {
    const lines = splitQueryFee(0.01, [
      { snippetId: "house-1", submitterWallet: HOUSE_WALLET, verifierWallets: [], houseOwned: true },
      { snippetId: "agent-1", submitterWallet: AGENT_A, verifierWallets: [AGENT_B] },
    ]);
    const byWallet = totalsByWallet(lines);
    // pool 6000 micros / 2 facts = 3000 each
    // house fact, no external verifier: all 3000 to treasury
    expect(byWallet.get(TREASURY_WALLET)).toBe(3000);
    // agent fact: 70% submitter = 2100, 30% verifier = 900
    expect(byWallet.get(AGENT_A)).toBe(2100);
    expect(byWallet.get(AGENT_B)).toBe(900);
    expect(byWallet.get(PLATFORM_WALLET)).toBe(usdToMicros(0.003));
    expect(byWallet.get(RESERVE_WALLET)).toBe(usdToMicros(0.001));
    expect(lines.reduce((s, l) => s + l.amountMicros, 0)).toBe(usdToMicros(0.01));
  });

  it("splits the verifier cut evenly and still sums to the fee", () => {
    const lines = splitQueryFee(0.01, [
      {
        snippetId: "s1",
        submitterWallet: AGENT_A,
        verifierWallets: [AGENT_B, AGENT_C],
      },
    ]);
    const verifiers = lines.filter((l) => l.role === "verifier");
    expect(verifiers).toHaveLength(2);
    expect(verifiers[0]!.amountMicros + verifiers[1]!.amountMicros).toBe(1800);
    expect(lines.reduce((s, l) => s + l.amountMicros, 0)).toBe(usdToMicros(0.01));
  });

  it("sends the whole contributor pool to the treasury when no facts are attributed", () => {
    const lines = splitQueryFee(0.01, []);
    const byWallet = totalsByWallet(lines);
    expect(byWallet.get(PLATFORM_WALLET)).toBe(usdToMicros(0.003));
    expect(byWallet.get(RESERVE_WALLET)).toBe(usdToMicros(0.001));
    expect(byWallet.get(TREASURY_WALLET)).toBe(usdToMicros(0.006));
  });
});
