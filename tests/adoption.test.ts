import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { openMigratedDb } from "../src/sqlite.ts";
import { createApp, type App } from "../src/app.ts";
import type { Db } from "../src/db.ts";
import { PREVIEW_MAX_CHARS, mcpInstallLinks } from "../src/catalog.ts";
import { REGISTRY_DESCRIPTION, LOOKUP_TOOL_DESCRIPTION, MEASURED } from "../src/descriptions.ts";
import { renderLookupText } from "../src/mcp-http.ts";
import {
  FREE_LOOKUPS_PER_IP_PER_UTC_DAY,
  NEW_IDENTITY_BONUS_GLOBAL_DAILY_CAP,
  NEW_IDENTITY_FREE_LOOKUPS_FIRST_DAY,
  trialIdentityKey,
  trialIpBucket,
  utcDay,
} from "../src/trial.ts";
import serverJson from "../server.json" with { type: "json" };

let app: App;
let db: Db;

async function http(path: string, init: RequestInit = {}) {
  const res = await app.handle(new Request(`https://llmdocs.dev${path}`, init));
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* raw */
  }
  return { status: res.status, body, text, headers: res.headers };
}

async function mcp(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const res = await http("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.body as { result?: Record<string, unknown>; error?: unknown };
}

beforeAll(async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "docs-commons-adopt-")), "t.sqlite");
  const cfg = loadConfig({ port: 0, paymentMode: "mock", dbPath, publicBaseUrl: "https://llmdocs.dev" });
  db = await openMigratedDb(dbPath);
  app = await createApp(cfg, db);
});

describe("one-click install", () => {
  it("builds key-free Cursor and VS Code install links for the remote endpoint", () => {
    const cfg = loadConfig({ port: 0, paymentMode: "mock", dbPath: ":memory:", publicBaseUrl: "https://llmdocs.dev" });
    const l = mcpInstallLinks(cfg);
    const cursorConfig = new URL(l.cursorWeb).searchParams.get("config")!;
    expect(JSON.parse(atob(cursorConfig))).toEqual({ url: "https://llmdocs.dev/mcp" });
    expect(l.cursorDeeplink.startsWith("cursor://anysphere.cursor-deeplink/mcp/install?name=llmdocs&config=")).toBe(true);
    const inner = new URL(l.vscodeWeb).searchParams.get("url")!;
    expect(inner.startsWith("vscode:mcp/install?")).toBe(true);
    expect(JSON.parse(decodeURIComponent(inner.slice("vscode:mcp/install?".length)))).toEqual({
      name: "llmdocs",
      type: "http",
      url: "https://llmdocs.dev/mcp",
    });
    expect(l.claudeCode).toBe("claude mcp add --transport http llmdocs https://llmdocs.dev/mcp");
  });

  it("shows install buttons on the homepage and in llms.txt", async () => {
    const home = (await http("/")).text;
    expect(home).toContain("Add to Cursor");
    expect(home).toContain("Add to VS Code");
    expect(home).toContain("Add to Claude");
    expect(home).toContain("https://cursor.com/install-mcp?name=llmdocs");
    expect(home).toContain("https://vscode.dev/redirect?url=vscode%3Amcp%2Finstall");
    expect(home).toContain("Add custom connector");
    const llms = (await http("/llms.txt")).text;
    expect(llms).toContain("## Install (MCP, no API key)");
    expect(llms).toContain("https://cursor.com/install-mcp?name=llmdocs");
    expect(llms).toContain("claude mcp add --transport http llmdocs https://llmdocs.dev/mcp");
  });

  it("serves a static MCP server card listing the tools and referral terms", async () => {
    const card = (await http("/.well-known/mcp/server-card.json")).body as {
      serverInfo: { name: string; version: string };
      tools: Array<{ name: string }>;
      authentication: { required: boolean };
      referrals: { share: number; windowDays: number; capUsdPerReferredAgent: number };
    };
    expect(card.serverInfo.name).toBe("llmdocs");
    expect(card.tools.map((t) => t.name)).toEqual(["docs_lookup", "docs_libraries", "docs_contribute", "docs_verify", "preflight", "check_status", "check_package", "get_pricing", "list_check_services"]);
    expect(card.authentication.required).toBe(false);
    expect(card.referrals).toMatchObject({ share: 0.1, windowDays: 180, capUsdPerReferredAgent: 10 });
  });
});

