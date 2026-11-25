import { acceptedAssetsPublic, assetSymbolForMint, type AppConfig } from "./config.ts";
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
  compactJsonResponse,
  extractPaymentHeader,
  jsonResponse,
  lookupResource,
  paymentCorsHeaders,
  requirePayment,
  textResponse,
} from "./payment.ts";
import { checkSnippetFields, checkSourceUrl, contentHash, isSolanaAddress } from "./quality.ts";
import { rankSnippets, selectForAnswer } from "./search.ts";
import { buildOpenApi } from "./openapi.ts";
import { buildLlmsTxt } from "./llms.ts";
import {
  browseHtml,
  findCatalogLibrary,
  landingHtml,
  libraryPageHtml,
  loadPublicCatalog,
  notFoundLibraryHtml,
  referralsHtml,
} from "./catalog.ts";
import { serverCard } from "./server-card.ts";
import { BAZAAR_DESCRIPTION, MEASURED, REFERRAL_TEXT, SERVICE_PITCH } from "./descriptions.ts";
import { handleMcp } from "./mcp-http.ts";
import { handleCheckRoutes } from "./check/routes.ts";
import { getServiceByDocsLibrary } from "./check/seed.ts";
import { seedIfEmpty, seedOfficialSnippets } from "./seed-data.ts";
import { lookupResourceUrl, robotsTxt, sitemapXml } from "./bazaar.ts";
import {
  REFERRAL_CAP_MICROS,
  bindReferrerOnFirstPaidLookup,
  claimReferral,
  getAttribution,
  listAttributionsForReferrer,
  markFirstPaidAndAccrual,
  readOfferedReferrer,
  referralBalances,
  referralWindowActive,
  unlockHeldReferralLines,
} from "./referrals.ts";
import {
  FREE_LOOKUPS_PER_IP_PER_UTC_DAY,
  NEW_IDENTITY_FREE_LOOKUPS_FIRST_DAY,
  TRIAL_SHORT_TEXT,
  consumeFreeLookup,
} from "./trial.ts";
import { buildStats, walletForConfig } from "./stats.ts";

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
    return textResponse(200, "text/html; charset=utf-8", landingHtml(cfg, await loadPublicCatalog(db)));
  }
  if (method === "GET" && path === "/browse") {
    return textResponse(200, "text/html; charset=utf-8", browseHtml(cfg, await loadPublicCatalog(db)));
  }
  if (method === "GET" && path.startsWith("/browse/")) {
    let slug = path.slice("/browse/".length).toLowerCase();
    try {
      slug = decodeURIComponent(slug);
    } catch {
      /* keep the raw slug */
    }
    const catalog = await loadPublicCatalog(db);
    const lib = findCatalogLibrary(catalog, slug);
    if (!lib) return textResponse(404, "text/html; charset=utf-8", notFoundLibraryHtml(cfg, slug, catalog));
    return textResponse(200, "text/html; charset=utf-8", libraryPageHtml(cfg, lib, catalog, getServiceByDocsLibrary(lib.library)?.slug), {
      "Cache-Control": "public, max-age=300",
    });
  }
  if (method === "GET" && (path === "/.well-known/mcp/server-card.json" || path === "/.well-known/mcp.json")) {
    return jsonResponse(200, serverCard(cfg));
  }
  if (method === "GET" && path === "/referrals") {
    return textResponse(200, "text/html; charset=utf-8", referralsHtml(cfg));
  }
  const checkRes = await handleCheckRoutes(cfg, db, req, url, path, method);
  if (checkRes) return checkRes;
  if (method === "GET" && path === "/health") {
    return jsonResponse(200, {
      ok: true,
      service: "llmdocs",
      paymentMode: cfg.paymentMode,
      network: cfg.network,
      asset: cfg.asset,
      assets: acceptedAssetsPublic(cfg),
      payTo: cfg.payTo,
      priceLookupUsd: cfg.priceLookupUsd,
      facilitator: cfg.facilitatorUrl,
    });
  }
  if (method === "GET" && path === "/llms.txt") {
    return textResponse(200, "text/plain; charset=utf-8", buildLlmsTxt(cfg, await loadPublicCatalog(db)));
  }
  if (method === "GET" && path === "/robots.txt") {
    return textResponse(200, "text/plain; charset=utf-8", robotsTxt(cfg.publicBaseUrl));
  }
  if (method === "GET" && path === "/sitemap.xml") {
    return textResponse(200, "application/xml; charset=utf-8", sitemapXml(cfg.publicBaseUrl, await loadPublicCatalog(db)));
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
  if (method === "GET" && path === "/v1/stats") {
    const wallet = await walletForConfig(cfg);
    const stats = await buildStats(db, cfg, wallet);
    return jsonResponse(200, stats, { "Cache-Control": "no-store" });
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
  if (method === "POST" && path === "/v1/referrals/claim") {
    return claimReferralRoute(db, req);
  }
  if (method === "GET" && path === "/v1/referrals") {
    return referralStatusRoute(db, url);
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
    name: "llmdocs.dev",
    description: SERVICE_PITCH,
    resource: challenge.resource,
    accepts: challenge.accepts,
    extensions: challenge.extensions,
    facilitator: challenge.facilitator,
    discovery: {
      openapi: `${cfg.publicBaseUrl}/openapi.json`,
      llms: `${cfg.publicBaseUrl}/llms.txt`,
      mcp: `${cfg.publicBaseUrl}/mcp`,
      mcpServerCard: `${cfg.publicBaseUrl}/.well-known/mcp/server-card.json`,
      libraries: `${cfg.publicBaseUrl}/v1/docs/libraries`,
      browse: `${cfg.publicBaseUrl}/browse`,
      check: `${cfg.publicBaseUrl}/check`,
      checkServices: `${cfg.publicBaseUrl}/v1/check/services`,
      sitemap: `${cfg.publicBaseUrl}/sitemap.xml`,
    },
    answerSize: {
      tokenizer: MEASURED.tokenizer,
      measuredOn: MEASURED.date,
      sampleQueries: MEASURED.sampleQueries,
      mcpTextMedianTokens: MEASURED.mcpAnswerMedianTokens,
      mcpTextRange: MEASURED.mcpAnswerRange,
      httpJsonMedianTokens: MEASURED.httpJsonMedianTokens,
    },
    freeTrial: {
      firstDayLookups: NEW_IDENTITY_FREE_LOOKUPS_FIRST_DAY,
      dailyLookupsAfter: FREE_LOOKUPS_PER_IP_PER_UTC_DAY,
      countedBy: "hashed client IP (IPv6 by /64), UTC day",
      probesAlways402: "HEAD, and GET without q",
    },
    referrals: {
      share: 0.1,
      windowDays: 180,
      capUsdPerReferredAgent: 10,
      paidFrom: "platform share (contributors are not reduced)",
      howTo: "Add ref=<your Solana address> to a new agent's lookups, send X-Llmdocs-Ref, or POST /v1/referrals/claim",
      summary: REFERRAL_TEXT,
      rules: `${cfg.publicBaseUrl}/referrals`,
    },
    paidEndpoints: [
      {
        method: "GET",
        path: "/v1/docs/lookup",
        priceUsd: cfg.priceLookupUsd,
        amount: challenge.accepts[0]!.amount,
        asset: cfg.asset,
        assets: challenge.accepts.map((a) => ({ symbol: a.extra.name, asset: a.asset, amount: a.amount })),
        network: cfg.network,
        payTo: cfg.payTo,
      },
      {
        method: "GET",
        path: "/v1/check/preflight",
        priceUsd: cfg.priceLookupUsd,
        network: cfg.network,
        payTo: cfg.payTo,
        note: "Shares the docs lookup free daily cap and price. Also /v1/check/status, /v1/check/pricing, /v1/check/package.",
      },
    ],
    acceptedAssets: acceptedAssetsPublic(cfg),
    assetNote:
      "Every asset is priced at $1, so a lookup costs 10000 atomic units (6 decimals) of whichever you pick. USDC is listed first and is the default. Contributor, owner, and referral payouts are paid in USDC.",
    origin: url.origin,
  });
}

