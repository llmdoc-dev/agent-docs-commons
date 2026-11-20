import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.ts";
import {
  bumpReputation,
  getSnippet,
  getSnippetByHash,
  getWallet,
  insertLedgerLines,
  insertSnippet,
  insertVerification,
  ledgerSummary,
  listLibraries,
  listSnippets,
  listVerifications,
  pendingPayouts,
  recordDryRun,
  recordQuery,
  setSnippetStatus,
  standingConfirmers,
} from "./db.ts";
import { formatUsd, usdToMicros } from "./money.ts";
import { PLATFORM_WALLET, splitQueryFee, type FactForPayout } from "./payout.ts";
import { requirePayment } from "./payment.ts";
import { checkSnippetFields, checkSourceUrl, contentHash, isSolanaAddress } from "./quality.ts";
import { rankSnippets, selectForAnswer } from "./search.ts";
import { buildOpenApi } from "./openapi.ts";
import { buildLlmsTxt } from "./llms.ts";

const SEED_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "seed", "snippets.json");

export type App = {
  cfg: AppConfig;
  db: DatabaseSync;
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
};

type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  cfg: AppConfig;
  db: DatabaseSync;
};

export function createApp(cfg: AppConfig, db: DatabaseSync): App {
  seedIfEmpty(db);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const host = req.headers.host ?? `127.0.0.1:${cfg.port}`;
    const url = new URL(req.url ?? "/", `http://${host}`);
    const ctx: Ctx = { req, res, url, cfg, db };
    try {
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        cors(res);
        res.end();
        return;
      }
      const routed = await route(ctx);
      if (!routed) {
        json(res, 404, { error: "not_found", path: url.pathname });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal_error";
      json(res, 500, { error: "internal_error", message });
    }
  };

  return { cfg, db, handle };
}

export function seedIfEmpty(db: DatabaseSync): number {
  if (listSnippets(db).length > 0) return 0;
  const raw = JSON.parse(readFileSync(SEED_PATH, "utf8")) as Array<{
    id: string;
    library: string;
    libraryVersion: string;
    title: string;
    body: string;
    sourceUrl: string;
    license: string;
    retrievedAt: string;
  }>;
  let n = 0;
  for (const row of raw) {
    const hash = contentHash(row);
    if (getSnippetByHash(db, hash)) continue;
    insertSnippet(db, {
      id: row.id,
      library: row.library,
      libraryVersion: row.libraryVersion,
      title: row.title,
      body: row.body,
      sourceUrl: row.sourceUrl,
      license: row.license,
      contentHash: hash,
      submitterWallet: PLATFORM_WALLET,
      status: "verified",
      retrievedAt: row.retrievedAt,
    });
    n += 1;
  }
  return n;
}

async function route(ctx: Ctx): Promise<boolean> {
  const { req, url } = ctx;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/health") {
    json(ctx.res, 200, {
      ok: true,
      paymentMode: ctx.cfg.paymentMode,
      network: ctx.cfg.network,
      payTo: ctx.cfg.payTo,
      facilitator: ctx.cfg.facilitatorUrl,
      priceLookupUsd: ctx.cfg.priceLookupUsd,
      note: "Solana devnet / mock only. No mainnet. payTo is a throwaway address, not a user wallet.",
    });
    return true;
  }
  if (method === "GET" && path === "/llms.txt") {
    text(ctx.res, 200, "text/markdown; charset=utf-8", buildLlmsTxt(ctx.cfg));
    return true;
  }
  if (method === "GET" && (path === "/openapi.json" || path === "/openapi")) {
    json(ctx.res, 200, buildOpenApi(ctx.cfg));
    return true;
  }
  if (method === "GET" && path === "/v1/docs/libraries") {
    json(ctx.res, 200, { libraries: listLibraries(ctx.db) });
    return true;
  }
  if (method === "GET" && path === "/v1/docs/lookup") {
    await lookupDocs(ctx);
    return true;
  }
  if (method === "GET" && path.startsWith("/v1/records/")) {
    const id = path.slice("/v1/records/".length);
    const snippet = getSnippet(ctx.db, id);
    if (!snippet) {
      json(ctx.res, 404, { error: "not_found" });
      return true;
    }
    json(ctx.res, 200, {
      ...publicSnippet(snippet),
      verifications: listVerifications(ctx.db, snippet.id),
    });
    return true;
  }
  if (method === "POST" && path === "/v1/contribute") {
    await contribute(ctx);
    return true;
  }
  if (method === "POST" && path === "/v1/verify") {
    await verify(ctx);
    return true;
  }
  if (method === "GET" && path.startsWith("/v1/wallets/")) {
    const address = path.slice("/v1/wallets/".length);
    const row = getWallet(ctx.db, address);
    const pending = pendingPayouts(ctx.db).find((p) => p.wallet === address);
    json(ctx.res, 200, {
      address,
      wallet: row,
      pendingPayoutUsd: pending ? formatUsd(pending.amountMicros) : "0.000000",
    });
    return true;
  }
  if (method === "GET" && path === "/v1/payouts/preview") {
    json(ctx.res, 200, dryRunPayload(ctx.db));
    return true;
  }
  if (method === "POST" && path === "/v1/payouts/dry-run") {
    const summary = dryRunPayload(ctx.db);
    const runId = recordDryRun(ctx.db, summary);
    json(ctx.res, 200, { runId, ...summary });
    return true;
  }
  return false;
}