describe("tool descriptions and discovery metadata", () => {
  it("describes docs_lookup with measured size, no key, price, trial, and referral", async () => {
    const init = await mcp("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    const result = init.result as { serverInfo: { version: string }; instructions: string };
    expect(result.serverInfo.version).toBe(serverJson.version);
    expect(result.instructions).toMatch(/10% of that agent's paid spend for 180 days, up to \$10/);
    const list = await mcp("tools/list");
    const tools = (list.result as { tools: Array<{ name: string; description: string }> }).tools;
    const lookup = tools.find((t) => t.name === "docs_lookup")!;
    expect(lookup.description).toBe(LOOKUP_TOOL_DESCRIPTION);
    expect(lookup.description).toContain(`about ${MEASURED.mcpAnswerMedianTokens} tokens`);
    expect(lookup.description).toMatch(/No API key/);
    expect(lookup.description).toContain("$0.01 per lookup");
    expect(lookup.description).toMatch(/USDC, PYUSD, or USDT/);
    expect(lookup.description).toMatch(/20 free lookups on a client's first day, then 5 free per day/);
    expect(lookup.description).toMatch(/version-pinned/);
    expect(lookup.description).not.toMatch(/cheaper than/i);
  });

  it("keeps the registry description under 100 characters and mentions referrals", () => {
    expect(REGISTRY_DESCRIPTION.length).toBeLessThanOrEqual(100);
    expect(serverJson.description).toBe(REGISTRY_DESCRIPTION);
    expect(serverJson.description).toMatch(/referral/i);
  });

  it("advertises the referral program in llms.txt, OpenAPI, and /.well-known/x402", async () => {
    const llms = (await http("/llms.txt")).text;
    expect(llms).toMatch(/earn 10% of that agent's paid spend for 180 days, up to \$10/);
    const spec = (await http("/openapi.json")).body as { info: { description: string; "x-referral-program": { share: number } } };
    expect(spec.info.description).toMatch(/10% of that agent's paid spend for 180 days, up to \$10/);
    expect(spec.info["x-referral-program"].share).toBe(0.1);
    expect(JSON.stringify(spec)).toContain("/browse/{library}");
    const wk = (await http("/.well-known/x402")).body as {
      referrals: { share: number; windowDays: number; capUsdPerReferredAgent: number };
      freeTrial: { firstDayLookups: number; dailyLookupsAfter: number };
      answerSize: { mcpTextMedianTokens: number };
      resource: { description: string };
    };
    expect(wk.referrals).toMatchObject({ share: 0.1, windowDays: 180, capUsdPerReferredAgent: 10 });
    expect(wk.freeTrial).toMatchObject({ firstDayLookups: 20, dailyLookupsAfter: 5 });
    expect(wk.answerSize.mcpTextMedianTokens).toBe(MEASURED.mcpAnswerMedianTokens);
    expect(wk.resource.description).toMatch(/Referrers earn 10%/);
  });

  it("uses the sharp description on the canonical 402 probe for Bazaar crawlers", async () => {
    const probe = await http("/v1/docs/lookup");
    expect(probe.status).toBe(402);
    const body = probe.body as { resource: { description: string }; extensions: { bazaar: { schema: unknown } } };
    expect(body.resource.description).toMatch(/version-pinned developer docs/);
    expect(JSON.stringify(body.extensions.bazaar.schema)).toContain("ref");
  });
});

describe("compact answers", () => {
  it("returns single-line JSON from the HTTP lookup", async () => {
    const res = await http("/v1/docs/lookup?library=react&q=useState", { headers: { "X-PAYMENT": "mock:3fNDHnonA7xWsvLFkMoBmvSMCwcfvgjvT9PNdP6hLtGr" } });
    expect(res.status).toBe(200);
    expect(res.text.includes("\n")).toBe(false);
  });

  it("renders docs_lookup as compact text with source and version, and keeps json on request", async () => {
    const ip = { "CF-Connecting-IP": "198.51.100.77" };
    const text = await mcp("tools/call", { name: "docs_lookup", arguments: { q: "x402 payment headers", library: "x402" } }, ip);
    const out = (text.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(out).toContain("## x402 v2 uses PAYMENT-REQUIRED");
    expect(out).toContain("Source: https://docs.x402.org/");
    expect(out).toMatch(/free trial lookup · 19 free left today/);
    const json = await mcp("tools/call", { name: "docs_lookup", arguments: { q: "useState", library: "react", format: "json" } }, ip);
    const raw = (json.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(JSON.parse(raw).results.length).toBeGreaterThan(0);
  });

  it("explains how to pay when the MCP lookup gets a 402", () => {
    const out = renderLookupText(402, '{"x402Version":2}', "https://llmdocs.dev");
    expect(out).toMatch(/^Payment required/);
    expect(out).toContain("paymentSignature");
    expect(out).toContain('{"x402Version":2}');
  });
});

describe("bigger free trial for new agents", () => {
  const lookup = (ip: string) => http("/v1/docs/lookup?library=zod&q=safeParse", { headers: { "CF-Connecting-IP": ip } });

  it("gives a new identity 20 free lookups on its first day, then 402", async () => {
    const ip = "192.0.2.10";
    for (let i = 0; i < NEW_IDENTITY_FREE_LOOKUPS_FIRST_DAY; i++) {
      const r = await lookup(ip);
      expect(r.status).toBe(200);
      expect((r.body as { payment: { remainingFreeLookups: number } }).payment.remainingFreeLookups).toBe(19 - i);
    }
    expect((await lookup(ip)).status).toBe(402);
  });

  it("drops a returning identity back to 5 per day", async () => {
    const ip = "192.0.2.11";
    const { key } = trialIdentityKey(new Request("https://llmdocs.dev/", { headers: { "CF-Connecting-IP": ip } }));
    await db.run(`INSERT INTO free_lookup_usage (identity_key, period, count) VALUES (?, ?, 1)`, key, "2000-01-01");
    for (let i = 0; i < FREE_LOOKUPS_PER_IP_PER_UTC_DAY; i++) {
      expect((await lookup(ip)).status).toBe(200);
    }
    expect((await lookup(ip)).status).toBe(402);
  });

  it("keeps HEAD and GET-without-q probes at 402 for a brand-new identity", async () => {
    const headers = { "CF-Connecting-IP": "192.0.2.12" };
    expect((await http("/v1/docs/lookup", { headers })).status).toBe(402);
    expect((await http("/v1/docs/lookup?q=useState", { method: "HEAD", headers })).status).toBe(402);
  });

  it("does not give the first-day bonus to requests with no client IP", async () => {
    for (let i = 0; i < FREE_LOOKUPS_PER_IP_PER_UTC_DAY; i++) {
      expect((await http("/v1/docs/lookup?library=zod&q=safeParse")).status).toBe(200);
    }
    expect((await http("/v1/docs/lookup?library=zod&q=safeParse")).status).toBe(402);
  });

  it("caps first-day bonus lookups globally per day", async () => {
    await db.run(
      `INSERT INTO free_lookup_usage (identity_key, period, count) VALUES (?, ?, ?)
       ON CONFLICT(identity_key, period) DO UPDATE SET count = excluded.count`,
      "global:new-identity-bonus",
      utcDay(),
      NEW_IDENTITY_BONUS_GLOBAL_DAILY_CAP,
    );
    const ip = "192.0.2.13";
    for (let i = 0; i < FREE_LOOKUPS_PER_IP_PER_UTC_DAY; i++) {
      expect((await lookup(ip)).status).toBe(200);
    }
    expect((await lookup(ip)).status).toBe(402);
    await db.run(`DELETE FROM free_lookup_usage WHERE identity_key = ?`, "global:new-identity-bonus");
  });

  it("groups IPv6 clients by /64 and stores only hashes", () => {
    expect(trialIpBucket("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(trialIpBucket("2001:db8:1:2:bbbb:cccc:dddd:eeee")).toBe("2001:db8:1:2::/64");
    expect(trialIpBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(trialIpBucket("203.0.113.9")).toBe("203.0.113.9");
    const key = trialIdentityKey(new Request("https://llmdocs.dev/", { headers: { "CF-Connecting-IP": "2001:db8:1:2::5" } })).key;
    expect(key).toMatch(/^ip:[0-9a-f]{64}$/);
    expect(key).not.toContain("2001");
  });
});

describe("SEO library pages", () => {
  it("serves an indexable /browse/<library> page with title, meta description, short previews, and how to buy", async () => {
    const res = await http("/browse/x402");
    expect(res.status).toBe(200);
    const html = res.text;
    expect(html).toMatch(/<title>x402 \(v2 SDKs\) docs for AI agents \(2\.32, 2\.29 \(Python\)\) — llmdocs\.dev<\/title>/);
    expect(html).toMatch(/<meta name="description" content="[^"]{40,}">/);
    expect(html).toContain('<link rel="canonical" href="https://llmdocs.dev/browse/x402">');
    expect(html).toContain("How to get full answers");
    expect(html).toContain("PAYMENT-SIGNATURE");
    expect(html).toContain("application/ld+json");
    expect(html).not.toContain("noindex");
    const previews = [...html.matchAll(/<p class="preview">([^<]*)<\/p>/g)].map((m) => m[1]!.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
    expect(previews.length).toBe(5);
    for (const p of previews) expect(p.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS + 1);
    // Full paid bodies stay off the page.
    expect(html).not.toContain("batch-settlement redeems later");
    expect(html).not.toContain("not a substitute for the official API reference");
  });

  it("returns a noindex 404 for an unknown library", async () => {
    const res = await http("/browse/not-a-real-lib");
    expect(res.status).toBe(404);
    expect(res.text).toContain("noindex");
  });

  it("lists every library page in sitemap.xml and allows crawling in robots.txt", async () => {
    const sitemap = (await http("/sitemap.xml")).text;
    for (const lib of ["react", "x402", "solana-kit", "mcp-typescript", "mcp-python", "phantom-connect", "hono", "ai-sdk"]) {
      expect(sitemap).toContain(`<loc>https://llmdocs.dev/browse/${lib}</loc>`);
    }
    expect(sitemap).toMatch(/<loc>https:\/\/llmdocs\.dev\/browse\/vitest<\/loc><lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
    expect(sitemap).toMatch(/<loc>https:\/\/llmdocs\.dev\/browse<\/loc><lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
    const robots = (await http("/robots.txt")).text;
    expect(robots).toContain("Allow: /browse/");
    expect(robots).toContain("Sitemap: https://llmdocs.dev/sitemap.xml");
    const browse = (await http("/browse")).text;
    expect(browse).toContain('href="/browse/x402"');
  });
});

describe("MCP free trial identity", () => {
  it("counts MCP lookups against the caller's own IP, not a shared bucket", async () => {
    const call = (ip: string) =>
      mcp("tools/call", { name: "docs_lookup", arguments: { q: "safeParse", library: "zod" } }, { "CF-Connecting-IP": ip });
    const a = await call("198.51.100.201");
    const b = await call("198.51.100.202");
    const textA = (a.result as { content: Array<{ text: string }> }).content[0]!.text;
    const textB = (b.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(textA).toContain("19 free left today");
    expect(textB).toContain("19 free left today");
  });
});