async function lookupDocs(cfg: AppConfig, db: Db, req: Request, url: URL): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim();
  const library = (url.searchParams.get("library") ?? "").trim() || undefined;
  const version = (url.searchParams.get("version") ?? "").trim() || undefined;
  // Require payment even when `q` is missing so facilitator discovery probes
  // to the canonical resource URL see HTTP 402, not 400. HEAD is also always
  // paid so liveness monitors keep seeing 402. Free trial applies only to
  // unpaid GET requests that include q.
  const resourceUrl = lookupResourceUrl(cfg.publicBaseUrl);
  const hasPayment = Boolean(extractPaymentHeader(req));
  const discoveryProbe = req.method === "HEAD" || !q;

  if (!hasPayment && !discoveryProbe) {
    const trial = await consumeFreeLookup(db, req);
    if (trial.ok) {
      return fulfillLookup(cfg, db, req, url, {
        q,
        library,
        version,
        kind: "free",
        remainingFreeLookups: trial.remaining,
        responseHeaders: paymentCorsHeaders(),
      });
    }
  }

  const gate = await requirePayment(cfg, req, {
    resourceUrl,
    description: q ? `Documentation lookup: ${q}` : BAZAAR_DESCRIPTION,
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
        asset: gate.payment.asset ?? cfg.asset,
      });
    }
  }

  return fulfillLookup(cfg, db, req, url, {
    q,
    library,
    version,
    kind: "paid",
    payment: gate.payment,
    responseHeaders: gate.responseHeaders,
  });
}

