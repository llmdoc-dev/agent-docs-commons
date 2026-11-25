import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { openMigratedDb } from "../src/sqlite.ts";
import { createApp, type App } from "../src/app.ts";
import { resetCheckFetch, setCheckFetch } from "../src/check/fetch.ts";
import { inspectPublicUrl } from "../src/check/ssrf.ts";
import { getService, listServices, servicesWithVerifiedPrices } from "../src/check/seed.ts";

const PAYER = "3fNDHnonA7xWsvLFkMoBmvSMCwcfvgjvT9PNdP6hLtGr";

let app: App;

async function http(path: string, init: RequestInit = {}) {
  const res = await app.handle(new Request(`http://127.0.0.1${path}`, init));
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* raw */
  }
  return { status: res.status, body, text, headers: res.headers };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

beforeAll(async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "check-test-")), "t.sqlite");
  const cfg = loadConfig({
    port: 0,
    paymentMode: "mock",
    dbPath,
    publicBaseUrl: "http://127.0.0.1",
  });
  const db = await openMigratedDb(dbPath);
  app = await createApp(cfg, db);
});

afterEach(() => {
  resetCheckFetch();
});

describe("seed and human page", () => {
  it("seeds a catalog of official services and does not invent Stripe fees", () => {
    expect(listServices().length).toBeGreaterThanOrEqual(16);
    expect(servicesWithVerifiedPrices()).toBeGreaterThanOrEqual(6);
    const supabase = getService("supabase");
    expect(supabase?.plans.find((p) => p.name === "Pro")?.priceUsd).toBe(25);
    expect(supabase?.plans.find((p) => p.name === "Pro")?.verifiedAt).toBeTruthy();
    expect(supabase?.plans.find((p) => p.name === "Pro")?.sourceUrl).toContain("supabase.com/pricing");
    const stripe = getService("stripe");
    expect(stripe?.plans[0]?.priceUsd).toBeNull();
    expect(stripe?.plans[0]?.verifiedAt).toBeNull();
    expect(getService("openai")?.models?.some((m) => m.name === "gpt-4o-mini" && m.inputPerMillionUsd === 0.15)).toBe(true);
  });

  it("serves /check with cross-links to the docs catalog and MCP tools", async () => {
    const page = await http("/check");
    expect(page.status).toBe(200);
    expect(page.text).toContain("preflight");
    expect(page.text).toContain('href="/browse"');
    expect(page.text).toContain("openai");
    expect(page.text).toContain("/browse/openai");
    const home = await http("/");
    expect(home.text).toContain('href="/check"');
    const sitemap = await http("/sitemap.xml");
    expect(sitemap.text).toContain("/check");
    const stripeDocs = await http("/browse/stripe");
    expect(stripeDocs.status).toBe(200);
    expect(stripeDocs.text).toContain("/v1/check/preflight?service=stripe");
  });

  it("lists services for free", async () => {
    const res = await http("/v1/check/services");
    expect(res.status).toBe(200);
    const body = res.body as { count: number; services: Array<{ slug: string }> };
    expect(body.count).toBe(listServices().length);
    expect(body.services.some((s) => s.slug === "cloudflare-workers")).toBe(true);
  });
});

describe("get_pricing", () => {
  it("returns cited Cloudflare Workers facts and leaves unknown fields null", async () => {
    const res = await http("/v1/check/pricing?service=cloudflare-workers", {
      headers: { "CF-Connecting-IP": "198.51.100.10" },
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      freshness: string;
      plans: Array<{ name: string; priceUsd: number | null; sourceUrl: string; verifiedAt: string | null; included: string | null }>;
      payment: { mode: string };
    };
    expect(body.payment.mode).toBe("free");
    const paid = body.plans.find((p) => p.name.startsWith("Workers Paid"));
    expect(paid?.priceUsd).toBe(5);
    expect(paid?.verifiedAt).toBeTruthy();
    expect(paid?.sourceUrl).toContain("developers.cloudflare.com/workers/platform/pricing");
    expect(paid?.included).toMatch(/10 million/i);
    const stripe = await http("/v1/check/pricing?service=stripe", {
      headers: { "CF-Connecting-IP": "198.51.100.10" },
    });
    const stripeBody = stripe.body as { plans: Array<{ priceUsd: number | null }>; freshness: string };
    expect(stripeBody.plans[0]!.priceUsd).toBeNull();
    expect(stripeBody.freshness).toBe("unknown");
  });

  it("returns 404 for an unknown service after the gate", async () => {
    const res = await http("/v1/check/pricing?service=not-a-real-vendor", {
      headers: { "X-PAYMENT": `mock:${PAYER}` },
    });
    expect(res.status).toBe(404);
  });
});

describe("check_package and check_status with a mocked fetch", () => {
  it("reads npm deprecation from the official packument shape", async () => {
    setCheckFetch(async (input) => {
      const url = String(input);
      if (url.includes("registry.npmjs.org/request")) {
        return jsonResponse(200, {
          "dist-tags": { latest: "2.88.2" },
          time: { "2.88.2": "2020-02-11T17:00:00.000Z" },
          versions: { "2.88.2": { deprecated: "request has been deprecated" } },
        });
      }
      return jsonResponse(404, {});
    });
    const res = await http("/v1/check/package?ecosystem=npm&name=request", {
      headers: { "CF-Connecting-IP": "198.51.100.11" },
    });
    expect(res.status).toBe(200);
    const body = res.body as { exists: boolean; latest: string; deprecated: boolean; deprecationMessage: string; registryUrl: string };
    expect(body.exists).toBe(true);
    expect(body.latest).toBe("2.88.2");
    expect(body.deprecated).toBe(true);
    expect(body.deprecationMessage).toMatch(/deprecated/);
    expect(body.registryUrl).toContain("registry.npmjs.org");
  });

  it("reports a missing PyPI project and rejects private probe URLs", async () => {
    setCheckFetch(async (input) => {
      const url = String(input);
      if (url.includes("pypi.org")) return jsonResponse(404, { message: "Not Found" });
      return jsonResponse(200, {});
    });
    const missing = await http("/v1/check/package?ecosystem=pypi&name=this-package-should-not-exist-llmdocs", {
      headers: { "CF-Connecting-IP": "198.51.100.11" },
    });
    expect(missing.status).toBe(200);
    expect((missing.body as { exists: boolean }).exists).toBe(false);

    expect(inspectPublicUrl("http://127.0.0.1/secret").ok).toBe(false);
    expect(inspectPublicUrl("https://169.254.169.254/latest/meta-data").ok).toBe(false);
    expect(inspectPublicUrl("https://example.com/status").ok).toBe(true);

    const blocked = await http("/v1/check/status?url=http://127.0.0.1/secret", {
      headers: { "CF-Connecting-IP": "198.51.100.11" },
    });
    expect(blocked.status).toBe(200);
    const probe = (blocked.body as { probe: { reachable: boolean; error: string } }).probe;
    expect(probe.reachable).toBe(false);
    expect(probe.error).toMatch(/private|invalid|host|ip/);
  });

  it("treats HTTP 401 as reachable and reads a Statuspage official feed", async () => {
    setCheckFetch(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("api.openai.com")) {
        if (method === "HEAD") return new Response(null, { status: 401 });
        return new Response("invalid_api_key", { status: 401 });
      }
      if (url.includes("status.openai.com")) {
        return jsonResponse(200, { status: { indicator: "minor", description: "Partial System Degradation" } });
      }
      return jsonResponse(200, { status: { indicator: "none", description: "All Systems Operational" } });
    });
    const res = await http("/v1/check/status?service=openai", {
      headers: { "CF-Connecting-IP": "198.51.100.12" },
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      overall: string;
      official: { state: string; description: string };
      probe: { reachable: boolean; httpStatus: number; ok: boolean };
    };
    expect(body.probe.reachable).toBe(true);
    expect(body.probe.httpStatus).toBe(401);
    expect(body.official.state).toBe("degraded");
    expect(body.overall).toBe("degraded");
  });
});

