/**
 * Measure the token size of typical lookup responses (o200k_base via js-tiktoken when available,
 * else chars/4). Usage: npx tsx scripts/measure-tokens.ts [js-tiktoken module path]
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { openMigratedDb } from "../src/sqlite.ts";
import { createApp } from "../src/app.ts";
import { renderLookupText } from "../src/mcp-http.ts";

const QUERIES: Array<[string, string]> = [
  ["react", "useState"],
  ["nextjs", "app router"],
  ["express", "middleware"],
  ["zod", "safeParse"],
  ["fastapi", "dependency injection"],
  ["stripe", "webhook signature"],
  ["openai", "responses api"],
  ["x402", "PAYMENT-SIGNATURE header"],
  ["solana-kit", "send and confirm transaction"],
  ["mcp-typescript", "registerTool"],
  ["mcp-python", "MCPServer"],
  ["hono", "validator"],
  ["prisma", "transaction"],
  ["pandas", "groupby"],
  ["docker", "multi-stage build"],
];

async function main() {
  let encode: (s: string) => number = (s) => Math.ceil(s.length / 4);
  let method = "chars/4 estimate";
  const mod = process.argv[2];
  if (mod) {
    const t = await import(mod);
    const enc = t.getEncoding("o200k_base");
    encode = (s) => enc.encode(s).length;
    method = "o200k_base tokenizer";
  }
  const dbPath = join(mkdtempSync(join(tmpdir(), "llmdocs-measure-")), "m.sqlite");
  const cfg = loadConfig({ port: 0, paymentMode: "mock", dbPath, publicBaseUrl: "https://llmdocs.dev" });
  const app = await createApp(cfg, await openMigratedDb(dbPath));
  const whole: number[] = [];
  const answers: number[] = [];
  const mcp: number[] = [];
  for (const [library, q] of QUERIES) {
    const url = `https://llmdocs.dev/v1/docs/lookup?library=${encodeURIComponent(library)}&q=${encodeURIComponent(q)}`;
    const res = await app.handle(new Request(url, { headers: { "X-PAYMENT": "mock:3fNDHnonA7xWsvLFkMoBmvSMCwcfvgjvT9PNdP6hLtGr" } }));
    const text = await res.text();
    const body = JSON.parse(text) as { results: Array<{ title: string; body: string; sourceUrl: string; libraryVersion: string }> };
    const answer = body.results.map((r) => `${r.title}\n${r.body}\n${r.sourceUrl} (${r.libraryVersion})`).join("\n\n");
    whole.push(encode(text));
    mcp.push(encode(renderLookupText(res.status, text, "https://llmdocs.dev")));
    answers.push(encode(answer));
    console.log(`${library.padEnd(15)} ${q.padEnd(32)} results=${body.results.length} response=${encode(text)} answer=${encode(answer)} mcpText=${mcp[mcp.length - 1]}`);
  }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  console.log(`\nmethod: ${method}`);
  console.log(`median full response tokens: ${median(whole)} (min ${Math.min(...whole)}, max ${Math.max(...whole)})`);
  console.log(`median MCP docs_lookup text tokens: ${median(mcp)} (min ${Math.min(...mcp)}, max ${Math.max(...mcp)})`);
  console.log(`median answer-only tokens (titles+bodies+sources): ${median(answers)} (min ${Math.min(...answers)}, max ${Math.max(...answers)})`);
}

main();
