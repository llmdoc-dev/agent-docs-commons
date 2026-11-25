import { CHECK_USER_AGENT, DEFAULT_PROBE_TIMEOUT_MS, type OfficialStatus, type ProbeResult, type ServiceRecord } from "./types.ts";
import { getCheckFetch } from "./fetch.ts";
import { assertPublicHttpUrl } from "./ssrf.ts";

const MAX_REDIRECTS = 3;
const MAX_BODY = 64 * 1024;

export async function probeUrl(rawUrl: string, probeNote?: string, now = new Date()): Promise<ProbeResult> {
  const checkedAt = now.toISOString();
  const policy = await assertPublicHttpUrl(rawUrl);
  if (!policy.ok) {
    return {
      target: rawUrl,
      ok: false,
      reachable: false,
      httpStatus: null,
      method: null,
      latencyMs: null,
      error: policy.error,
      note: "URL was rejected by the public-URL policy (no probes to private or non-http targets).",
      checkedAt,
    };
  }
  const attempted = await probeFollowingRedirects(policy.url.toString());
  const reachable = attempted.httpStatus != null && attempted.httpStatus < 500 && attempted.httpStatus > 0;
  // 401/403 still mean the endpoint is up and answering.
  const ok = reachable && attempted.httpStatus! < 500;
  let note = probeNote ?? null;
  if (ok && attempted.httpStatus && attempted.httpStatus >= 400 && attempted.httpStatus < 500 && !note) {
    note = `Endpoint reachable; HTTP ${attempted.httpStatus} is expected for some gated APIs without a key and still counts as up.`;
  }
  return {
    target: policy.url.toString(),
    ok,
    reachable,
    httpStatus: attempted.httpStatus,
    method: attempted.method,
    latencyMs: attempted.latencyMs,
    error: attempted.error,
    note,
    checkedAt,
  };
}

async function probeFollowingRedirects(startUrl: string): Promise<{
  httpStatus: number | null;
  method: "HEAD" | "GET" | null;
  latencyMs: number | null;
  error: string | null;
}> {
  let current = startUrl;
  const t0 = Date.now();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const head = await rawRequest("HEAD", current);
    let used: { status: number; location: string | null; error: string | null } = head;
    let method: "HEAD" | "GET" = "HEAD";
    if (head.error || head.status === 405 || head.status === 501 || head.status === 400) {
      const get = await rawRequest("GET", current);
      used = get;
      method = "GET";
    }
    const latencyMs = Date.now() - t0;
    if (used.error) {
      return { httpStatus: used.status, method, latencyMs, error: used.error };
    }
    if (used.status >= 300 && used.status < 400 && used.location) {
      const next = await assertPublicHttpUrl(new URL(used.location, current).toString());
      if (!next.ok) {
        return { httpStatus: used.status, method, latencyMs, error: `redirect_${next.error}` };
      }
      current = next.url.toString();
      continue;
    }
    return { httpStatus: used.status, method, latencyMs, error: null };
  }
  return { httpStatus: null, method: null, latencyMs: Date.now() - t0, error: "too_many_redirects" };
}

async function rawRequest(method: "HEAD" | "GET", url: string): Promise<{ status: number; location: string | null; error: string | null }> {
  try {
    const res = await getCheckFetch()(url, {
      method,
      headers: { "user-agent": CHECK_USER_AGENT, accept: "application/json, text/plain, */*" },
      redirect: "manual",
      signal: AbortSignal.timeout(DEFAULT_PROBE_TIMEOUT_MS),
    });
    if (method === "GET") {
      // Drain a small amount so the connection can close cleanly.
      await res.arrayBuffer().catch(() => undefined);
    }
    return { status: res.status, location: res.headers.get("location"), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.name === "TimeoutError" ? "timeout" : err.message : "probe_failed";
    return { status: 0, location: null, error: message };
  }
}

export async function readOfficialStatus(service: ServiceRecord, now = new Date()): Promise<OfficialStatus | null> {
  if (!service.statusUrl) return null;
  const checkedAt = now.toISOString();
  if (service.statusFormat === "html") {
    return {
      state: "see_status_page",
      indicator: null,
      description: "This vendor does not publish a machine-readable status feed we trust yet. Open the status URL.",
      statusUrl: service.statusUrl,
      checkedAt,
      error: null,
    };
  }
  if (service.statusFormat === "stripe-current") {
    // Stripe's /current JSON has been observed with a stale timestamp; do not treat it as live.
    return {
      state: "see_status_page",
      indicator: null,
      description: "Use the official Stripe status page. A machine-readable feed was not used because a public JSON endpoint returned a stale timestamp when we checked.",
      statusUrl: service.statusUrl,
      checkedAt,
      error: null,
    };
  }
  try {
    const res = await getCheckFetch()(service.statusUrl, {
      method: "GET",
      headers: { "user-agent": CHECK_USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(DEFAULT_PROBE_TIMEOUT_MS),
    });
    const text = (await res.text()).slice(0, MAX_BODY);
    if (!res.ok) {
      return {
        state: "unknown",
        indicator: null,
        description: null,
        statusUrl: service.statusUrl,
        checkedAt,
        error: `status_http_${res.status}`,
      };
    }
    const body = JSON.parse(text) as { status?: { indicator?: string; description?: string } };
    const indicator = body.status?.indicator ?? null;
    const description = body.status?.description ?? null;
    const state = indicatorToState(indicator, description);
    return { state, indicator, description, statusUrl: service.statusUrl, checkedAt, error: null };
  } catch (err) {
    return {
      state: "unknown",
      indicator: null,
      description: null,
      statusUrl: service.statusUrl,
      checkedAt,
      error: err instanceof Error ? err.message : "status_fetch_failed",
    };
  }
}

function indicatorToState(indicator: string | null, description: string | null): string {
  const i = (indicator ?? "").toLowerCase();
  if (i === "none" || i === "operational") return "operational";
  if (i === "minor") return "degraded";
  if (i === "major" || i === "critical") return "outage";
  if (i === "maintenance") return "maintenance";
  const d = (description ?? "").toLowerCase();
  if (d.includes("all systems operational") || d === "operational") return "operational";
  if (d.includes("degrad")) return "degraded";
  if (d.includes("outage") || d.includes("major")) return "outage";
  return indicator || description || "unknown";
}
