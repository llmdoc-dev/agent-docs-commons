/**
 * Gather llmdocs.dev /v1/stats and Cloudflare Analytics into one JSON file
 * so the usage tracker Page can be refreshed without any in-page network.
 *
 * Usage (from the repo root): npm run tracker-snapshot
 * Writes: .tracker-snapshot.json
 *
 * Reads the local Wrangler OAuth token if present and never prints it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATS_URL = process.env.STATS_URL ?? "https://llmdocs.dev/v1/stats";
const ZONE_ID = process.env.CF_ZONE_ID ?? "91683f5ee516bc113f26f5b7e5d20212";
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID ?? "ed6d5bfd153f65bf6c2445c97f878a98";
const SCRIPT_NAME = process.env.CF_SCRIPT_NAME ?? "llmdocs";
const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";
const OUTPUT = process.env.TRACKER_SNAPSHOT_PATH ?? join(process.cwd(), ".tracker-snapshot.json");
const TZ = "America/Phoenix";
const UA = "llmdocs.dev/tracker-snapshot";

export type TrafficHour = {
  at: string;
  utc: string;
  requests: number;
  uniques: number;
  threats: number;
};

export type TrafficDay = {
  date: string;
  requests: number;
  uniques: number;
  threats: number;
};

export type TrafficSummary = {
  zoneRequests: number;
  zoneUniquesPeak: number;
  hours: TrafficHour[];
  days: TrafficDay[];
  workerRequests: number;
  workerErrors: number;
};

function formatPhoenix(iso: string | Date): string {
  const date = iso instanceof Date ? iso : new Date(iso);
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
  return `${label} America/Phoenix`;
}

function readWranglerToken(): string | null {
  const path = join(homedir(), ".config/.wrangler/config/default.toml");
  try {
    const text = readFileSync(path, "utf8");
    const match = text.match(/^oauth_token\s*=\s*"([^"]+)"/m);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

const MAIN_WALLET = "EAJiExxSG5K3G4nnqeCZd1DmWMaK6CmisXi53yYa5SJJ";
const MAIN_USDC_ATA = "HRrDNF7wbaX7yZEG52vzTt6JR4JDvPiUZB4wkn4pgBYB";
const MAIN_PYUSD_ATA = "DYKf6yrv1aPrZKVpBZ8M5CFwUEirxxwxHWrgiphpCYZi";
const MAIN_USDT_ATA = "GLgbqRQBS5gL4A6putusVqtoWARRqjCb381xmQaqs3uz";
const BOX_RPC = "https://api.mainnet-beta.solana.com";

async function fetchWalletFromPublicRpc(address: string): Promise<{
  address: string;
  sol: number;
  usdc: number;
  pyusd: number | null;
  usdt: number | null;
  source: string;
  fetchedAt: string;
  error: null;
}> {
  const headers = { "Content-Type": "application/json", "User-Agent": UA };
  const solRes = await fetch(BOX_RPC, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] }),
  });
  const tokenRes = await fetch(BOX_RPC, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "getMultipleAccounts",
      params: [address === MAIN_WALLET ? [MAIN_USDC_ATA, MAIN_PYUSD_ATA, MAIN_USDT_ATA] : [address], { encoding: "jsonParsed" }],
    }),
  });
  if (!solRes.ok || !tokenRes.ok) {
    throw new Error(`box_rpc_http_${solRes.status}_${tokenRes.status}`);
  }
  const solBody = (await solRes.json()) as { result?: { value?: number }; error?: { message?: string } };
  type Parsed = { data?: { parsed?: { info?: { tokenAmount?: { amount: string; decimals: number } } } } } | null;
  const tokenBody = (await tokenRes.json()) as {
    result?: { value?: Parsed[] };
    error?: { message?: string };
  };
  if (solBody.error || tokenBody.error) {
    throw new Error(solBody.error?.message ?? tokenBody.error?.message ?? "box_rpc_error");
  }
  const lamports = solBody.result?.value ?? 0;
  const values = tokenBody.result?.value ?? [];
  const amountOf = (v: Parsed | undefined): number => {
    const t = v?.data?.parsed?.info?.tokenAmount;
    return t ? Number(t.amount) / 10 ** Number(t.decimals) : 0;
  };
  return {
    address,
    sol: lamports / 1_000_000_000,
    usdc: amountOf(values[0]),
    pyusd: address === MAIN_WALLET ? amountOf(values[1]) : null,
    usdt: address === MAIN_WALLET ? amountOf(values[2]) : null,
    source: BOX_RPC,
    fetchedAt: new Date().toISOString(),
    error: null,
  };
}

async function fetchSiteStats(): Promise<unknown> {
  const res = await fetch(STATS_URL, {
    headers: { Accept: "application/json", "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`GET ${STATS_URL} failed: HTTP ${res.status}`);
  return res.json();
}

async function fetchCloudflareTraffic(token: string): Promise<unknown> {
  const until = new Date();
  const since = new Date(until.getTime() - 14 * 24 * 60 * 60 * 1000);
  const sinceHour = new Date(until.getTime() - 48 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const untilHour = until.toISOString().replace(/\.\d{3}Z$/, "Z");
  const query = `
    query ($zone: String!, $account: String!, $since: Date!, $until: Date!, $sinceHour: Time!, $untilHour: Time!) {
      viewer {
        zones(filter: { zoneTag: $zone }) {
          httpRequests1dGroups(limit: 20, orderBy: [date_ASC], filter: { date_geq: $since, date_leq: $until }) {
            dimensions { date }
            sum { requests cachedRequests threats bytes }
            uniq { uniques }
          }
          httpRequests1hGroups(limit: 72, orderBy: [datetime_ASC], filter: { datetime_geq: $sinceHour, datetime_leq: $untilHour }) {
            dimensions { datetime }
            sum { requests cachedRequests threats bytes }
            uniq { uniques }
          }
        }
        accounts(filter: { accountTag: $account }) {
          workersInvocationsAdaptive(limit: 100, filter: {
            datetime_geq: $sinceHour,
            datetime_leq: $untilHour,
            scriptName: "${SCRIPT_NAME}"
          }) {
            dimensions { datetimeHour scriptName }
            sum { requests errors subrequests }
          }
        }
      }
    }
  `;
  const res = await fetch(GRAPHQL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": UA,
    },
    body: JSON.stringify({
      query,
      variables: {
        zone: ZONE_ID,
        account: ACCOUNT_ID,
        since: since.toISOString().slice(0, 10),
        until: until.toISOString().slice(0, 10),
        sinceHour,
        untilHour,
      },
    }),
  });
  const body = (await res.json()) as { data?: unknown; errors?: Array<{ message?: string }> };
  if (!res.ok || body.errors?.length) {
    const message = body.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    throw new Error(`Cloudflare GraphQL failed: ${message}`);
  }
  return body.data;
}

function summarizeTraffic(data: unknown): TrafficSummary {
  const root = data as {
    viewer?: {
      zones?: Array<{
        httpRequests1dGroups?: Array<{
          dimensions?: { date?: string };
          sum?: { requests?: number; threats?: number };
          uniq?: { uniques?: number };
        }>;
        httpRequests1hGroups?: Array<{
          dimensions?: { datetime?: string };
          sum?: { requests?: number; threats?: number };
          uniq?: { uniques?: number };
        }>;
      }>;
      accounts?: Array<{
        workersInvocationsAdaptive?: Array<{
          sum?: { requests?: number; errors?: number };
        }>;
      }>;
    };
  };
  const zone = root.viewer?.zones?.[0] ?? {};
  const days = (zone.httpRequests1dGroups ?? []).map((g) => ({
    date: String(g.dimensions?.date ?? ""),
    requests: Number(g.sum?.requests ?? 0),
    uniques: Number(g.uniq?.uniques ?? 0),
    threats: Number(g.sum?.threats ?? 0),
  }));
  const hours = (zone.httpRequests1hGroups ?? []).map((g) => ({
    at: formatPhoenix(String(g.dimensions?.datetime ?? "")),
    utc: String(g.dimensions?.datetime ?? ""),
    requests: Number(g.sum?.requests ?? 0),
    uniques: Number(g.uniq?.uniques ?? 0),
    threats: Number(g.sum?.threats ?? 0),
  }));
  const workerGroups = root.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  return {
    zoneRequests: days.reduce((s, d) => s + d.requests, 0) || hours.reduce((s, h) => s + h.requests, 0),
    zoneUniquesPeak: Math.max(0, ...days.map((d) => d.uniques), ...hours.map((h) => h.uniques)),
    hours,
    days,
    workerRequests: workerGroups.reduce((s, g) => s + Number(g.sum?.requests ?? 0), 0),
    workerErrors: workerGroups.reduce((s, g) => s + Number(g.sum?.errors ?? 0), 0),
  };
}

function headlines(site: Record<string, unknown> | undefined, traffic: TrafficSummary | undefined) {
  const lookups = site?.lookups as
    | {
        total?: number;
        paid?: number;
        free?: number;
        uniquePayers?: number;
        revenueUsdc?: string;
        ownerShareUsdc?: string;
        revenueByAsset?: Array<{ asset: string; paid: number; revenueUsd: string }>;
      }
    | undefined;
  const wallet = site?.wallet as
    | { usdc?: number | null; pyusd?: number | null; usdt?: number | null; sol?: number | null; address?: string }
    | undefined;
  return {
    httpRequests: traffic?.zoneRequests ?? null,
    uniqueVisitorsPeak: traffic?.zoneUniquesPeak ?? null,
    lookupsTotal: lookups?.total ?? null,
    lookupsPaid: lookups?.paid ?? null,
    lookupsFree: lookups?.free ?? null,
    uniquePayers: lookups?.uniquePayers ?? null,
    revenueUsdc: lookups?.revenueUsdc ?? null,
    ownerShareUsdc: lookups?.ownerShareUsdc ?? null,
    revenueByAsset: lookups?.revenueByAsset ?? null,
    walletUsdc: wallet?.usdc ?? null,
    walletPyusd: wallet?.pyusd ?? null,
    walletUsdt: wallet?.usdt ?? null,
    walletSol: wallet?.sol ?? null,
    walletAddress: wallet?.address ?? null,
  };
}

async function main() {
  const pulledAt = new Date();
  const snapshot: Record<string, unknown> = {
    asOf: formatPhoenix(pulledAt),
    asOfIso: pulledAt.toISOString(),
    timezone: TZ,
    statsUrl: STATS_URL,
  };

  try {
    snapshot.site = await fetchSiteStats();
  } catch (err) {
    snapshot.siteError = err instanceof Error ? err.message : String(err);
  }

  const site = snapshot.site as { wallet?: { address?: string; usdc?: number | null; sol?: number | null; error?: string | null } } | undefined;
  if (site && (site.wallet?.usdc == null || site.wallet?.sol == null)) {
    try {
      site.wallet = await fetchWalletFromPublicRpc(site.wallet?.address ?? MAIN_WALLET);
    } catch (err) {
      snapshot.walletError = err instanceof Error ? err.message : String(err);
    }
  }

  const token = readWranglerToken();
  if (!token) {
    snapshot.trafficError = "No Wrangler OAuth token found. Log in with wrangler first.";
  } else {
    try {
      const raw = await fetchCloudflareTraffic(token);
      snapshot.traffic = summarizeTraffic(raw);
    } catch (err) {
      snapshot.trafficError = err instanceof Error ? err.message : String(err);
    }
  }

  snapshot.headlines = headlines(snapshot.site as Record<string, unknown> | undefined, snapshot.traffic as TrafficSummary | undefined);

  writeFileSync(OUTPUT, JSON.stringify(snapshot, null, 2) + "\n");

  const h = snapshot.headlines as ReturnType<typeof headlines>;
  console.log("llmdocs.dev tracker snapshot");
  console.log(`as of ${snapshot.asOf}`);
  console.log(`wrote: ${OUTPUT}`);
  if (h.lookupsTotal != null) {
    console.log(
      `lookups: ${h.lookupsTotal} total (${h.lookupsPaid} paid, ${h.lookupsFree} free), revenue ${h.revenueUsdc} USDC, unique payers ${h.uniquePayers}`,
    );
  }
  if (h.walletUsdc != null && h.walletSol != null) {
    console.log(`main wallet: ${h.walletUsdc} USDC, ${h.walletPyusd ?? 0} PYUSD, ${h.walletUsdt ?? 0} USDT, ${h.walletSol} SOL`);
  }
  if (h.revenueByAsset) {
    console.log(`revenue by asset: ${h.revenueByAsset.map((r) => `${r.asset} ${r.revenueUsd} (${r.paid} paid)`).join(", ")}`);
  }
  if (h.httpRequests != null) {
    console.log(`Cloudflare zone: ${h.httpRequests} requests; peak unique visitors in a published interval: ${h.uniqueVisitorsPeak}`);
  }
  if (snapshot.siteError) console.log(`site stats: ${snapshot.siteError}`);
  if (snapshot.trafficError) console.log(`traffic: ${snapshot.trafficError}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
