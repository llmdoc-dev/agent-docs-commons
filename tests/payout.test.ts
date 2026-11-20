import { describe, expect, it } from "vitest";
import { splitQueryFee, totalsByWallet, PLATFORM_WALLET, RESERVE_WALLET } from "../src/payout.ts";
import { usdToMicros } from "../src/money.ts";

describe("splitQueryFee", () => {
  it("splits 60/30/10 and sums to the fee", () => {
    const fee = 0.01;
    const lines = splitQueryFee(fee, [
      {
        snippetId: "s1",
        submitterWallet: "BDkdaa5aHZZooaG2dRRMzBNe33PzTqZoZyQaBxVrdzi7",
        verifierWallets: ["BtWTZbXWs9Zbpawja3NxC6Rj4E1HGPF8P6y1fvX9nXJx"],
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

  it("keeps platform-ingested fact slices on the platform", () => {
    const lines = splitQueryFee(0.01, [
      { snippetId: "seed", submitterWallet: PLATFORM_WALLET, verifierWallets: [] },
    ]);
    const byWallet = totalsByWallet(lines);
    expect(byWallet.get(PLATFORM_WALLET)).toBe(usdToMicros(0.003) + usdToMicros(0.006));
    expect(byWallet.get(RESERVE_WALLET)).toBe(usdToMicros(0.001));
  });

  it("splits the verifier cut evenly and still sums to the fee", () => {
    const lines = splitQueryFee(0.01, [
      {
        snippetId: "s1",
        submitterWallet: "BDkdaa5aHZZooaG2dRRMzBNe33PzTqZoZyQaBxVrdzi7",
        verifierWallets: [
          "BtWTZbXWs9Zbpawja3NxC6Rj4E1HGPF8P6y1fvX9nXJx",
          "3fNDHnonA7xWsvLFkMoBmvSMCwcfvgjvT9PNdP6hLtGr",
        ],
      },
    ]);
    const verifiers = lines.filter((l) => l.role === "verifier");
    expect(verifiers).toHaveLength(2);
    expect(verifiers[0]!.amountMicros + verifiers[1]!.amountMicros).toBe(1800);
    expect(lines.reduce((s, l) => s + l.amountMicros, 0)).toBe(usdToMicros(0.01));
  });

  it("sends the whole contributor pool to the platform when no facts are attributed", () => {
    const lines = splitQueryFee(0.01, []);
    const byWallet = totalsByWallet(lines);
    expect(byWallet.get(PLATFORM_WALLET)).toBe(usdToMicros(0.009));
    expect(byWallet.get(RESERVE_WALLET)).toBe(usdToMicros(0.001));
  });
});
