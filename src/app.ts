import type { AppConfig } from "./config.ts";
import type { Db } from "./db.ts";
import {
  bumpReputation,
  findSettledPayment,
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
  recordSettledPayment,
  setSnippetStatus,
  standingConfirmers,
} from "./db.ts";
import { formatUsd, usdToMicros } from "./money.ts";
import { isInternalWallet, splitQueryFee, type FactForPayout } from "./payout.ts";
import {
  buildChallenge,
  jsonResponse,
  lookupResource,
  paymentCorsHeaders,
  requirePayment,
  textResponse,
  type SettledPayment,
} from "./payment.ts";
import { checkSnippetFields, checkSourceUrl, contentHash, isSolanaAddress } from "./quality.ts";
import { rankSnippets, selectForAnswer } from "./search.ts";
import { buildOpenApi } from "./openapi.ts";
import { buildLlmsTxt } from "./llms.ts";
import { landingHtml } from "./landing.ts";
import { handleMcp } from "./mcp-http.ts";
import { seedIfEmpty, seedOfficialSnippets } from "./seed-data.ts";
import { lookupResourceUrl, robotsTxt, sitemapXml } from "./bazaar.ts";

export { seedIfEmpty, seedOfficialSnippets };

export type App = {
  cfg: AppConfig;
  db: Db;
  handle: (req: Request) => Promise<Response>;
};

export async function createApp(cfg: AppConfig, db: Db): Promise<App> {
  await seedOfficialSnippets(db);

  const handle = async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: paymentCorsHeaders() });
    }
    const url = new URL(req.url);
    try {
      const res = await route(cfg, db, req, url);
      return res ?? jsonResponse(404, { error: "not_found", path: url.pathname });
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal_error";
      return jsonResponse(500, { error: "internal_error", message });
    }
  };

  return { cfg, db, handle };
}

async function route(cfg: AppConfig, db: Db, req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/") {
    return textResponse(200, "text/html; charset=utf-8", landingHtml(cfg));
  }
  if (method === "GET" && path === "/health") {
    return jsonResponse(200, {
      ok: true,
      service: "llmdocs",
      paymentMode: cfg.paymentMode,
      network: cfg.network,
      asset: cfg.asset,
      payTo: cfg.payTo,
      priceLookupUsd: cfg.priceLookupUsd,
      facilitator: cfg.facilitatorUrl,
    });
  }
  if (method === "GET" && path === "/llms.txt") {
    return textResponse(200, "text/plain; charset=utf-8", buildLlmsTxt(cfg));
  }
  if (method === "GET" && path === "/robots.txt") {
    return textResponse(200, "text/plain; charset=utf-8", robotsTxt(cfg.publicBaseUrl));
  }
  if (method === "GET" && path === "/sitemap.xml") {
    return textResponse(200, "application/xml; charset=utf-8", sitemapXml(cfg.publicBaseUrl));
  }
  if (method === "GET" && (path === "/openapi.json" || path === "/openapi")) {
    return jsonResponse(200, buildOpenApi(cfg));
  }
  if (method === "GET" && path === "/.well-known/x402") {
    return wellKnownX402(cfg, url);
  }
  if (path === "/mcp") {
    return handleMcp(cfg, db, req, url, (inner) =>
      route(cfg, db, inner, new URL(inner.url)).then((r) => r ?? jsonResponse(404, { error: "not_found" })),
    );
  }
  if (method === "GET" && path === "/v1/docs/libraries") {
    return jsonResponse(200, { libraries: await listLibraries(db) });
  }
  if ((method === "GET" || method === "HEAD") && path === "/v1/docs/lookup") {
    return lookupDocs(cfg, db, req, url);
  }
  if (method === "GET" && path.startsWith("/v1/records/")) {
    const id = path.slice("/v1/records/".length);
    const snippet = await getSnippet(db, id);
    if (!snippet) return jsonResponse(404, { error: "snippet_not_found" });
    return jsonResponse(200, {
      ...publicSnippet(snippet),
      verifications: await listVerifications(db, snippet.id),
    });
  }
  if (method === "POST" && path === "/v1/contribute") {
    return contribute(cfg, db, req);
  }
  if (method === "POST" && path === "/v1/verify") {
    return verify(db, req);
  }
  if (method === "GET" && path.startsWith("/v1/wallets/")) {
    const address = path.slice("/v1/wallets/".length);
    const wallet = await getWallet(db, address);
    if (!wallet) return jsonResponse(404, { error: "wallet_not_found" });
    return jsonResponse(200, wallet);
  }
  if (method === "GET" && path === "/v1/payouts/preview") {
    return jsonResponse(200, await dryRunPayload(db));
  }
  if (method === "POST" && path === "/v1/payouts/dry-run") {
    const payload = await dryRunPayload(db);
    const runId = await recordDryRun(db, payload);
    return jsonResponse(200, { runId, ...payload });
  }
  return null;
}

