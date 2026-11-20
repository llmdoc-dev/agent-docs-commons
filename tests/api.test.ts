import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { openDb, getWallet } from "../src/db.ts";
import { createApp } from "../src/app.ts";

const AGENT_A = "BDkdaa5aHZZooaG2dRRMzBNe33PzTqZoZyQaBxVrdzi7";
const AGENT_B = "BtWTZbXWs9Zbpawja3NxC6Rj4E1HGPF8P6y1fvX9nXJx";
const PAYER = "3fNDHnonA7xWsvLFkMoBmvSMCwcfvgjvT9PNdP6hLtGr";

let server: Server;
let base = "";
let dbPath = "";

async function http(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, init);
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
  const db = openDb(dbPath);
  const app = createApp(cfg, db);
  server = createServer((req, res) => {
    void app.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("HTTP API", () => {
  it("serves health, llms.txt, and OpenAPI", async () => {
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
  });

  it("returns a Solana-devnet 402 challenge without payment", async () => {
    const res = await http("/v1/docs/lookup?library=react&q=useState");
    expect(res.status).toBe(402);
    const body = res.body as { x402Version: number; accepts: Array<{ network: string; asset: string; payTo: string }> };
    expect(body.x402Version).toBe(2);
    expect(body.accepts[0]!.network).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    expect(body.accepts[0]!.asset).toBe("USDC");
    expect(body.accepts[0]!.payTo).toBeTruthy();
  });

  it("returns cited React snippets after a mock payment", async () => {
    const res = await http("/v1/docs/lookup?library=react&q=useState", {
      headers: { "X-PAYMENT": `mock:${PAYER}` },
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      results: Array<{ title: string; sourceUrl: string; license: string }>;
      payment: { mode: string; feeUsd: number };
    };
    expect(body.payment.mode).toBe("mock");
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0]!.sourceUrl).toMatch(/^https:\/\/react\.dev\//);
    expect(body.results[0]!.license).toBe("CC-BY-4.0");
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

    const db = openDb(dbPath);
    expect(getWallet(db, AGENT_A)?.reputation).toBeGreaterThan(0);
    expect(getWallet(db, AGENT_B)?.reputation).toBeGreaterThan(0);
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
});
