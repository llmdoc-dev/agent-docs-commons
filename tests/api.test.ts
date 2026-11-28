import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig, USDC_MINT_DEVNET } from "../src/config.ts";
import { getWallet, ledgerSummary, pendingPayouts } from "../src/db.ts";
import { openMigratedDb } from "../src/sqlite.ts";
import { createApp, type App } from "../src/app.ts";
import { HOUSE_WALLET, TREASURY_WALLET } from "../src/payout.ts";

const AGENT_A = "BDkdaa5aHZZooaG2dRRMzBNe33PzTqZoZyQaBxVrdzi7";
const AGENT_B = "BtWTZbXWs9Zbpawja3NxC6Rj4E1HGPF8P6y1fvX9nXJx";
const PAYER = "3fNDHnonA7xWsvLFkMoBmvSMCwcfvgjvT9PNdP6hLtGr";

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

beforeAll(async () => {
  dbPath = join(mkdtempSync(join(tmpdir(), "docs-commons-test-")), "t.sqlite");
  const cfg = loadConfig({
    port: 0,
    paymentMode: "mock",
    dbPath,
    publicBaseUrl: "http://127.0.0.1",
  });
  const db = await openMigratedDb(dbPath);
  app = await createApp(cfg, db);
});

describe("HTTP API", () => {
  it("serves health, llms.txt, OpenAPI, robots.txt, and sitemap", async () => {
    const health = await http("/health");
    expect(health.status).toBe(200);
    expect((health.body as { paymentMode: string }).paymentMode).toBe("mock");
    expect((health.body as { network: string }).network).toContain("solana:");
    const llms = await http("/llms.txt");
    expect(llms.status).toBe(200);
    expect(String(llms.body)).toContain("Agent Docs Commons");
    const spec = await http("/openapi.json");
    expect(spec.status).toBe(200);
    expect((spec.body as { openapi: string }).openapi).toBe("3.1.0");
    const robots = await http("/robots.txt");
    expect(robots.status).toBe(200);
    expect(String(robots.body)).toContain("Allow: /");
    expect(String(robots.body)).toContain("Sitemap:");
    const sitemap = await http("/sitemap.xml");
    expect(sitemap.status).toBe(200);
    expect(String(sitemap.body)).toContain("/llms.txt");
    expect(String(sitemap.body)).toContain("/.well-known/x402");
  });

  it("returns a Solana-devnet 402 challenge on unpaid discovery probes and after the free trial", async () => {
    const discovery = await http("/v1/docs/lookup");
    expect(discovery.status).toBe(402);
    const body = discovery.body as { x402Version: number; resource?: { url?: string }; extensions?: { bazaar?: { info?: { input?: { method?: string } } } }; accepts: Array<{ network: string; asset: string; payTo: string; amount: string }> };
    expect(body.x402Version).toBe(2);
    expect(body.accepts[0]!.network).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    expect(body.accepts[0]!.asset).toBe(USDC_MINT_DEVNET);
    expect(body.accepts[0]!.amount).toBe("10000");
    expect(body.accepts[0]!.payTo).toBeTruthy();
    expect(body.resource?.url).toBe("http://127.0.0.1/v1/docs/lookup");
    expect(body.extensions?.bazaar?.info?.input?.method).toBe("GET");

    const trialIp = { "CF-Connecting-IP": "203.0.113.50" };
    // A brand-new client identity gets 20 free lookups on its first UTC day.
    for (let i = 0; i < 20; i++) {
      const free = await http("/v1/docs/lookup?library=react&q=useState", { headers: trialIp });
      expect(free.status).toBe(200);
      expect((free.body as { payment: { mode: string } }).payment.mode).toBe("free");
    }
    const after = await http("/v1/docs/lookup?library=react&q=useState", { headers: trialIp });
    expect(after.status).toBe(402);
    expect((after.body as { x402Version: number }).x402Version).toBe(2);
    expect((after.body as { accepts: Array<{ amount: string }> }).accepts[0]!.amount).toBe("10000");
  });

  it("returns 402 on the canonical lookup URL even when q is missing", async () => {
    const unpaid = await http("/v1/docs/lookup");
    expect(unpaid.status).toBe(402);
    const head = await app.handle(new Request("http://127.0.0.1/v1/docs/lookup", { method: "HEAD" }));
    expect(head.status).toBe(402);
    const paid = await http("/v1/docs/lookup", { headers: { "X-PAYMENT": `mock:${PAYER}` } });
    expect(paid.status).toBe(400);
    expect((paid.body as { error: string }).error).toBe("q is required");
  });

  it("returns cited React snippets after a mock payment", async () => {
    const res = await http("/v1/docs/lookup?library=react&q=useState", {
      headers: { "X-PAYMENT": `mock:${PAYER}` },
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      results: Array<{ title: string; sourceUrl: string; license: string; houseOwned: boolean; submitterWallet: string }>;
      payment: { mode: string; feeUsd: number };
    };
    expect(body.payment.mode).toBe("mock");
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0]!.sourceUrl).toMatch(/^https:\/\/react\.dev\//);
    expect(body.results[0]!.license).toBe("CC-BY-4.0");
    expect(body.results[0]!.houseOwned).toBe(true);
    expect(body.results[0]!.submitterWallet).toBe(HOUSE_WALLET);
    const payout = (
      res.body as { payout: { lines: Array<{ wallet: string; role: string }> } }
    ).payout.lines;
    expect(payout.some((l) => l.wallet === TREASURY_WALLET && l.role === "house")).toBe(true);
    expect(payout.some((l) => l.role === "submitter")).toBe(false);
  });

  it("lists the official seeded libraries", async () => {
    const res = await http("/v1/docs/libraries");
    expect(res.status).toBe(200);
    const libraries = (res.body as { libraries: Array<{ library: string; count: number }> }).libraries;
    const names = libraries.map((l) => l.library);
    expect(names).toEqual(
      expect.arrayContaining([
        "react",
        "express",
        "zod",
        "nextjs",
        "nodejs",
        "typescript",
        "python",
        "fastapi",
        "django",
        "pandas",
        "numpy",
        "prisma",
        "vite",
        "requests",
        "pydantic",
        "flask",
        "postgresql",
        "docker",
        "stripe",
        "openai",
        "langchain",
        "aws-sdk",
        "boto3",
      ]),
    );
    expect(names).not.toContain("tailwind");
    expect(names).toEqual(
      expect.arrayContaining(["x402", "solana-kit", "solana-web3js", "mcp-typescript", "mcp-python", "phantom-connect", "ai-sdk", "hono"]),
    );
    expect(names).toEqual(
      expect.arrayContaining([
        "supabase",
        "drizzle",
        "trpc",
        "anthropic",
        "anchor",
        "cloudflare-workers",
        "expo",
        "tanstack-query",
        "playwright",
        "sveltekit",
        "authjs",
        "bun",
        "sqlalchemy",
        "llamaindex",
        "react-router",
        "vitest",
        "pytest",
        "uv",
        "ruff",
        "biome",
        "eslint",
        "prettier",
      ]),
    );
    expect(libraries).toHaveLength(53);
    expect(libraries.reduce((s, l) => s + l.count, 0)).toBe(188);
  });

  it("accepts a contribution, blocks self-verify, then verifies and pays out on use", async () => {
    const submit = await http("/v1/contribute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wallet: AGENT_A,
        library: "zod",
        libraryVersion: "4.x",
        title: "z.array builds an array schema",
        body: "z.array(z.string()) validates an array of strings. You can chain .min(1) or .nonempty() so an empty array fails. Use this when a field must be a list of values rather than a single value. This is a short cited excerpt, not the full Zod API.",
        sourceUrl: "https://zod.dev/api",
        license: "MIT",
      }),
    });
    expect(submit.status).toBe(201);
    const snippetId = (submit.body as { snippet: { id: string; status: string } }).snippet.id;
    expect((submit.body as { snippet: { status: string } }).snippet.status).toBe("pending");

    const self = await http("/v1/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: AGENT_A, snippetId, verdict: "confirm" }),
    });
    expect(self.status).toBe(400);

    const verify = await http("/v1/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: AGENT_B, snippetId, verdict: "confirm" }),
    });
    expect(verify.status).toBe(200);
    expect((verify.body as { snippet: { status: string } }).snippet.status).toBe("verified");

    const lookup = await http("/v1/docs/lookup?library=zod&q=array%20schema", {
      headers: { "X-PAYMENT": `mock:${PAYER}` },
    });
    expect(lookup.status).toBe(200);
    const used = (lookup.body as { results: Array<{ id: string }> }).results.map((r) => r.id);
    expect(used).toContain(snippetId);
    const lines = (lookup.body as { payout: { lines: Array<{ wallet: string; role: string; amountUsd: string }> } }).payout.lines;
    expect(lines.some((l) => l.wallet === AGENT_A && l.role === "submitter")).toBe(true);
    expect(lines.some((l) => l.wallet === AGENT_B && l.role === "verifier")).toBe(true);

    const dry = await http("/v1/payouts/dry-run", { method: "POST" });
    expect(dry.status).toBe(200);
    expect((dry.body as { sent: boolean; mode: string }).sent).toBe(false);
    expect((dry.body as { mode: string }).mode).toBe("dry_run");
    const would = (dry.body as { wouldPay: Array<{ wallet: string }> }).wouldPay;
    expect(would.some((w) => w.wallet === AGENT_A)).toBe(true);
    expect(would.some((w) => w.wallet === AGENT_B)).toBe(true);
    expect(would.some((w) => w.wallet === TREASURY_WALLET || w.wallet === HOUSE_WALLET)).toBe(false);

    const db = await openMigratedDb(dbPath);
    expect((await getWallet(db, AGENT_A))?.reputation).toBeGreaterThan(0);
    expect((await getWallet(db, AGENT_B))?.reputation).toBeGreaterThan(0);
    const totals = await ledgerSummary(db);
    expect(totals.treasuryMicros).toBeGreaterThan(0);
    expect((await pendingPayouts(db)).every((p) => p.wallet !== TREASURY_WALLET && p.wallet !== HOUSE_WALLET)).toBe(
      true,
    );
  });

  it("rejects a contribution from a host that is not on the allowlist", async () => {
    const res = await http("/v1/contribute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wallet: AGENT_A,
        library: "react",
        libraryVersion: "19.0.0",
        title: "A copied blog post",
        body: "This would be a long enough body to pass the length check but the source is not official documentation and should be rejected by the allowlist.",
        sourceUrl: "https://my-seo-blog.example/react-hooks-guide",
      }),
    });
    expect(res.status).toBe(400);
  });
  it("serves a landing page and x402 discovery document", async () => {
    const home = await http("/");
    expect(home.status).toBe(200);
    expect(String(home.body)).toContain("llmdocs.dev");
    const disc = await http("/.well-known/x402");
    expect(disc.status).toBe(200);
    const body = disc.body as { x402Version: number; accepts: Array<{ network: string; asset: string; amount: string }> };
    expect(body.x402Version).toBe(2);
    expect(body.accepts[0]!.amount).toBe("10000");
    expect(body.accepts[0]!.asset).toBe(USDC_MINT_DEVNET);
  });

  it("lists library titles on the homepage and short previews on /browse, without paid bodies", async () => {
    const home = await http("/");
    expect(home.status).toBe(200);
    const homeHtml = String(home.body);
    expect(homeHtml).toContain("What's inside");
    expect(homeHtml).toContain("$0.01");
    expect(homeHtml).toMatch(/full answers are paid via x402/i);
    expect(homeHtml).toContain('href="/browse"');
    expect(homeHtml).toContain("React");
    expect(homeHtml).toContain("Django");
    expect(homeHtml).toContain("useState declares a state variable");
    expect(homeHtml).not.toContain("Set isolationLevel when you need a stricter isolation mode");
    expect(homeHtml).not.toContain("The setter replaces the previous value; passing an updater function receives the pending state.");

    const browse = await http("/browse");
    expect(browse.status).toBe(200);
    const browseHtml = String(browse.body);
    expect(browseHtml).toContain("React");
    expect(browseHtml).toContain("Django");
    expect(browseHtml).toContain("useState declares a state variable");
    expect(browseHtml).toContain("house");
    expect(browseHtml).toContain("verified");
    expect(browseHtml).toContain("useState is a React Hook");
    expect(browseHtml).not.toContain("The setter replaces the previous value; passing an updater function receives the pending state.");
    expect(browseHtml).not.toContain("Set isolationLevel when you need a stricter isolation mode");

    const pendingTitle = "useImperativeHandle exposes a handle to a parent";
    const pendingBody =
      "useImperativeHandle customizes the handle exposed to parent components when using ref. This catalog test body is long enough that a 120-character preview cannot include the secret paid tail UNIQUE_PENDING_TAIL_TOKEN.";
    const submit = await http("/v1/contribute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wallet: AGENT_A,
        library: "react",
        libraryVersion: "19.0",
        title: pendingTitle,
        body: pendingBody,
        sourceUrl: "https://react.dev/reference/react/useImperativeHandle",
        license: "CC-BY-4.0",
      }),
    });
    expect(submit.status).toBe(201);
    const after = String((await http("/browse")).body);
    expect(after).toContain(pendingTitle);
    expect(after).toContain("contributed");
    expect(after).toContain("pending");
    expect(after).not.toContain("UNIQUE_PENDING_TAIL_TOKEN");
    expect(String((await http("/")).body)).toContain(pendingTitle);

    const sitemap = String((await http("/sitemap.xml")).body);
    expect(sitemap).toContain("/browse");
    expect(sitemap).toContain("/referrals");
    const llms = String((await http("/llms.txt")).body);
    expect(llms).toContain("/browse");
    expect(llms).toContain("/referrals");
    expect(llms).toContain("stripe");
    expect(llms).toMatch(/not cheaper per call/i);

    expect(homeHtml).toContain("claude mcp add");
    expect(homeHtml).toContain(".cursor/mcp.json");
    expect(homeHtml).toContain("Context7");
    expect(homeHtml).toMatch(/not cheaper per call/i);
    expect(homeHtml).toContain("Stripe");
    const referrals = await http("/referrals");
    expect(referrals.status).toBe(200);
    expect(String(referrals.body)).toContain("10%");
    expect(String(referrals.body)).toContain("X-Llmdocs-Ref");
  });

  it("serves aggregate-only /v1/stats and documents it in OpenAPI", async () => {
    const res = await http("/v1/stats");
    expect(res.status).toBe(200);
    const body = res.body as {
      timezone: string;
      lookups: { total: number; paid: number; uniquePayers: number };
      contributions: { libraries: number };
      wallet: { error: string | null };
      directories: Array<{ name: string }>;
    };
    expect(body.timezone).toBe("America/Phoenix");
    expect(body.lookups.paid).toBeGreaterThanOrEqual(1);
    expect(body.lookups.uniquePayers).toBeGreaterThanOrEqual(1);
    expect(body.contributions.libraries).toBeGreaterThanOrEqual(23);
    expect(body.directories.some((d) => d.name === "PayAI Bazaar")).toBe(true);
    expect(body.wallet.error).toBe("skipped_in_non_mainnet");
    const json = JSON.stringify(body);
    expect(json).not.toMatch(/payer_wallet|identity_key|content_hash|private_key/);
    expect(json).not.toContain(PAYER);
    const spec = await http("/openapi.json");
    expect(JSON.stringify(spec.body)).toContain("/v1/stats");
  });

});
