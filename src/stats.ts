import type { AppConfig } from "./config.ts";
import { isMainnetNetwork, MAINNET_PAY_TO, USDC_MINT_MAINNET } from "./config.ts";
import type { Db } from "./db.ts";
import { formatUsd } from "./money.ts";

/** America/Phoenix is UTC-7 year-round (no daylight saving). */
export const STATS_TIMEZONE = "America/Phoenix";
const PHOENIX_OFFSET = "-7 hours";

/** SQLite expression that buckets an ISO timestamp into an America/Phoenix calendar day. */
export const PHOENIX_DAY_SQL = `date(replace(substr(created_at, 1, 19), 'T', ' '), '${PHOENIX_OFFSET}')`;

const SOLANA_RPCS = [
  "https://solana-rpc.publicnode.com",
  "https://rpc.ankr.com/solana",
  "https://api.mainnet-beta.solana.com",
];
const WALLET_CACHE_MS = 60_000;

export type StatsDirectory = {
  name: string;
  url: string;
  status: string;
  note: string;
};

export const DIRECTORY_LISTINGS: StatsDirectory[] = [
  {
    name: "PayAI Bazaar",
    url: "https://docs.payai.network/x402/facilitators/bazaar",
    status: "listed",
    note: "Cataloged through the PayAI facilitator after a verified payment.",
  },
  {
    name: "x402dash",
    url: "https://x402dash.com",
    status: "listed",
    note: "Registered. Their checker may re-probe every 30 minutes.",
  },
  {
    name: "Agent402",
    url: "https://agent402.tools",
    status: "listed",
    note: "Registered the origin https://llmdocs.dev.",
  },
  {
    name: "Official MCP Registry",
    url: "https://registry.modelcontextprotocol.io/v0/servers?search=llmdocs",
    status: "listed",
    note: "Published under the dev.llmdocs namespace.",
  },
  {
    name: "llmstxt.site",
    url: "https://llmstxt.site",
    status: "submitted",
    note: "Free submission accepted.",
  },
  {
    name: "directory.llmstxt.cloud",
    url: "https://directory.llmstxt.cloud",
    status: "waitlist",
    note: "On the free review waitlist; they say 1–3 months.",
  },
];

export type WalletBalances = {
  address: string;
  sol: number | null;
  usdc: number | null;
  source: string | null;
  fetchedAt: string | null;
  error: string | null;
};

export type StatsPayload = {
  generatedAt: string;
  timezone: typeof STATS_TIMEZONE;
  priceLookupUsd: string;
  lookups: {
    total: number;
    paid: number;
    free: number;
    uniquePayers: number;
    uniqueFreeIdentities: number;
    revenueUsdc: string;
    ownerShareUsdc: string;
    contributorShareUsdc: string;
    reserveShareUsdc: string;
    referralShareUsdc: string;
    byDay: Array<{ day: string; paid: number; free: number; revenueUsdc: string }>;
    topLibraries: Array<{ library: string; total: number; paid: number; free: number }>;
    topQueries: Array<{ library: string; question: string; total: number; paid: number; free: number }>;
  };
  ledger: {
    buckets: Array<{
      bucket: string;
      pendingUsdc: string;
      paidUsdc: string;
      heldUsdc: string;
    }>;
  };
  contributions: {
    libraries: number;
    snippets: number;
    houseVerified: number;
    submitted: number;
    verified: number;
    pending: number;
    rejected: number;
    verifications: number;
  };
  referrals: {
    claims: number;
    attributedPayers: number;
    earnedUsdc: string;
    heldUsdc: string;
    pendingUsdc: string;
    paidUsdc: string;
  };
  payouts: {
    liveRuns: number;
    dryRuns: number;
    onchainSentUsdc: string;
    runs: Array<{
      id: string;
      mode: string;
      at: string;
      transferTotalUsdc: string;
      onchainTransfers: Array<{ amountUsdc: string; tx: string; solscan: string }>;
      internalSettledUsdc: string;
      carriedUsdc: string;
    }>;
  };
  wallet: WalletBalances;
  directories: StatsDirectory[];
};