describe("shared metering with docs_lookup", () => {
  it("counts a pricing check against the same free daily cap as a docs lookup", async () => {
    const ip = { "CF-Connecting-IP": "203.0.113.88" };
    const first = await http("/v1/docs/lookup?library=react&q=useState", { headers: ip });
    expect(first.status).toBe(200);
    expect((first.body as { payment: { remainingFreeLookups: number } }).payment.remainingFreeLookups).toBe(19);
    const check = await http("/v1/check/pricing?service=vercel", { headers: ip });
    expect(check.status).toBe(200);
    expect((check.body as { payment: { remainingFreeLookups: number } }).payment.remainingFreeLookups).toBe(18);
  });

  it("returns 402 on unpaid discovery probes and after the cap, and still serves paid checks", async () => {
    const discovery = await http("/v1/check/preflight");
    expect(discovery.status).toBe(402);
    const head = await app.handle(new Request("http://127.0.0.1/v1/check/pricing", { method: "HEAD" }));
    expect(head.status).toBe(402);

    const ip = { "CF-Connecting-IP": "203.0.113.89" };
    for (let i = 0; i < 20; i++) {
      const free = await http("/v1/check/pricing?service=supabase", { headers: ip });
      expect(free.status).toBe(200);
    }
    const after = await http("/v1/check/pricing?service=supabase", { headers: ip });
    expect(after.status).toBe(402);
    const paid = await http("/v1/check/pricing?service=supabase", {
      headers: { ...ip, "X-PAYMENT": `mock:${PAYER}` },
    });
    expect(paid.status).toBe(200);
    expect((paid.body as { payment: { mode: string; feeUsd: number } }).payment.mode).toBe("mock");
    expect((paid.body as { payment: { feeUsd: number } }).payment.feeUsd).toBe(0.01);
    expect((paid.body as { payout: { lines: Array<{ role: string }> } }).payout.lines.some((l) => l.role === "house")).toBe(true);
  });
});

describe("MCP tools", () => {
  it("lists the new tools next to the existing docs tools", async () => {
    const res = await http("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const tools = (res.body as { result: { tools: Array<{ name: string }> } }).result.tools;
    const names = tools.map((t) => t.name);
    expect(names.slice(0, 4)).toEqual(["docs_lookup", "docs_libraries", "docs_contribute", "docs_verify"]);
    expect(names).toContain("preflight");
    expect(names).toContain("check_status");
    expect(names).toContain("check_package");
    expect(names).toContain("get_pricing");
    expect(names).toContain("list_check_services");
  });

  it("returns get_pricing through MCP without breaking docs_lookup", async () => {
    const ip = { "CF-Connecting-IP": "198.51.100.13", "content-type": "application/json" };
    const pricing = await http("/mcp", {
      method: "POST",
      headers: ip,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_pricing", arguments: { service: "openai", format: "json" } },
      }),
    });
    expect(pricing.status).toBe(200);
    const text = (pricing.body as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
    const body = JSON.parse(text) as { models: Array<{ name: string }>; payment: { mode: string } };
    expect(body.models.some((m) => m.name === "gpt-4o")).toBe(true);
    expect(body.payment.mode).toBe("free");

    const lookup = await http("/mcp", {
      method: "POST",
      headers: ip,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "docs_lookup", arguments: { q: "useState", library: "react" } },
      }),
    });
    const out = (lookup.body as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
    expect(out).toContain("useState");
    expect(out).toContain("Source:");
  });
});
