import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assetsForNetwork,
  assetSymbolForMint,
  loadConfig,
  loadWorkerConfig,
  MAINNET_PAY_TO,
  PYUSD_MINT_MAINNET,
  SOLANA_DEVNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
  USDT_MINT_MAINNET,
} from "../src/config.ts";
import { openMigratedDb } from "../src/sqlite.ts";
import { createApp, type App } from "../src/app.ts";
import type { Db } from "../src/db.ts";
import { buildStats, skippedWallet } from "../src/stats.ts";
import { planUsdtSwap, quotePassesPegGuard } from "../scripts/swap-usdt.ts";

const FACILITATOR = "https://facilitator.test";
const FEE_PAYER = "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww";
const PAYER = "HUhesjPxSncZATybNPfjqtqq2mRy319G1ibvTRpbuFkk";

describe("accepted payment assets", () => {
  it("uses the issuers' official mints and token programs", () => {
    const list = assetsForNetwork(SOLANA_MAINNET_CAIP2);
    expect(list.map((a) => a.symbol)).toEqual(["USDC", "PYUSD", "USDT"]);
    expect(list[0]).toMatchObject({ mint: USDC_MINT_MAINNET, tokenProgram: TOKEN_PROGRAM, decimals: 6 });
    expect(list[1]).toMatchObject({ mint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", tokenProgram: TOKEN_2022_PROGRAM, decimals: 6 });
    expect(list[2]).toMatchObject({ mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", tokenProgram: TOKEN_PROGRAM, decimals: 6 });
    expect(list.some((a) => /RLUSD/i.test(a.symbol))).toBe(false);
  });

  it("can switch an asset off by config but always keeps USDC first", () => {
    expect(assetsForNetwork(SOLANA_MAINNET_CAIP2, "USDC,PYUSD").map((a) => a.symbol)).toEqual(["USDC", "PYUSD"]);
    expect(assetsForNetwork(SOLANA_MAINNET_CAIP2, "PYUSD").map((a) => a.symbol)).toEqual(["USDC", "PYUSD"]);
    expect(assetsForNetwork(SOLANA_MAINNET_CAIP2, "USDT,RLUSD").map((a) => a.symbol)).toEqual(["USDC", "USDT"]);
    const worker = loadWorkerConfig({ DB: null, X402_ASSETS: "USDC,USDT" });
    expect(worker.asset).toBe(USDC_MINT_MAINNET);
    expect(worker.assets.map((a) => a.symbol)).toEqual(["USDC", "USDT"]);
  });

  it("stays USDC-only on devnet", () => {
    expect(assetsForNetwork(SOLANA_DEVNET_CAIP2).map((a) => a.mint)).toEqual([USDC_MINT_DEVNET]);
    expect(assetSymbolForMint(PYUSD_MINT_MAINNET)).toBe("PYUSD");
    expect(assetSymbolForMint(USDT_MINT_MAINNET)).toBe("USDT");
    expect(assetSymbolForMint(null)).toBe("USDC");
  });
});

describe("multi-asset x402 lookups", () => {
  let app: App;
  let db: Db;
  const realFetch = globalThis.fetch;
  const settledAssets: string[] = [];

  beforeAll(async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === `${FACILITATOR}/supported`) {
        return Response.json({ kinds: [{ x402Version: 2, scheme: "exact", network: SOLANA_MAINNET_CAIP2, extra: { feePayer: FEE_PAYER } }] });
      }
      if (url === `${FACILITATOR}/verify`) return Response.json({ isValid: true, payer: PAYER });
      if (url === `${FACILITATOR}/settle`) {
        const body = JSON.parse(String(init?.body)) as { paymentRequirements: { asset: string } };
        settledAssets.push(body.paymentRequirements.asset);
        return Response.json({ success: true, payer: PAYER, transaction: `Sig${settledAssets.length}${"1".repeat(80)}`, network: SOLANA_MAINNET_CAIP2 });
      }
      return new Response("not stubbed", { status: 599 });
    });
    const dbPath = join(mkdtempSync(join(tmpdir(), "llmdocs-assets-")), "t.sqlite");
    const cfg = loadConfig({
      port: 0,
      paymentMode: "x402",
      network: SOLANA_MAINNET_CAIP2,
      facilitatorUrl: FACILITATOR,
      payTo: MAINNET_PAY_TO,
      dbPath,
      publicBaseUrl: "https://llmdocs.dev",
    });
    db = await openMigratedDb(dbPath);
    app = await createApp(cfg, db);
  });

  afterAll(() => {
    vi.stubGlobal("fetch", realFetch);
    vi.unstubAllGlobals();
  });

  async function challenge() {
    const res = await app.handle(new Request("https://llmdocs.dev/v1/docs/lookup"));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts: Array<{ asset: string; amount: string; payTo: string; extra: Record<string, unknown> }> };
    const header = JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED")!, "base64").toString("utf8")) as { accepts: unknown[] };
    expect(header.accepts).toEqual(body.accepts);
    return body.accepts;
  }

  function payHeader(accepted: unknown): string {
    return Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { transaction: `tx-${Math.random()}-AAAAAAAAAAAAAAAA` } })).toString("base64");
  }

  it("lists USDC first, then PYUSD (Token-2022 hint) and USDT, all at 10000 atomic units", async () => {
    const accepts = await challenge();
    expect(accepts.map((a) => a.asset)).toEqual([USDC_MINT_MAINNET, PYUSD_MINT_MAINNET, USDT_MINT_MAINNET]);
    expect(accepts.every((a) => a.amount === "10000" && a.payTo === MAINNET_PAY_TO)).toBe(true);
    expect(accepts.map((a) => a.extra.name)).toEqual(["USDC", "PYUSD", "USDT"]);
    expect(accepts[1]!.extra.tokenProgram).toBe(TOKEN_2022_PROGRAM);
    expect(accepts[0]!.extra.tokenProgram).toBeUndefined();
    expect(accepts.every((a) => a.extra.feePayer === FEE_PAYER)).toBe(true);
  });

  it("settles a PYUSD or USDT payment and records the asset on the query and ledger rows", async () => {
    const accepts = await challenge();
    for (const [i, sym] of [[1, "PYUSD"], [2, "USDT"]] as const) {
      const res = await app.handle(
        new Request("https://llmdocs.dev/v1/docs/lookup?library=react&q=useState", { headers: { "PAYMENT-SIGNATURE": payHeader(accepts[i]) } }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { payment: { asset: string; assetMint: string; feeUsd: number }; payout: { lines: Array<{ amountUsd: string }> } };
      expect(body.payment.asset).toBe(sym);
      expect(body.payment.assetMint).toBe(accepts[i]!.asset);
      expect(body.payout.lines.reduce((s, l) => s + Number(l.amountUsd), 0)).toBeCloseTo(0.01, 6);
      const paymentResponse = JSON.parse(Buffer.from(res.headers.get("PAYMENT-RESPONSE")!, "base64").toString("utf8")) as { asset: string };
      expect(paymentResponse.asset).toBe(accepts[i]!.asset);
    }
    expect(settledAssets).toEqual([PYUSD_MINT_MAINNET, USDT_MINT_MAINNET]);
    const ledgerAssets = await db.all(`SELECT DISTINCT payment_asset AS a FROM ledger_entries ORDER BY a`);
    expect(ledgerAssets.map((r) => r.a).sort()).toEqual([PYUSD_MINT_MAINNET, USDT_MINT_MAINNET].sort());
    const queryAssets = await db.all(`SELECT payment_asset AS a FROM queries WHERE payment_mode = 'x402'`);
    expect(queryAssets.map((r) => r.a).sort()).toEqual([PYUSD_MINT_MAINNET, USDT_MINT_MAINNET].sort());
    const settled = await db.all(`SELECT asset FROM settled_payments`);
    expect(settled.map((r) => r.asset).sort()).toEqual([PYUSD_MINT_MAINNET, USDT_MINT_MAINNET].sort());
  });

  it("rejects an asset that is not on the accepts list (e.g. a copycat token)", async () => {
    const accepts = await challenge();
    const fake = { ...accepts[0], asset: "RLUSDcopycat1111111111111111111111111111111", extra: { name: "RLUSD", decimals: 6 } };
    const before = settledAssets.length;
    const res = await app.handle(
      new Request("https://llmdocs.dev/v1/docs/lookup?library=react&q=useState", { headers: { "PAYMENT-SIGNATURE": payHeader(fake) } }),
    );
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toMatch(/does not match/);
    expect(settledAssets.length).toBe(before);
  });

  it("reports revenue by asset in stats, valuing every asset at $1", async () => {
    const stats = await buildStats(db, (app as unknown as { cfg?: never }).cfg ?? loadConfig({ port: 0, paymentMode: "x402", network: SOLANA_MAINNET_CAIP2, payTo: MAINNET_PAY_TO, facilitatorUrl: FACILITATOR }), skippedWallet("t", "test"));
    expect(stats.lookups.revenueUsdc).toBe("0.020000");
    expect(stats.lookups.revenueByAsset).toEqual([
      { asset: "USDC", mint: USDC_MINT_MAINNET, paid: 0, revenueUsd: "0.000000" },
      { asset: "PYUSD", mint: PYUSD_MINT_MAINNET, paid: 1, revenueUsd: "0.010000" },
      { asset: "USDT", mint: USDT_MINT_MAINNET, paid: 1, revenueUsd: "0.010000" },
    ]);
  });

  it("lists all three assets in /.well-known/x402, the server card, OpenAPI, and llms.txt", async () => {
    const wk = (await (await app.handle(new Request("https://llmdocs.dev/.well-known/x402"))).json()) as {
      accepts: Array<{ asset: string }>;
      acceptedAssets: Array<{ symbol: string; default: boolean }>;
    };
    expect(wk.accepts.map((a) => a.asset)).toEqual([USDC_MINT_MAINNET, PYUSD_MINT_MAINNET, USDT_MINT_MAINNET]);
    expect(wk.acceptedAssets.map((a) => [a.symbol, a.default])).toEqual([["USDC", true], ["PYUSD", false], ["USDT", false]]);
    const card = (await (await app.handle(new Request("https://llmdocs.dev/.well-known/mcp/server-card.json"))).json()) as {
      payment: { assets: Array<{ symbol: string }> };
    };
    expect(card.payment.assets.map((a) => a.symbol)).toEqual(["USDC", "PYUSD", "USDT"]);
    const openapi = (await (await app.handle(new Request("https://llmdocs.dev/openapi.json"))).json()) as {
      paths: Record<string, { get?: { "x-payment-info"?: { protocols: Array<{ currency: string; asset: string }> } } }>;
    };
    expect(openapi.paths["/v1/docs/lookup"]!.get!["x-payment-info"]!.protocols.map((p) => p.currency)).toEqual(["USDC", "PYUSD", "USDT"]);
    const llms = await (await app.handle(new Request("https://llmdocs.dev/llms.txt"))).text();
    expect(llms).toContain(PYUSD_MINT_MAINNET);
    expect(llms).toContain(USDT_MINT_MAINNET);
    const home = await (await app.handle(new Request("https://llmdocs.dev/"))).text();
    expect(home).toMatch(/USDC.*PYUSD.*USDT/s);
  });
});

describe("swap-usdt planning", () => {
  it("skips under 0.05 USDT, swaps the whole balance, and caps at 25 USDT", () => {
    expect(planUsdtSwap(49_999n).swap).toBe(0n);
    expect(planUsdtSwap(50_000n).swap).toBe(50_000n);
    expect(planUsdtSwap(3_210_000n).swap).toBe(3_210_000n);
    expect(planUsdtSwap(40_000_000n).swap).toBe(25_000_000n);
  });

  it("refuses quotes whose worst case is under 98% of the input", () => {
    expect(quotePassesPegGuard(1_000_000n, 990_000n)).toBe(true);
    expect(quotePassesPegGuard(1_000_000n, 980_000n)).toBe(true);
    expect(quotePassesPegGuard(1_000_000n, 979_999n)).toBe(false);
  });
});