async function fulfillLookup(
  cfg: AppConfig,
  db: Db,
  req: Request,
  url: URL,
  opts: {
    q: string;
    library?: string;
    version?: string;
    kind: "free" | "paid";
    payment?: { mode: "mock" | "x402"; payerWallet: string | null; transaction?: string | null; alreadySettled?: boolean; asset?: string };
    remainingFreeLookups?: number;
    responseHeaders: Record<string, string>;
  },
): Promise<Response> {
  let catalog = await listSnippets(db, opts.library);
  if (opts.version) {
    catalog = catalog.filter(
      (s) =>
        s.libraryVersion === opts.version ||
        s.libraryVersion.startsWith(`${opts.version}.`) ||
        s.libraryVersion.startsWith(opts.version!),
    );
  }
  const ranked = rankSnippets(catalog, opts.q, opts.library);
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

  if (opts.kind === "free") {
    await recordQuery(db, {
      payerWallet: null,
      library: opts.library ?? null,
      question: opts.q,
      feeMicros: 0,
      paymentMode: "free",
      snippetIds: payoutFacts.map((f) => f.snippetId),
      settlementTx: null,
    });
    return compactJsonResponse(
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
          split: "Free trial lookup. No fee was collected or split.",
          lines: [],
        },
        payment: {
          mode: "free",
          feeUsd: 0,
          remainingFreeLookups: opts.remainingFreeLookups ?? 0,
          trial: TRIAL_SHORT_TEXT,
          payerWallet: null,
          transaction: null,
        },
      },
      opts.responseHeaders,
    );
  }

  const payment = opts.payment!;
  const offered = readOfferedReferrer(req, url);
  let referrerWallet: string | undefined;
  let capRemaining: number | undefined;
  if (payment.payerWallet && !payment.alreadySettled) {
    const attr = await bindReferrerOnFirstPaidLookup(db, {
      payerWallet: payment.payerWallet,
      offeredReferrer: offered,
    });
    if (attr && referralWindowActive(attr, new Date())) {
      const remaining = REFERRAL_CAP_MICROS - attr.earnedMicros;
      if (remaining > 0) {
        referrerWallet = attr.referrerWallet;
        capRemaining = remaining;
      }
    }
  }

  const payoutLines = splitQueryFee(
    cfg.priceLookupUsd,
    payoutFacts,
    referrerWallet ? { referrerWallet, referralCapRemainingMicros: capRemaining } : {},
  );
  if (!payment.alreadySettled) {
    const queryId = await recordQuery(db, {
      payerWallet: payment.payerWallet,
      library: opts.library ?? null,
      question: opts.q,
      feeMicros: usdToMicros(cfg.priceLookupUsd),
      paymentMode: payment.mode,
      snippetIds: payoutFacts.map((f) => f.snippetId),
      settlementTx: payment.transaction ?? null,
      paymentAsset: payment.asset ?? cfg.asset,
    });
    await insertLedgerLines(db, queryId, payoutLines, payment.asset ?? cfg.asset);
    if (payment.payerWallet) {
      const referralLine = payoutLines.find((l) => l.role === "referral");
      await markFirstPaidAndAccrual(db, {
        payerWallet: payment.payerWallet,
        amountMicros: referralLine?.amountMicros ?? 0,
      });
      await unlockHeldReferralLines(db);
    }
    await applyUsageReputation(db, payoutFacts);
  }

  const referred = payoutLines.some((l) => l.role === "referral");
  const split = referred
    ? "60% contributor pool (70% submitter / 30% verifiers per fact; house-seeded submitter cut goes to the treasury), 10% referrer, 20% platform, 10% reserve"
    : "60% contributor pool (70% submitter / 30% verifiers per fact; house-seeded submitter cut goes to the treasury), 30% platform, 10% reserve";

  return compactJsonResponse(
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
        split,
        lines: payoutLines.map((l) => ({
          wallet: l.wallet,
          role: l.role,
          snippetId: l.snippetId,
          amountUsd: formatUsd(l.amountMicros),
          houseOwned: Boolean(l.houseOwned),
        })),
      },
      payment: {
        mode: payment.mode,
        feeUsd: cfg.priceLookupUsd,
        asset: assetSymbolForMint(payment.asset ?? cfg.asset),
        assetMint: payment.asset ?? cfg.asset,
        payerWallet: payment.payerWallet,
        transaction: payment.transaction ?? null,
      },
    },
    opts.responseHeaders,
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

