import { CHECK_USER_AGENT, DEFAULT_PROBE_TIMEOUT_MS, type PackageResult } from "./types.ts";
import { getCheckFetch } from "./fetch.ts";

const ECOSYSTEMS = ["npm", "pypi", "crates", "go"] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];

export function parseEcosystem(raw: string): Ecosystem | null {
  const v = raw.trim().toLowerCase();
  return (ECOSYSTEMS as readonly string[]).includes(v) ? (v as Ecosystem) : null;
}

/** Conservative package / module name check. */
export function validPackageName(ecosystem: Ecosystem, name: string): boolean {
  const n = name.trim();
  if (!n || n.length > 214) return false;
  if (n.includes("\\") || n.includes("..")) return false;
  if (ecosystem === "go") {
    // module path, e.g. golang.org/x/mod
    return /^[A-Za-z0-9][A-Za-z0-9._~+/\-]*$/.test(n) && !n.startsWith("/") && !n.endsWith("/");
  }
  if (ecosystem === "npm") {
    return /^(?:@[A-Za-z0-9][A-Za-z0-9._\-]*\/)?[A-Za-z0-9][A-Za-z0-9._\-]*$/.test(n);
  }
  if (ecosystem === "pypi") {
    return /^[A-Za-z0-9][A-Za-z0-9._\-]*$/.test(n);
  }
  // crates
  return /^[A-Za-z0-9][A-Za-z0-9_\-]*$/.test(n);
}

export async function checkPackage(ecosystem: Ecosystem, name: string, now = new Date()): Promise<PackageResult> {
  const verifiedAt = now.toISOString();
  const n = name.trim();
  const base: PackageResult = {
    ecosystem,
    name: n,
    exists: false,
    latest: null,
    deprecated: null,
    yanked: null,
    deprecationMessage: null,
    publishedAt: null,
    registryUrl: registryUrl(ecosystem, n),
    verifiedAt,
    error: null,
  };
  if (!validPackageName(ecosystem, n)) {
    return { ...base, error: "invalid_package_name" };
  }
  try {
    if (ecosystem === "npm") return await checkNpm(n, verifiedAt);
    if (ecosystem === "pypi") return await checkPypi(n, verifiedAt);
    if (ecosystem === "crates") return await checkCrates(n, verifiedAt);
    return await checkGo(n, verifiedAt);
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : "registry_error" };
  }
}

function registryUrl(ecosystem: Ecosystem, name: string): string {
  if (ecosystem === "npm") return `https://registry.npmjs.org/${encodeURIComponent(name).replace("%2F", "/")}`;
  if (ecosystem === "pypi") return `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
  if (ecosystem === "crates") return `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`;
  return `https://proxy.golang.org/${encodeGoModule(name)}/@latest`;
}