function num(row: Record<string, unknown> | undefined, key: string): number {
  return Number(row?.[key] ?? 0);
}

function paidModeSql(alias = "payment_mode"): string {
  return `${alias} != 'free'`;
}

function bucketFor(role: string, wallet: string): string | null {
  if (role === "referral" || wallet === "referrer") return "referrers";
  if (role === "reserve" || wallet === "reserve") return "reserve";
  if (role === "platform" || wallet === "platform") return "owner";
  if (role === "house" || wallet === "house" || wallet === "treasury" || wallet === "platform_house") {
    return "treasury";
  }
  if (role === "submitter" || role === "verifier") return "contributors";
  return "other";
}

function emptyBucket(name: string) {
  return { bucket: name, pendingMicros: 0, paidMicros: 0, heldMicros: 0 };
}

function parsePayoutSummary(raw: string): {
  transferTotalUsdc: string;
  onchainTransfers: Array<{ amountUsdc: string; tx: string; solscan: string }>;
  internalSettledUsdc: string;
  carriedUsdc: string;
} {
  const empty = {
    transferTotalUsdc: formatUsd(0),
    onchainTransfers: [] as Array<{ amountUsdc: string; tx: string; solscan: string }>,
    internalSettledUsdc: formatUsd(0),
    carriedUsdc: formatUsd(0),
  };
  try {
    const summary = JSON.parse(raw) as {
      plan?: {
        transferTotalUsd?: string;
        transfers?: Array<{ amountUsd?: string; tx?: string | null }>;
        internals?: Array<{ amountUsd?: string }>;
        carries?: Array<{ amountUsd?: string }>;
      };
      results?: Array<{ kind?: string; amountUsd?: string; tx?: string | null }>;
    };
    const plan = summary.plan ?? {};
    const results = summary.results ?? [];
    const transfers = (plan.transfers ?? [])
      .concat(results.filter((r) => r.kind === "transfer" || r.tx))
      .filter((t) => typeof t.tx === "string" && t.tx.length > 0)
      .map((t) => ({
        amountUsdc: String(t.amountUsd ?? formatUsd(0)),
        tx: String(t.tx),
        solscan: `https://solscan.io/tx/${t.tx}`,
      }));
    // Dedup by tx signature.
    const seen = new Set<string>();
    const onchainTransfers = transfers.filter((t) => {
      if (seen.has(t.tx)) return false;
      seen.add(t.tx);
      return true;
    });
    const internalSettled = (plan.internals ?? []).reduce((s, i) => s + Number(i.amountUsd ?? 0), 0);
    const carried = (plan.carries ?? []).reduce((s, i) => s + Number(i.amountUsd ?? 0), 0);
    const transferTotal =
      plan.transferTotalUsd ??
      onchainTransfers.reduce((s, t) => s + Number(t.amountUsdc), 0).toFixed(6);
    return {
      transferTotalUsdc: Number(transferTotal).toFixed(6),
      onchainTransfers,
      internalSettledUsdc: internalSettled.toFixed(6),
      carriedUsdc: carried.toFixed(6),
    };
  } catch {
    return empty;
  }
}