async function claimReferralRoute(db: Db, req: Request): Promise<Response> {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body) return jsonResponse(400, { error: "json_body_required" });
  const result = await claimReferral(db, {
    payerWallet: String(body.payerWallet ?? body.payer ?? ""),
    referrerWallet: String(body.referrerWallet ?? body.referrer ?? body.ref ?? ""),
  });
  if (!result.ok) return jsonResponse(result.status, { error: result.error });
  return jsonResponse(result.created ? 201 : 200, {
    attribution: result.attribution,
    created: result.created,
    note: "First touch sticks. Referral rewards accrue on later paid lookups, stay held until the payer has spent $0.10, and then have a 7-day hold. The cut comes from the owner share, not from contributors.",
  });
}

async function referralStatusRoute(db: Db, url: URL): Promise<Response> {
  const wallet = (url.searchParams.get("wallet") ?? "").trim();
  if (!isSolanaAddress(wallet)) return jsonResponse(400, { error: "wallet must be a Solana address" });
  await unlockHeldReferralLines(db);
  const attributedTo = await getAttribution(db, wallet);
  const asReferrer = await listAttributionsForReferrer(db, wallet);
  const balances = await referralBalances(db, wallet);
  return jsonResponse(200, {
    wallet,
    attributedTo,
    referredAgents: asReferrer,
    balances: {
      heldUsd: formatUsd(balances.heldMicros),
      pendingUsd: formatUsd(balances.pendingMicros),
      paidUsd: formatUsd(balances.paidMicros),
    },
    rules: {
      share: "10% of a referred payer's paid lookup spend, taken from the owner share",
      windowDays: 180,
      capUsd: 10,
      unlockSpendUsd: 0.1,
      holdDays: 7,
    },
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
