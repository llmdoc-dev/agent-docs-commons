import { CHECK_DISCLAIMER, type OfficialStatus, type PackageResult, type ProbeResult, type ServiceRecord } from "./types.ts";
import { getService, listServices } from "./seed.ts";
import { probeUrl, readOfficialStatus } from "./status.ts";
import { checkPackage, parseEcosystem, validPackageName, type Ecosystem } from "./packages.ts";

export type PricingResponse = {
  service: string;
  displayName: string;
  officialUrl: string;
  pricingUrl: string;
  limitsUrl: string | null;
  docsLibrary: string | null;
  docsBrowseUrl: string | null;
  freshness: ServiceRecord["freshness"];
  plans: ServiceRecord["plans"];
  models: ServiceRecord["models"] | null;
  disclaimer: string;
};

export type StatusResponse = {
  service: string | null;
  displayName: string | null;
  overall: string;
  official: OfficialStatus | null;
  probe: ProbeResult;
  docsLibrary: string | null;
  docsBrowseUrl: string | null;
  disclaimer: string;
};

export type PreflightResponse = {
  service: string | null;
  displayName: string | null;
  checkedAt: string;
  overall: string;
  official: OfficialStatus | null;
  probe: ProbeResult;
  pricing: PricingResponse | null;
  package: PackageResult | null;
  docsLibrary: string | null;
  docsBrowseUrl: string | null;
  disclaimer: string;
};

export function publicServiceList(origin: string): Array<Record<string, unknown>> {
  return listServices().map((s) => ({
    slug: s.slug,
    displayName: s.displayName,
    category: s.category,
    officialUrl: s.officialUrl,
    pricingUrl: s.pricingUrl,
    statusUrl: s.statusUrl ?? null,
    probeUrl: s.probeUrl,
    freshness: s.freshness,
    docsLibrary: s.docsLibrary ?? null,
    docsBrowseUrl: s.docsLibrary ? `${origin}/browse/${s.docsLibrary}` : null,
    planCount: s.plans.length,
    verifiedPlanCount: s.plans.filter((p) => p.verifiedAt).length,
  }));
}

export function pricingFor(service: ServiceRecord, origin: string): PricingResponse {
  return {
    service: service.slug,
    displayName: service.displayName,
    officialUrl: service.officialUrl,
    pricingUrl: service.pricingUrl,
    limitsUrl: service.limitsUrl ?? null,
    docsLibrary: service.docsLibrary ?? null,
    docsBrowseUrl: service.docsLibrary ? `${origin}/browse/${service.docsLibrary}` : null,
    freshness: service.freshness,
    plans: service.plans,
    models: service.models ?? null,
    disclaimer: CHECK_DISCLAIMER,
  };
}

export async function runStatus(opts: {
  service?: string;
  url?: string;
  origin: string;
}): Promise<{ ok: true; body: StatusResponse } | { ok: false; error: string; status: number }> {
  const service = opts.service ? getService(opts.service) : undefined;
  if (opts.service && !service) {
    return { ok: false, error: "unknown_service", status: 404 };
  }
  const target = opts.url?.trim() || service?.probeUrl;
  if (!target) {
    return { ok: false, error: "service_or_url_required", status: 400 };
  }
  const probe = await probeUrl(target, opts.url ? undefined : service?.probeNote);
  const official = service ? await readOfficialStatus(service) : null;
  const overall = overallState(official, probe);
  return {
    ok: true,
    body: {
      service: service?.slug ?? null,
      displayName: service?.displayName ?? null,
      overall,
      official,
      probe,
      docsLibrary: service?.docsLibrary ?? null,
      docsBrowseUrl: service?.docsLibrary ? `${opts.origin}/browse/${service.docsLibrary}` : null,
      disclaimer: CHECK_DISCLAIMER,
    },
  };
}

export async function runPreflight(opts: {
  service?: string;
  url?: string;
  ecosystem?: string;
  packageName?: string;
  origin: string;
}): Promise<{ ok: true; body: PreflightResponse } | { ok: false; error: string; status: number }> {
  const service = opts.service ? getService(opts.service) : undefined;
  if (opts.service && !service) {
    return { ok: false, error: "unknown_service", status: 404 };
  }
  const target = opts.url?.trim() || service?.probeUrl;
  if (!target && !opts.packageName) {
    return { ok: false, error: "service_url_or_package_required", status: 400 };
  }

  let probe: ProbeResult | null = null;
  let official: OfficialStatus | null = null;
  if (target) {
    probe = await probeUrl(target, opts.url ? undefined : service?.probeNote);
    official = service ? await readOfficialStatus(service) : null;
  }

  let pkg: PackageResult | null = null;
  if (opts.packageName) {
    const eco = parseEcosystem(opts.ecosystem ?? "npm");
    if (!eco) return { ok: false, error: "unknown_ecosystem", status: 400 };
    pkg = await checkPackage(eco, opts.packageName);
  }

  const pricing = service ? pricingFor(service, opts.origin) : null;
  const overall = overallState(official, probe, pkg);
  return {
    ok: true,
    body: {
      service: service?.slug ?? null,
      displayName: service?.displayName ?? null,
      checkedAt: new Date().toISOString(),
      overall,
      official,
      probe: probe ?? {
        target: "",
        ok: false,
        reachable: false,
        httpStatus: null,
        method: null,
        latencyMs: null,
        error: "not_requested",
        note: null,
        checkedAt: new Date().toISOString(),
      },
      pricing,
      package: pkg,
      docsLibrary: service?.docsLibrary ?? null,
      docsBrowseUrl: service?.docsLibrary ? `${opts.origin}/browse/${service.docsLibrary}` : null,
      disclaimer: CHECK_DISCLAIMER,
    },
  };
}

export function parsePackageArgs(ecosystem: string | null, name: string | null): { ok: true; ecosystem: Ecosystem; name: string } | { ok: false; error: string } {
  if (!name || !name.trim()) return { ok: false, error: "name is required" };
  const eco = parseEcosystem(ecosystem ?? "npm");
  if (!eco) return { ok: false, error: "unknown_ecosystem" };
  if (!validPackageName(eco, name.trim())) return { ok: false, error: "invalid_package_name" };
  return { ok: true, ecosystem: eco, name: name.trim() };
}

function overallState(official: OfficialStatus | null, probe: ProbeResult | null, pkg?: PackageResult | null): string {
  if (pkg && pkg.exists === false && !probe) return "package_not_found";
  if (pkg?.deprecated || pkg?.yanked) {
    if (probe && !probe.reachable) return "deprecated_and_unreachable";
    return pkg.yanked ? "yanked" : "deprecated";
  }
  if (probe && !probe.reachable) return "unreachable";
  if (official?.state && official.state !== "operational" && official.state !== "see_status_page" && official.state !== "unknown") {
    return official.state;
  }
  if (probe?.ok) return official?.state === "operational" || !official ? "operational" : official.state;
  if (official?.state) return official.state;
  return "unknown";
}