async function wellKnownX402(cfg: AppConfig, url: URL): Promise<Response> {
  const lookup = `${cfg.publicBaseUrl}/v1/docs/lookup`;
  const challenge = await buildChallenge(
    cfg,
    lookupResource(cfg, lookup),
    cfg.priceLookupUsd,
  );
  return jsonResponse(200, {
    x402Version: 2,
    resource: challenge.resource,
    accepts: challenge.accepts,
    facilitator: challenge.facilitator,
    discovery: {
      openapi: `${cfg.publicBaseUrl}/openapi.json`,
      llms: `${cfg.publicBaseUrl}/llms.txt`,
      mcp: `${cfg.publicBaseUrl}/mcp`,
      libraries: `${cfg.publicBaseUrl}/v1/docs/libraries`,
    },
    paidEndpoints: [
      {
        method: "GET",
        path: "/v1/docs/lookup",
        priceUsd: cfg.priceLookupUsd,
        amount: challenge.accepts[0]!.amount,
        asset: cfg.asset,
        network: cfg.network,
        payTo: cfg.payTo,
      },
    ],
    origin: url.origin,
  });
}

async function lookupDocs(cfg: AppConfig, db: Db, req: Request, url: URL): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim();
  const library = (url.searchParams.get("library") ?? "").trim() || undefined;
  const version = (url.searchParams.get("version") ?? "").trim() || undefined;
  // Require payment even when `q` is missing so facilitator discovery probes
  // to the canonical resource URL see HTTP 402, not 400.
  const resourceUrl = lookupResourceUrl(cfg.publicBaseUrl);
  const gate = await requirePayment(cfg, req, {
    resourceUrl,
    description: q ? `Documentation lookup: ${q}` : "Documentation lookup",
    priceUsd: cfg.priceLookupUsd,
  });
  if (!gate.ok) return gate.response;
  if (!q) return jsonResponse(400, { error: "q is required" }, gate.responseHeaders);
  if (req.method === "HEAD") {
    return new Response(null, { status: 200, headers: gate.responseHeaders });
  }

  if (gate.payment.mode === "x402" && gate.payment.paymentId) {
    const prior = await findSettledPayment(db, gate.payment.paymentId);
    if (prior) {
      // Same signed payment replayed: fulfill without writing a second ledger.
      gate.payment.alreadySettled = true;
    } else {
      await recordSettledPayment(db, {
        id: gate.payment.paymentId,
        payerWallet: gate.payment.payerWallet,
        transactionSig: gate.payment.transaction ?? null,
      });
    }
  }

  let catalog = await listSnippets(db, library);
  if (version) {
    catalog = catalog.filter(
      (s) => s.libraryVersion === version || s.libraryVersion.startsWith(`${version}.`) || s.libraryVersion.startsWith(version),
    );
  }
  const ranked = rankSnippets(catalog, q, library);
  const accepted = selectForAnswer(ranked);
  const payoutFacts: FactForPayout[] = [];
  for (const r of accepted) {
    const snippet = r.snippet;
    payoutFacts.push({
      snippetId: snippet.id,
      submitterWallet: snippet.submitterWallet,
      verifierWallets: await standingConfirmers(db, snippet.id),
      houseOwned: snippet.houseOwned,
    });
  }

  let payoutLines = splitQueryFee(cfg.priceLookupUsd, payoutFacts);
  if (!gate.payment.alreadySettled) {
    const queryId = await recordQuery(db, {
      payerWallet: gate.payment.payerWallet,
      library: library ?? null,
      question: q,
      feeMicros: usdToMicros(cfg.priceLookupUsd),
      paymentMode: gate.payment.mode,
      snippetIds: payoutFacts.map((f) => f.snippetId),
      settlementTx: gate.payment.transaction ?? null,
    });
    await insertLedgerLines(db, queryId, payoutLines);
    await applyUsageReputation(db, payoutFacts);
  }

  return jsonResponse(
    200,
    {
      results: accepted.map((r) => ({
        ...publicSnippet(r.snippet),
        score: r.score,
      })),
      attribution: payoutFacts.map((f) => ({
        snippetId: f.snippetId,
        submitterWallet: f.submitterWallet,
        verifierWallets: f.verifierWallets,
        houseOwned: Boolean(f.houseOwned),
      })),
      payout: {
        split:
          "60% contributor pool (70% submitter / 30% verifiers per fact; house-seeded submitter cut goes to the treasury), 30% platform, 10% reserve",
        lines: payoutLines.map((l) => ({
          wallet: l.wallet,
          role: l.role,
          snippetId: l.snippetId,
          amountUsd: formatUsd(l.amountMicros),
          houseOwned: Boolean(l.houseOwned),
        })),
      },
      payment: {
        mode: gate.payment.mode,
        feeUsd: cfg.priceLookupUsd,
        payerWallet: gate.payment.payerWallet,
        transaction: gate.payment.transaction ?? null,
      },
    },
    gate.responseHeaders,
  );
}

async function applyUsageReputation(db: Db, facts: FactForPayout[]): Promise<void> {
  for (const fact of facts) {
    if (!isInternalWallet(fact.submitterWallet) && !fact.houseOwned) {
      await bumpReputation(db, fact.submitterWallet, "fact_used_submitter");
    }
    for (const v of fact.verifierWallets) {
      if (!isInternalWallet(v)) await bumpReputation(db, v, "fact_used_verifier");
    }
  }
}