function encodeGoModule(name: string): string {
  // The module proxy lowercases and encodes uppercase letters as !a, plus path encoding.
  let out = "";
  for (const ch of name) {
    if (ch >= "A" && ch <= "Z") out += `!${ch.toLowerCase()}`;
    else out += ch;
  }
  return out
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await getCheckFetch()(url, {
    method: "GET",
    headers: { accept: "application/json", "user-agent": CHECK_USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(DEFAULT_PROBE_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 200);
  }
  return { status: res.status, body };
}

async function checkNpm(name: string, verifiedAt: string): Promise<PackageResult> {
  const url = registryUrl("npm", name);
  const { status, body } = await getJson(url);
  if (status === 404) {
    return empty("npm", name, url, verifiedAt, null, false);
  }
  if (status !== 200 || !body || typeof body !== "object") {
    return empty("npm", name, url, verifiedAt, `registry_http_${status}`, false);
  }
  const pack = body as {
    "dist-tags"?: { latest?: string };
    time?: Record<string, string>;
    versions?: Record<string, { deprecated?: string }>;
  };
  const latest = pack["dist-tags"]?.latest ?? null;
  const deprecatedMsg = latest ? pack.versions?.[latest]?.deprecated : undefined;
  return {
    ecosystem: "npm",
    name,
    exists: true,
    latest,
    deprecated: Boolean(deprecatedMsg),
    yanked: null,
    deprecationMessage: deprecatedMsg ?? null,
    publishedAt: latest && pack.time?.[latest] ? pack.time[latest]! : pack.time?.modified ?? null,
    registryUrl: url,
    verifiedAt,
    error: null,
  };
}

async function checkPypi(name: string, verifiedAt: string): Promise<PackageResult> {
  const url = registryUrl("pypi", name);
  const { status, body } = await getJson(url);
  if (status === 404) return empty("pypi", name, url, verifiedAt, null, false);
  if (status !== 200 || !body || typeof body !== "object") {
    return empty("pypi", name, url, verifiedAt, `registry_http_${status}`, false);
  }
  const pack = body as {
    info?: { version?: string; yanked?: boolean; yanked_reason?: string };
    releases?: Record<string, Array<{ upload_time_iso_8601?: string; yanked?: boolean }>>;
  };
  const latest = pack.info?.version ?? null;
  const files = latest ? pack.releases?.[latest] ?? [] : [];
  const yanked = pack.info?.yanked === true || (files.length > 0 && files.every((f) => f.yanked));
  const publishedAt = files.find((f) => f.upload_time_iso_8601)?.upload_time_iso_8601 ?? null;
  return {
    ecosystem: "pypi",
    name,
    exists: true,
    latest,
    deprecated: null,
    yanked,
    deprecationMessage: pack.info?.yanked_reason ?? null,
    publishedAt,
    registryUrl: url,
    verifiedAt,
    error: null,
  };
}

async function checkCrates(name: string, verifiedAt: string): Promise<PackageResult> {
  const url = registryUrl("crates", name);
  const { status, body } = await getJson(url);
  if (status === 404) return empty("crates", name, url, verifiedAt, null, false);
  if (status !== 200 || !body || typeof body !== "object") {
    return empty("crates", name, url, verifiedAt, `registry_http_${status}`, false);
  }
  const pack = body as {
    crate?: { max_stable_version?: string; max_version?: string; updated_at?: string };
    versions?: Array<{ num?: string; yanked?: boolean }>;
  };
  const latest = pack.crate?.max_stable_version ?? pack.crate?.max_version ?? null;
  const version = pack.versions?.find((v) => v.num === latest);
  return {
    ecosystem: "crates",
    name,
    exists: true,
    latest,
    deprecated: null,
    yanked: version ? Boolean(version.yanked) : null,
    deprecationMessage: null,
    publishedAt: pack.crate?.updated_at ?? null,
    registryUrl: url,
    verifiedAt,
    error: null,
  };
}

async function checkGo(name: string, verifiedAt: string): Promise<PackageResult> {
  const url = registryUrl("go", name);
  const res = await getCheckFetch()(url, {
    method: "GET",
    headers: { "user-agent": CHECK_USER_AGENT },
    signal: AbortSignal.timeout(DEFAULT_PROBE_TIMEOUT_MS),
  });
  const text = await res.text();
  if (res.status === 404 || res.status === 410) {
    return empty("go", name, url, verifiedAt, null, false);
  }
  if (!res.ok) return empty("go", name, url, verifiedAt, `registry_http_${res.status}`, false);
  let latest: string | null = null;
  let publishedAt: string | null = null;
  try {
    const parsed = JSON.parse(text) as { Version?: string; Time?: string };
    latest = parsed.Version ?? null;
    publishedAt = parsed.Time ?? null;
  } catch {
    // proxy may return "version time" lines
    const first = text.trim().split(/\s+/)[0];
    latest = first || null;
  }
  return {
    ecosystem: "go",
    name,
    exists: Boolean(latest),
    latest,
    deprecated: null,
    yanked: null,
    deprecationMessage: null,
    publishedAt,
    registryUrl: url,
    verifiedAt,
    error: latest ? null : "unreadable_registry_response",
  };
}

function empty(
  ecosystem: Ecosystem,
  name: string,
  registryUrl: string,
  verifiedAt: string,
  error: string | null,
  exists: boolean,
): PackageResult {
  return {
    ecosystem,
    name,
    exists,
    latest: null,
    deprecated: null,
    yanked: null,
    deprecationMessage: null,
    publishedAt: null,
    registryUrl,
    verifiedAt,
    error,
  };
}