async function lookupDocs(ctx: Ctx): Promise<void> {
  const library = ctx.url.searchParams.get("library") ?? undefined;
  const question = ctx.url.searchParams.get("q") ?? ctx.url.searchParams.get("query") ?? "";
  const version = ctx.url.searchParams.get("version") ?? undefined;
  if (!question.trim()) {
    json(ctx.res, 400, { error: "q is required" });
    return;
  }
  const paid = requirePayment(ctx.cfg, ctx.req, ctx.res, {
    resource: `${ctx.cfg.publicBaseUrl}/v1/docs/lookup`,
    description: "Lookup a short, cited, versioned documentation snippet",
    priceUsd: ctx.cfg.priceLookupUsd,
  });
  if (!paid) return;

  let snippets = listSnippets(ctx.db, library);
  if (version) {
    const exact = snippets.filter((s) => s.libraryVersion === version || s.libraryVersion.startsWith(version));
    if (exact.length > 0) snippets = exact;
  }
  const ranked = rankSnippets(snippets, question, library);
  const selected = selectForAnswer(ranked, 3);
  const used = selected.map((r) => r.snippet);

  const payoutFacts: FactForPayout[] = [];
  for (const snippet of used) {
    if (snippet.status !== "verified") continue;
    payoutFacts.push({
      snippetId: snippet.id,
      submitterWallet: snippet.submitterWallet,
      verifierWallets: standingConfirmers(ctx.db, snippet.id),
    });
  }

  const feeMicros = usdToMicros(ctx.cfg.priceLookupUsd);
  const queryId = recordQuery(ctx.db, {
    payerWallet: paid.payerWallet,
    library: library ?? null,
    question,
    feeMicros,
    paymentMode: paid.mode,
    snippetIds: used.map((s) => s.id),
  });
  const lines = splitQueryFee(ctx.cfg.priceLookupUsd, payoutFacts);
  insertLedgerLines(ctx.db, queryId, lines);
  applyUsageReputation(ctx.db, payoutFacts);

  json(ctx.res, 200, {
    queryId,
    payment: { mode: paid.mode, payerWallet: paid.payerWallet, feeUsd: ctx.cfg.priceLookupUsd },
    freshness: {
      guarantee: "Answers cite sourceUrl and retrievedAt. Seed docs are static excerpts; contributed facts include their own retrievedAt.",
    },
    results: selected.map((r) => ({
      ...publicSnippet(r.snippet),
      score: r.score,
      eligibleForPayout: r.snippet.status === "verified",
    })),
    attribution: payoutFacts.map((f) => ({
      snippetId: f.snippetId,
      submitterWallet: f.submitterWallet,
      verifierWallets: f.verifierWallets,
    })),
    payout: {
      split: "60% contributor pool (70% submitter / 30% verifiers per fact), 30% platform, 10% reserve",
      lines: lines.map((l) => ({
        wallet: l.wallet,
        role: l.role,
        snippetId: l.snippetId,
        amountUsd: formatUsd(l.amountMicros),
      })),
    },
  });
}

function applyUsageReputation(db: DatabaseSync, facts: FactForPayout[]): void {
  for (const fact of facts) {
    if (fact.submitterWallet !== PLATFORM_WALLET) {
      bumpReputation(db, fact.submitterWallet, "fact_used_submitter");
    }
    for (const v of fact.verifierWallets) {
      bumpReputation(db, v, "fact_used_verifier");
    }
  }
}

async function contribute(ctx: Ctx): Promise<void> {
  const body = (await readJson(ctx.req)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    json(ctx.res, 400, { error: "JSON body required" });
    return;
  }
  const input = {
    wallet: String(body.wallet ?? ""),
    library: String(body.library ?? "").toLowerCase(),
    libraryVersion: String(body.libraryVersion ?? body.library_version ?? ""),
    title: String(body.title ?? ""),
    body: String(body.body ?? ""),
    sourceUrl: String(body.sourceUrl ?? body.source_url ?? ""),
    license: String(body.license ?? "unknown"),
    retrievedAt: String(body.retrievedAt ?? body.retrieved_at ?? new Date().toISOString()),
  };
  const checked = checkSnippetFields(input);
  if (!checked.ok) {
    json(ctx.res, 400, { error: checked.error });
    return;
  }
  const source = checkSourceUrl(input.sourceUrl);
  if (!source.ok) {
    json(ctx.res, 400, { error: source.error });
    return;
  }
  const hash = contentHash({ ...input, sourceUrl: source.normalizedUrl });
  const existing = getSnippetByHash(ctx.db, hash);
  if (existing) {
    json(ctx.res, 409, { error: "duplicate_snippet", snippetId: existing.id });
    return;
  }
  const snippet = insertSnippet(ctx.db, {
    library: input.library,
    libraryVersion: input.libraryVersion,
    title: input.title.trim(),
    body: input.body.trim(),
    sourceUrl: source.normalizedUrl,
    license: input.license,
    contentHash: hash,
    submitterWallet: input.wallet,
    status: "pending",
    retrievedAt: input.retrievedAt,
  });
  json(ctx.res, 201, {
    snippet: publicSnippet(snippet),
    note: "Pending until another agent verifies it. Pending facts can appear in search but do not enter the payout pool.",
  });
}

