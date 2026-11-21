/**
 * Print live /v1/stats and a Cloudflare Analytics traffic snapshot.
 * Reads the local Wrangler OAuth token if present and never prints it.
 *
 * Usage: npm run stats
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATS_URL = process.env.STATS_URL ?? "https://llmdocs.dev/v1/stats";
const ZONE_ID = process.env.CF_ZONE_ID ?? "91683f5ee516bc113f26f5b7e5d20212";
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID ?? "ed6d5bfd153f65bf6c2445c97f878a98";
const SCRIPT_NAME = process.env.CF_SCRIPT_NAME ?? "llmdocs";
const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";

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

function phoenixHourLabel(isoUtc: string): string {
  const date = new Date(isoUtc);
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Phoenix",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
  return `${label} America/Phoenix`;
}

async function fetchSiteStats(): Promise<unknown> {
  const res = await fetch(STATS_URL, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${STATS_URL} failed: HTTP ${res.status}`);
  return res.json();
}

async function fetchCloudflareTraffic(token: string): Promise<unknown> {
  const until = new Date();
  const since = new Date(until.getTime() - 14 * 24 * 60 * 60 * 1000);
  const sinceDate = since.toISOString().slice(0, 10);
  const untilDate = until.toISOString().slice(0, 10);
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
    },
    body: JSON.stringify({
      query,
      variables: {
        zone: ZONE_ID,
        account: ACCOUNT_ID,
        since: sinceDate,
        until: untilDate,
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

function summarizeTraffic(data: unknown): {
  zoneRequests: number;
  zoneUniquesPeak: number;
  hours: Array<{ at: string; requests: number; uniques: number; threats: number }>;
  days: Array<{ date: string; requests: number; uniques: number; threats: number }>;
  workerRequests: number;
  workerErrors: number;
} {
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
    at: phoenixHourLabel(String(g.dimensions?.datetime ?? "")),
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

async function main() {
  const snapshot: Record<string, unknown> = {
    pulledAt: new Date().toISOString(),
    timezone: "America/Phoenix",
    statsUrl: STATS_URL,
  };

  try {
    snapshot.site = await fetchSiteStats();
  } catch (err) {
    snapshot.siteError = err instanceof Error ? err.message : String(err);
  }

  const token = readWranglerToken();
  if (!token) {
    snapshot.trafficError = "No Wrangler OAuth token found. Log in with wrangler first, or rely on /v1/stats alone.";
  } else {
    try {
      const raw = await fetchCloudflareTraffic(token);
      snapshot.cloudflare = raw;
      snapshot.traffic = summarizeTraffic(raw);
    } catch (err) {
      snapshot.trafficError = err instanceof Error ? err.message : String(err);
    }
  }

  const dir = join(process.cwd(), "stats-snapshots");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(snapshot, null, 2));

  const site = snapshot.site as { lookups?: { total?: number; paid?: number; free?: number; revenueUsdc?: string; uniquePayers?: number }; wallet?: { usdc?: number; sol?: number } } | undefined;
  const traffic = snapshot.traffic as { zoneRequests?: number; zoneUniquesPeak?: number; hours?: unknown[]; workerRequests?: number; workerErrors?: number } | undefined;
  console.log("llmdocs.dev stats snapshot");
  console.log(`timezone: America/Phoenix`);
  console.log(`wrote: ${file}`);
  if (site?.lookups) {
    console.log(
      `lookups: ${site.lookups.total} total (${site.lookups.paid} paid, ${site.lookups.free} free), revenue ${site.lookups.revenueUsdc} USDC, unique payers ${site.lookups.uniquePayers}`,
    );
  }
  if (site?.wallet && site.wallet.usdc != null && site.wallet.sol != null) {
    console.log(`main wallet: ${site.wallet.usdc} USDC, ${site.wallet.sol} SOL`);
  }
  if (snapshot.siteError) console.log(`site stats: ${snapshot.siteError}`);
  if (traffic) {
    console.log(
      `Cloudflare zone: ${traffic.zoneRequests} requests; peak unique visitors in a published interval: ${traffic.zoneUniquesPeak}`,
    );
    console.log(
      `Worker invocations: ${traffic.workerRequests} (${traffic.workerErrors} error-class responses, which may include 4xx such as 402)`,
    );
  }
  if (snapshot.trafficError) console.log(`traffic: ${snapshot.trafficError}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