export async function buildStats(db: Db, cfg: AppConfig, wallet: WalletBalances): Promise<StatsPayload> {
  const lookupTotals = await db.get(
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN ${paidModeSql()} THEN 1 ELSE 0 END), 0) AS paid,
       COALESCE(SUM(CASE WHEN payment_mode = 'free' THEN 1 ELSE 0 END), 0) AS free,
       COALESCE(SUM(CASE WHEN ${paidModeSql()} THEN fee_micros ELSE 0 END), 0) AS revenue_micros
     FROM queries`,
  );
  const uniquePayers = num(
    await db.get(
      `SELECT COUNT(DISTINCT payer_wallet) AS n
       FROM queries
       WHERE ${paidModeSql()} AND payer_wallet IS NOT NULL AND payer_wallet != ''`,
    ),
    "n",
  );
  const uniqueFreeIdentities = num(
    await db.get(`SELECT COUNT(DISTINCT identity_key) AS n FROM free_lookup_usage`),
    "n",
  );

  const byDayRows = await db.all(
    `SELECT ${PHOENIX_DAY_SQL} AS day,
            COALESCE(SUM(CASE WHEN ${paidModeSql()} THEN 1 ELSE 0 END), 0) AS paid,
            COALESCE(SUM(CASE WHEN payment_mode = 'free' THEN 1 ELSE 0 END), 0) AS free,
            COALESCE(SUM(CASE WHEN ${paidModeSql()} THEN fee_micros ELSE 0 END), 0) AS revenue_micros
     FROM queries
     GROUP BY day
     ORDER BY day ASC`,
  );

  const libraryRows = await db.all(
    `SELECT COALESCE(library, '(none)') AS library,
            COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN ${paidModeSql()} THEN 1 ELSE 0 END), 0) AS paid,
            COALESCE(SUM(CASE WHEN payment_mode = 'free' THEN 1 ELSE 0 END), 0) AS free
     FROM queries
     GROUP BY library
     ORDER BY total DESC, library ASC
     LIMIT 20`,
  );

  const queryRows = await db.all(
    `SELECT COALESCE(library, '(none)') AS library,
            question,
            COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN ${paidModeSql()} THEN 1 ELSE 0 END), 0) AS paid,
            COALESCE(SUM(CASE WHEN payment_mode = 'free' THEN 1 ELSE 0 END), 0) AS free
     FROM queries
     GROUP BY library, question
     ORDER BY total DESC, library ASC, question ASC
     LIMIT 20`,
  );

  const shareRows = await db.all(
    `SELECT
       CASE
         WHEN role = 'referral' OR wallet = 'referrer' THEN 'referrers'
         WHEN role = 'reserve' OR wallet = 'reserve' THEN 'reserve'
         WHEN role = 'platform' OR wallet = 'platform' THEN 'owner'
         WHEN role = 'house' OR wallet IN ('house', 'treasury') THEN 'treasury'
         WHEN role IN ('submitter', 'verifier') THEN 'contributors'
         ELSE 'other'
       END AS bucket,
       COALESCE(SUM(amount_micros), 0) AS micros
     FROM ledger_entries
     GROUP BY bucket`,
  );
  const shareMicros: Record<string, number> = {
    owner: 0,
    contributors: 0,
    treasury: 0,
    reserve: 0,
    referrers: 0,
  };
  for (const row of shareRows) {
    const bucket = String(row.bucket);
    shareMicros[bucket] = (shareMicros[bucket] ?? 0) + num(row, "micros");
  }

  const ledgerRows = await db.all(
    `SELECT role, wallet, status, amount_micros FROM ledger_entries`,
  );
  const buckets: Record<string, { bucket: string; pendingMicros: number; paidMicros: number; heldMicros: number }> = {
    contributors: emptyBucket("contributors"),
    treasury: emptyBucket("treasury"),
    owner: emptyBucket("owner"),
    reserve: emptyBucket("reserve"),
    referrers: emptyBucket("referrers"),
  };
  for (const row of ledgerRows) {
    const bucket = bucketFor(String(row.role), String(row.wallet));
    if (!bucket || bucket === "other") continue;
    const target = buckets[bucket]!;
    const amount = num(row, "amount_micros");
    const status = String(row.status);
    if (status === "held") target.heldMicros += amount;
    else if (status === "pending") target.pendingMicros += amount;
    else target.paidMicros += amount;
  }

  const snippetRow = await db.get(
    `SELECT
       COUNT(*) AS snippets,
       COUNT(DISTINCT library) AS libraries,
       COALESCE(SUM(CASE WHEN house_owned = 1 AND status = 'verified' THEN 1 ELSE 0 END), 0) AS house_verified,
       COALESCE(SUM(CASE WHEN house_owned = 0 THEN 1 ELSE 0 END), 0) AS submitted,
       COALESCE(SUM(CASE WHEN house_owned = 0 AND status = 'verified' THEN 1 ELSE 0 END), 0) AS verified,
       COALESCE(SUM(CASE WHEN house_owned = 0 AND status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
       COALESCE(SUM(CASE WHEN house_owned = 0 AND status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected
     FROM snippets`,
  );
  const verifications = num(await db.get(`SELECT COUNT(*) AS n FROM verifications`), "n");

  const referralRow = await db.get(
    `SELECT
       COUNT(*) AS claims,
       COALESCE(SUM(CASE WHEN first_paid_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS attributed,
       COALESCE(SUM(earned_micros), 0) AS earned_micros
     FROM referral_attributions`,
  );

  const payoutRows = await db.all(`SELECT id, mode, created_at, summary_json FROM payout_runs ORDER BY created_at DESC`);
  const runs = payoutRows.map((row) => {
    const parsed = parsePayoutSummary(String(row.summary_json ?? "{}"));
    return {
      id: String(row.id),
      mode: String(row.mode),
      at: String(row.created_at),
      ...parsed,
    };
  });
  const onchainSentUsdc = runs
    .filter((r) => r.mode === "live")
    .reduce((s, r) => s + Number(r.transferTotalUsdc), 0)
    .toFixed(6);

  return {
    generatedAt: new Date().toISOString(),
    timezone: STATS_TIMEZONE,
    priceLookupUsd: cfg.priceLookupUsd.toFixed(2),
    lookups: {
      total: num(lookupTotals, "total"),
      paid: num(lookupTotals, "paid"),
      free: num(lookupTotals, "free"),
      uniquePayers,
      uniqueFreeIdentities,
      revenueUsdc: formatUsd(num(lookupTotals, "revenue_micros")),
      ownerShareUsdc: formatUsd(shareMicros.owner ?? 0),
      contributorShareUsdc: formatUsd((shareMicros.contributors ?? 0) + (shareMicros.treasury ?? 0)),
      reserveShareUsdc: formatUsd(shareMicros.reserve ?? 0),
      referralShareUsdc: formatUsd(shareMicros.referrers ?? 0),
      byDay: byDayRows.map((row) => ({
        day: String(row.day),
        paid: num(row, "paid"),
        free: num(row, "free"),
        revenueUsdc: formatUsd(num(row, "revenue_micros")),
      })),
      topLibraries: libraryRows.map((row) => ({
        library: String(row.library),
        total: num(row, "total"),
        paid: num(row, "paid"),
        free: num(row, "free"),
      })),
      topQueries: queryRows.map((row) => ({
        library: String(row.library),
        question: String(row.question),
        total: num(row, "total"),
        paid: num(row, "paid"),
        free: num(row, "free"),
      })),
    },
    ledger: {
      buckets: ["contributors", "treasury", "owner", "reserve", "referrers"].map((name) => {
        const b = buckets[name]!;
        return {
          bucket: name,
          pendingUsdc: formatUsd(b.pendingMicros),
          paidUsdc: formatUsd(b.paidMicros),
          heldUsdc: formatUsd(b.heldMicros),
        };
      }),
    },
    contributions: {
      libraries: num(snippetRow, "libraries"),
      snippets: num(snippetRow, "snippets"),
      houseVerified: num(snippetRow, "house_verified"),
      submitted: num(snippetRow, "submitted"),
      verified: num(snippetRow, "verified"),
      pending: num(snippetRow, "pending"),
      rejected: num(snippetRow, "rejected"),
      verifications,
    },
    referrals: {
      claims: num(referralRow, "claims"),
      attributedPayers: num(referralRow, "attributed"),
      earnedUsdc: formatUsd(num(referralRow, "earned_micros")),
      heldUsdc: formatUsd(buckets.referrers!.heldMicros),
      pendingUsdc: formatUsd(buckets.referrers!.pendingMicros),
      paidUsdc: formatUsd(buckets.referrers!.paidMicros),
    },
    payouts: {
      liveRuns: runs.filter((r) => r.mode === "live").length,
      dryRuns: runs.filter((r) => r.mode === "dry_run" || r.mode === "dry-run").length,
      onchainSentUsdc,
      runs,
    },
    wallet,
    directories: DIRECTORY_LISTINGS,
  };
}

export function skippedWallet(address: string, reason: string): WalletBalances {
  return { address, sol: null, usdc: null, source: null, fetchedAt: null, error: reason };
}

let walletCache: { key: string; value: WalletBalances; at: number } | null = null;

async function fetchBalancesFromRpc(rpc: string, address: string): Promise<WalletBalances> {
  const signal = AbortSignal.timeout(4000);
  const headers = { "Content-Type": "application/json", "User-Agent": "llmdocs.dev/stats" };
  const [solRes, tokenRes] = await Promise.all([
    fetch(rpc, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] }),
    }),
    fetch(rpc, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "getTokenAccountsByOwner",
        params: [address, { mint: USDC_MINT_MAINNET }, { encoding: "jsonParsed" }],
      }),
    }),
  ]);
  if (!solRes.ok || !tokenRes.ok) {
    return skippedWallet(address, `rpc_http_${solRes.status}_${tokenRes.status}`);
  }
  const solBody = (await solRes.json()) as { result?: { value?: number }; error?: { message?: string } };
  const tokenBody = (await tokenRes.json()) as {
    result?: { value?: Array<{ account?: { data?: { parsed?: { info?: { tokenAmount?: { amount: string; decimals: number } } } } } }> };
    error?: { message?: string };
  };
  if (solBody.error || tokenBody.error) {
    return skippedWallet(address, solBody.error?.message ?? tokenBody.error?.message ?? "rpc_error");
  }
  const lamports = solBody.result?.value ?? 0;
  let usdc = 0;
  for (const account of tokenBody.result?.value ?? []) {
    const tokenAmount = account.account?.data?.parsed?.info?.tokenAmount;
    if (!tokenAmount) continue;
    usdc += Number(tokenAmount.amount) / 10 ** Number(tokenAmount.decimals);
  }
  return {
    address,
    sol: lamports / 1_000_000_000,
    usdc,
    source: rpc,
    fetchedAt: new Date().toISOString(),
    error: null,
  };
}

export async function fetchMainWalletBalances(address: string): Promise<WalletBalances> {
  const now = Date.now();
  if (walletCache && walletCache.key === address && now - walletCache.at < WALLET_CACHE_MS) {
    return walletCache.value;
  }
  const errors: string[] = [];
  for (const rpc of SOLANA_RPCS) {
    try {
      const value = await fetchBalancesFromRpc(rpc, address);
      if (value.error) {
        errors.push(`${rpc}: ${value.error}`);
        continue;
      }
      walletCache = { key: address, value, at: now };
      return value;
    } catch (err) {
      const message = err instanceof Error ? err.message : "rpc_unavailable";
      errors.push(`${rpc}: ${message}`);
    }
  }
  return skippedWallet(address, errors.join("; ") || "rpc_unavailable");
}

export async function walletForConfig(cfg: AppConfig): Promise<WalletBalances> {
  const address = cfg.payTo || MAINNET_PAY_TO;
  if (!isMainnetNetwork(cfg.network) && address !== MAINNET_PAY_TO) {
    return skippedWallet(address, "skipped_in_non_mainnet");
  }
  return fetchMainWalletBalances(address);
}

const SENSITIVE_KEY = /payer_wallet|identity_key|content_hash|secret|private_key|mnemonic/i;

/** True when a stats payload (or its JSON) appears to include a sensitive field. */
export function statsContainsSensitiveKeys(payload: unknown): boolean {
  const json = JSON.stringify(payload);
  return SENSITIVE_KEY.test(json);
}
