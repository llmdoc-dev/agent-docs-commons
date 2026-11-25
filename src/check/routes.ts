import type { AppConfig } from "../config.ts";
import type { Db } from "../db.ts";
import { jsonResponse } from "../payment.ts";
import { BAZAAR_DESCRIPTION } from "../descriptions.ts";
import { checkPageHtml } from "./page.ts";
import { getService, listServices } from "./seed.ts";
import { checkPackage } from "./packages.ts";
import { parsePackageArgs, pricingFor, publicServiceList, runPreflight, runStatus } from "./handlers.ts";
import { checkResourceUrl, gateCheckRequest, recordCheckAndRespond } from "./meter.ts";

export async function handleCheckRoutes(
  cfg: AppConfig,
  db: Db,
  req: Request,
  url: URL,
  path: string,
  method: string,
): Promise<Response | null> {
  if (method === "GET" && path === "/check") {
    return new Response(checkPageHtml(cfg), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
    });
  }
  if (method === "GET" && path === "/v1/check/services") {
    return jsonResponse(200, {
      services: publicServiceList(cfg.publicBaseUrl),
      count: listServices().length,
    });
  }

  const metered: Record<string, { required: (u: URL) => boolean; description: string }> = {
    "/v1/check/preflight": {
      required: (u) => Boolean(u.searchParams.get("service") || u.searchParams.get("url") || u.searchParams.get("name") || u.searchParams.get("package")),
      description: "Preflight: status, package health, and cited pricing facts",
    },
    "/v1/check/status": {
      required: (u) => Boolean(u.searchParams.get("service") || u.searchParams.get("url")),
      description: "Reachability and official status check",
    },
    "/v1/check/pricing": {
      required: (u) => Boolean(u.searchParams.get("service")),
      description: "Cited plan and limit facts from official pricing pages",
    },
    "/v1/check/package": {
      required: (u) => Boolean(u.searchParams.get("name") || u.searchParams.get("package")),
      description: "Package existence, latest version, and deprecation from the official registry",
    },
  };

  const spec = metered[path];
  if (!spec || (method !== "GET" && method !== "HEAD")) return null;

  const discoveryProbe = method === "HEAD" || !spec.required(url);
  const gated = await gateCheckRequest(cfg, db, req, {
    resourceUrl: checkResourceUrl(cfg.publicBaseUrl, path),
    description: discoveryProbe ? BAZAAR_DESCRIPTION : spec.description,
    discoveryProbe,
  });
  if (!gated.ok) return gated.response;
  if (discoveryProbe) {
    if (method === "HEAD") return new Response(null, { status: 200, headers: gated.gate.responseHeaders });
    return jsonResponse(400, { error: missingParamError(path) }, gated.gate.responseHeaders);
  }

  if (path === "/v1/check/services") return null;

  if (path === "/v1/check/pricing") {
    const slug = (url.searchParams.get("service") ?? "").trim();
    const service = getService(slug);
    if (!service) return jsonResponse(404, { error: "unknown_service", slug }, gated.gate.responseHeaders);
    return recordCheckAndRespond(cfg, db, req, url, gated.gate, pricingFor(service, cfg.publicBaseUrl), `check:pricing:${service.slug}`, service.slug);
  }

  if (path === "/v1/check/package") {
    const parsed = parsePackageArgs(url.searchParams.get("ecosystem"), url.searchParams.get("name") ?? url.searchParams.get("package"));
    if (!parsed.ok) return jsonResponse(400, { error: parsed.error }, gated.gate.responseHeaders);
    const result = await checkPackage(parsed.ecosystem, parsed.name);
    return recordCheckAndRespond(cfg, db, req, url, gated.gate, result, `check:package:${parsed.ecosystem}:${parsed.name}`, "check");
  }

  if (path === "/v1/check/status") {
    const result = await runStatus({
      service: url.searchParams.get("service") ?? undefined,
      url: url.searchParams.get("url") ?? undefined,
      origin: cfg.publicBaseUrl,
    });
    if (!result.ok) return jsonResponse(result.status, { error: result.error }, gated.gate.responseHeaders);
    const q = result.body.service ? `check:status:${result.body.service}` : `check:status:${result.body.probe.target}`;
    return recordCheckAndRespond(cfg, db, req, url, gated.gate, result.body, q, result.body.service);
  }

  const result = await runPreflight({
    service: url.searchParams.get("service") ?? undefined,
    url: url.searchParams.get("url") ?? undefined,
    ecosystem: url.searchParams.get("ecosystem") ?? undefined,
    packageName: url.searchParams.get("name") ?? url.searchParams.get("package") ?? undefined,
    origin: cfg.publicBaseUrl,
  });
  if (!result.ok) return jsonResponse(result.status, { error: result.error }, gated.gate.responseHeaders);
  const q = result.body.service ? `check:preflight:${result.body.service}` : `check:preflight`;
  return recordCheckAndRespond(cfg, db, req, url, gated.gate, result.body, q, result.body.service);
}

function missingParamError(path: string): string {
  if (path.endsWith("/pricing")) return "service is required";
  if (path.endsWith("/package")) return "name is required";
  if (path.endsWith("/status")) return "service or url is required";
  return "service, url, or package name is required";
}