async function contribute(cfg: AppConfig, db: Db, req: Request): Promise<Response> {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body) return jsonResponse(400, { error: "json_body_required" });
  const input = {
    wallet: String(body.wallet ?? ""),
    library: String(body.library ?? ""),
    libraryVersion: String(body.libraryVersion ?? ""),
    title: String(body.title ?? ""),
    body: String(body.body ?? ""),
    sourceUrl: String(body.sourceUrl ?? ""),
    license: String(body.license ?? "unknown"),
    retrievedAt: String(body.retrievedAt ?? new Date().toISOString().slice(0, 10)),
  };
  const fields = checkSnippetFields(input);
  if (!fields.ok) return jsonResponse(400, { error: fields.error });
  const source = checkSourceUrl(input.sourceUrl);
  if (!source.ok) return jsonResponse(400, { error: source.error });
  const hash = contentHash({
    library: input.library,
    libraryVersion: input.libraryVersion,
    title: input.title.trim(),
    body: input.body.trim(),
    sourceUrl: source.normalizedUrl,
  });
  if (await getSnippetByHash(db, hash)) {
    return jsonResponse(409, { error: "duplicate_snippet" });
  }
  const snippet = await insertSnippet(db, {
    library: input.library,
    libraryVersion: input.libraryVersion,
    title: input.title.trim(),
    body: input.body.trim(),
    sourceUrl: source.normalizedUrl,
    license: input.license,
    contentHash: hash,
    submitterWallet: input.wallet,
    houseOwned: false,
    status: "pending",
    retrievedAt: input.retrievedAt,
  });
  return jsonResponse(201, {
    snippet: publicSnippet(snippet),
    note: "Pending until another agent verifies it. Pending facts can appear in search but do not enter the payout pool.",
  });
}

async function verify(db: Db, req: Request): Promise<Response> {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body) return jsonResponse(400, { error: "json_body_required" });
  const wallet = String(body.wallet ?? "");
  const snippetId = String(body.snippetId ?? "");
  const verdictRaw = String(body.verdict ?? "");
  const note = body.note == null ? undefined : String(body.note);
  if (!isSolanaAddress(wallet)) return jsonResponse(400, { error: "wallet must be a Solana address" });
  if (!snippetId) return jsonResponse(400, { error: "snippetId is required" });
  if (verdictRaw !== "confirm" && verdictRaw !== "stale" && verdictRaw !== "reject") {
    return jsonResponse(400, { error: "verdict must be confirm, stale, or reject" });
  }
  const snippet = await getSnippet(db, snippetId);
  if (!snippet) return jsonResponse(404, { error: "snippet_not_found" });
  if (wallet === snippet.submitterWallet) {
    return jsonResponse(400, { error: "you cannot verify your own submission" });
  }
  const already = (await listVerifications(db, snippetId)).some((v) => v.verifierWallet === wallet);
  if (already) return jsonResponse(409, { error: "already_verified_by_this_wallet" });

  const verification = await insertVerification(db, {
    snippetId,
    verifierWallet: wallet,
    verdict: verdictRaw,
    note,
  });

  let status = snippet.status;
  if (verdictRaw === "confirm") {
    if (snippet.status !== "rejected") {
      status = "verified";
      await setSnippetStatus(db, snippetId, "verified");
      if (!isInternalWallet(snippet.submitterWallet)) {
        await bumpReputation(db, snippet.submitterWallet, "contribution_verified");
      }
      await bumpReputation(db, wallet, "verification_accepted");
    }
  } else {
    status = "rejected";
    await setSnippetStatus(db, snippetId, "rejected");
    if (!isInternalWallet(snippet.submitterWallet)) {
      await bumpReputation(db, snippet.submitterWallet, "snippet_rejected");
    }
  }

  return jsonResponse(200, {
    verification,
    snippet: { ...publicSnippet((await getSnippet(db, snippetId))!), status },
  });
}

export async function dryRunPayload(db: Db): Promise<{
  mode: "dry_run";
  sent: false;
  totals: Awaited<ReturnType<typeof ledgerSummary>>;
  wouldPay: Array<{ wallet: string; amountUsd: string; roles: string[]; entryCount: number }>;
  note: string;
}> {
  const wouldPay = (await pendingPayouts(db)).map((p) => ({
    wallet: p.wallet,
    amountUsd: formatUsd(p.amountMicros),
    roles: p.roles,
    entryCount: p.entryCount,
  }));
  return {
    mode: "dry_run",
    sent: false,
    totals: await ledgerSummary(db),
    wouldPay,
    note: "Dry-run only. No USDC is sent. Owner and contributor payouts are a separate box-side job.",
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
  houseOwned?: boolean;
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
    houseOwned: Boolean(snippet.houseOwned),
    status: snippet.status,
    retrievedAt: snippet.retrievedAt,
    createdAt: snippet.createdAt,
  };
}

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
