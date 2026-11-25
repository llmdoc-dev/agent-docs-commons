/** Official-page pricing and status types. Never invent a number: use null when unknown. */

export const CHECK_DISCLAIMER =
  "Facts are copied from official pages on the verified date. They are not a quote, SLA, or advice. Fields are null when we could not read a number from the source. Always open source_url before you spend money or depend on a limit.";

export const CHECK_USER_AGENT = "llmdocs-check/0.1 (+https://llmdocs.dev/check)";

export const DEFAULT_PROBE_TIMEOUT_MS = 8000;

export type Freshness = "verified" | "partial" | "unknown" | "stale";

export type PlanFact = {
  name: string;
  /** Fixed list price in USD, or null when the plan is usage-based, custom, or unreadable. */
  priceUsd: number | null;
  pricePeriod: "month" | "year" | "once" | "seat-month" | null;
  priceNote: string | null;
  included: string | null;
  rateLimits: string | null;
  overage: string | null;
  sourceUrl: string;
  /** ISO timestamp when this fact was read from the official page. Null if unverified. */
  verifiedAt: string | null;
};

export type ModelPrice = {
  name: string;
  inputPerMillionUsd: number | null;
  outputPerMillionUsd: number | null;
  cachedInputPerMillionUsd: number | null;
  note: string | null;
  sourceUrl: string;
  verifiedAt: string | null;
};

export type ServiceRecord = {
  slug: string;
  displayName: string;
  category: "ai" | "cloud" | "data" | "payments" | "auth" | "email" | "hosting";
  officialUrl: string;
  pricingUrl: string;
  limitsUrl?: string;
  /** Official status JSON when we have a working feed; otherwise a human status page. */
  statusUrl?: string;
  statusFormat?: "statuspage" | "html" | "stripe-current";
  probeUrl: string;
  /** What a non-2xx probe result means, e.g. 401 without a key still counts as reachable. */
  probeNote?: string;
  /** Matching llmdocs catalog slug, when one exists, for /browse cross-links. */
  docsLibrary?: string;
  plans: PlanFact[];
  models?: ModelPrice[];
  freshness: Freshness;
};

export type ProbeResult = {
  target: string;
  ok: boolean;
  reachable: boolean;
  httpStatus: number | null;
  method: "HEAD" | "GET" | null;
  latencyMs: number | null;
  error: string | null;
  note: string | null;
  checkedAt: string;
};

export type OfficialStatus = {
  state: string;
  indicator: string | null;
  description: string | null;
  statusUrl: string;
  checkedAt: string;
  error: string | null;
};

export type PackageResult = {
  ecosystem: "npm" | "pypi" | "crates" | "go";
  name: string;
  exists: boolean;
  latest: string | null;
  deprecated: boolean | null;
  yanked: boolean | null;
  deprecationMessage: string | null;
  publishedAt: string | null;
  registryUrl: string;
  verifiedAt: string;
  error: string | null;
};
