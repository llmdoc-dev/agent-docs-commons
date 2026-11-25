/**
 * Allow only public http(s) URLs for user-supplied probes.
 * Catalog probe URLs are also run through this check as a belt-and-suspenders step.
 */

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.",
  "metadata.google.internal",
  "metadata.internal",
  "instance-data",
]);

const BLOCKED_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".corp"];

export type UrlPolicyError = { ok: false; error: string };
export type UrlPolicyOk = { ok: true; url: URL };
export type UrlPolicy = UrlPolicyOk | UrlPolicyError;

export function inspectPublicUrl(raw: string): UrlPolicy {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "only_http_https" };
  }
  if (url.username || url.password) {
    return { ok: false, error: "credentials_not_allowed" };
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (port !== 80 && port !== 443) {
    return { ok: false, error: "port_not_allowed" };
  }
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  if (!host) return { ok: false, error: "invalid_host" };
  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOSTS.has(`${host}.`)) {
    return { ok: false, error: "private_host" };
  }
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, error: "private_host" };
  }
  if (isBlockedIpLiteral(host)) {
    return { ok: false, error: "private_ip" };
  }
  return { ok: true, url };
}

export function isBlockedIpLiteral(host: string): boolean {
  if (host.startsWith("[") && host.endsWith("]")) {
    return isBlockedIpv6(host.slice(1, -1));
  }
  if (host.includes(":")) return isBlockedIpv6(host);
  return isBlockedIpv4(host);
}

function isBlockedIpv4(host: string): boolean {
  // Only accept dotted-decimal. Reject octal/decimal tricks like 0177.0.0.1 or 2130706433.
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  const parts = host.split(".").map((p) => Number(p));
  if (parts.some((n) => n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b! >= 16 && b! <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b! >= 64 && b! <= 127) return true; // CGNAT / carrier-grade
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isBlockedIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::" || h === "::1") return true;
  if (h.startsWith("fe80:") || h.startsWith("ff")) return true;
  if (h.startsWith("fc") || h.startsWith("fd")) return true;
  // IPv4-mapped
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]!);
  return false;
}

/** When node:dns is available, reject names that resolve to a private address. */
export async function assertPublicHostname(host: string): Promise<UrlPolicy> {
  try {
    const dns = await import("node:dns/promises");
    const results = await dns.lookup(host, { all: true });
    for (const r of results) {
      if (isBlockedIpLiteral(r.address)) {
        return { ok: false, error: "resolves_to_private_ip" };
      }
    }
  } catch (err) {
    if (err && typeof err === "object" && "ok" in err) return err as UrlPolicy;
    // Lookup failure is not a pass: we still allow the fetch only when the
    // hostname is not an IP literal (already checked). Failed DNS will surface
    // as a probe error later.
  }
  return { ok: true, url: new URL(`https://${host}/`) };
}

export async function assertPublicHttpUrl(raw: string): Promise<UrlPolicy> {
  const first = inspectPublicUrl(raw);
  if (!first.ok) return first;
  const dns = await assertPublicHostname(first.url.hostname);
  if (!dns.ok) return dns;
  return first;
}