async function verify(ctx: Ctx): Promise<void> {
  const body = (await readJson(ctx.req)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    json(ctx.res, 400, { error: "JSON body required" });
    return;
  }
  const wallet = String(body.wallet ?? "");
  const snippetId = String(body.snippetId ?? body.snippet_id ?? "");
  const verdictRaw = String(body.verdict ?? "");
  const note = body.note == null ? undefined : String(body.note);
  if (!isSolanaAddress(wallet)) {
    json(ctx.res, 400, { error: "wallet must be a Solana address" });
    return;
  }
  if (verdictRaw !== "confirm" && verdictRaw !== "stale" && verdictRaw !== "reject") {
    json(ctx.res, 400, { error: "verdict must be confirm, stale, or reject" });
    return;
  }
  const snippet = getSnippet(ctx.db, snippetId);
  if (!snippet) {
    json(ctx.res, 404, { error: "snippet_not_found" });
    return;
  }
  if (wallet === snippet.submitterWallet) {
    json(ctx.res, 400, { error: "you cannot verify your own submission" });
    return;
  }
  const already = listVerifications(ctx.db, snippetId).some((v) => v.verifierWallet === wallet);
  if (already) {
    json(ctx.res, 409, { error: "already_verified_by_this_wallet" });
    return;
  }
  const verification = insertVerification(ctx.db, {
    snippetId,
    verifierWallet: wallet,
    verdict: verdictRaw,
    note,
  });

  let status = snippet.status;
  if (verdictRaw === "confirm") {
    if (snippet.status !== "rejected") {
      status = "verified";
      setSnippetStatus(ctx.db, snippetId, "verified");
      if (snippet.submitterWallet !== PLATFORM_WALLET) {
        bumpReputation(ctx.db, snippet.submitterWallet, "contribution_verified");
      }
      bumpReputation(ctx.db, wallet, "verification_accepted");
    }
  } else {
    status = "rejected";
    setSnippetStatus(ctx.db, snippetId, "rejected");
    if (snippet.submitterWallet !== PLATFORM_WALLET) {
      bumpReputation(ctx.db, snippet.submitterWallet, "snippet_rejected");
    }
  }

  json(ctx.res, 200, {
    verification,
    snippet: { ...publicSnippet(getSnippet(ctx.db, snippetId)!), status },
  });
}

export function dryRunPayload(db: DatabaseSync): {
  mode: "dry_run";
  sent: false;
  totals: ReturnType<typeof ledgerSummary>;
  wouldPay: Array<{ wallet: string; amountUsd: string; roles: string[]; entryCount: number }>;
  note: string;
} {
  const wouldPay = pendingPayouts(db).map((p) => ({
    wallet: p.wallet,
    amountUsd: formatUsd(p.amountMicros),
    roles: p.roles,
    entryCount: p.entryCount,
  }));
  return {
    mode: "dry_run",
    sent: false,
    totals: ledgerSummary(db),
    wouldPay,
    note: "No USDC is sent. This is a dry run of the payout job. Live settlement needs a mainnet receiving wallet, hosting, and a real facilitator — not enabled here.",
  };
}

function publicSnippet(snippet: {
  id: string;
  library: string;
  libraryVersion: string;
  title: string;
  body: string;
  sourceUrl: string;
  license: string;
  contentHash: string;
  submitterWallet: string;
  status: string;
  retrievedAt: string;
  createdAt: string;
}) {
  return {
    id: snippet.id,
    library: snippet.library,
    libraryVersion: snippet.libraryVersion,
    title: snippet.title,
    body: snippet.body,
    sourceUrl: snippet.sourceUrl,
    license: snippet.license,
    contentHash: snippet.contentHash,
    submitterWallet: snippet.submitterWallet,
    status: snippet.status,
    retrievedAt: snippet.retrievedAt,
    createdAt: snippet.createdAt,
  };
}

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  cors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body, null, 2));
}

function text(res: ServerResponse, status: number, type: string, body: string): void {
  cors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return null;
  return JSON.parse(raw);
}
