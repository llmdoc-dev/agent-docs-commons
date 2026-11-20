import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { openMigratedDb } from "../src/sqlite.ts";
import { createApp } from "../src/app.ts";

const AGENT_A = "BDkdaa5aHZZooaG2dRRMzBNe33PzTqZoZyQaBxVrdzi7";
const AGENT_B = "BtWTZbXWs9Zbpawja3NxC6Rj4E1HGPF8P6y1fvX9nXJx";
const PAYER = "3fNDHnonA7xWsvLFkMoBmvSMCwcfvgjvT9PNdP6hLtGr";

async function probeFacilitator(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/supported`, {
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    const hasDevnet = text.includes("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    return {
      ok: res.ok && hasDevnet,
      detail: `HTTP ${res.status}; solana devnet advertised: ${hasDevnet}`,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "unreachable" };
  }
}

async function main(): Promise<void> {
  const facilitator = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";
  const fac = await probeFacilitator(facilitator);
  const paymentModeUsed: "mock" = "mock";
  const reason = fac.ok
    ? "The x402.org facilitator is reachable and advertises Solana devnet, but this demo does not hold a payer private key or devnet USDC, so settlement uses a mock X-PAYMENT header. The 402 challenge is still the real Solana-devnet shape."
    : `Facilitator probe failed (${fac.detail}). Settlement is mocked. The 402 challenge still names Solana devnet.`;

  const dir = mkdtempSync(join(tmpdir(), "docs-commons-demo-"));
  const dbPath = join(dir, "commons.sqlite");
  const logPath = join(process.cwd(), "data", "demo-output.json");
  mkdirSync(join(process.cwd(), "data"), { recursive: true });

  const cfg = loadConfig({
    port: 0,
    paymentMode: paymentModeUsed,
    dbPath,
    publicBaseUrl: "http://127.0.0.1",
  });
  const db = await openMigratedDb(dbPath);
  const app = await createApp({ ...cfg, publicBaseUrl: "http://127.0.0.1" }, db);
  const base = "http://127.0.0.1";

  const steps: { name: string; status: number; body: unknown }[] = [];

  async function call(
    name: string,
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: unknown }> {
    const res = await app.handle(new Request(`${base}${path}`, init));
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
    const step = { name, status: res.status, body };
    steps.push(step);
    console.log(`\n=== ${name} → HTTP ${res.status} ===`);
    console.log(typeof body === "string" ? body : JSON.stringify(body, null, 2));
    return step;
  }

  console.log("Agent Docs Commons — end-to-end demo");
  console.log(`Facilitator: ${facilitator} (${fac.detail})`);
  console.log(`Payment settlement used: ${paymentModeUsed}`);
  console.log(reason);

  await call("1. health", "/health");
  await call("2. llms.txt (first 400 chars)", "/llms.txt");
  const llms = steps.at(-1)!;
  if (typeof llms.body === "string") llms.body = llms.body.slice(0, 400) + "\n…";

  await call("3. lookup without payment (expect 402)", "/v1/docs/lookup?library=react&q=useState");

  await call("4. paid lookup (mock x402) for React useState", "/v1/docs/lookup?library=react&q=useState", {
    headers: { "X-PAYMENT": `mock:${PAYER}` },
  });

  const contributed = await call("5. agent A contributes a React hook snippet", "/v1/contribute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wallet: AGENT_A,
      library: "react",
      libraryVersion: "19.0.0",
      title: "Custom Hooks must start with use",
      body: "A custom Hook is a JavaScript function whose name starts with use. It can call other Hooks. Share stateful logic with a custom Hook instead of duplicating useState and useEffect across components. This short note cites the official Hooks FAQ and the built-in Hook rules.",
      sourceUrl: "https://react.dev/learn/reusing-logic-with-custom-hooks",
      license: "CC-BY-4.0",
      retrievedAt: "2026-11-20",
    }),
  });

  const snippetId =
    contributed.body && typeof contributed.body === "object" && "snippet" in contributed.body
      ? (contributed.body as { snippet: { id: string } }).snippet.id
      : "";

  await call("6. agent A tries to verify their own snippet (expect 400)", "/v1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: AGENT_A, snippetId, verdict: "confirm" }),
  });

  await call("7. agent B verifies agent A's snippet", "/v1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wallet: AGENT_B,
      snippetId,
      verdict: "confirm",
      note: "Matches the official custom Hooks guidance.",
    }),
  });

  await call(
    "8. paid lookup that should include the contributed custom-hooks fact",
    "/v1/docs/lookup?library=react&q=custom%20hooks%20use",
    { headers: { "X-PAYMENT": `mock:${PAYER}` } },
  );

  await call("9. payout dry-run (no USDC sent)", "/v1/payouts/dry-run", { method: "POST" });

  await call("10. agent A wallet (reputation + pending payout)", `/v1/wallets/${AGENT_A}`);
  await call("11. agent B wallet (reputation + pending payout)", `/v1/wallets/${AGENT_B}`);

  const report = {
    paymentSettlement: paymentModeUsed,
    facilitator: { url: facilitator, ...fac },
    reason,
    base,
    steps,
  };
  writeFileSync(logPath, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${logPath}`);
  console.log("Done. No USDC was sent. No mainnet was used. No user wallet keys were involved.");

}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
