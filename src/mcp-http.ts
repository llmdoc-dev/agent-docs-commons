import type { AppConfig } from "./config.ts";
import type { Db } from "./db.ts";
import { jsonResponse, paymentCorsHeaders, textResponse } from "./payment.ts";
import { listLibraries } from "./db.ts";
import {
  CHECK_PACKAGE_TOOL_DESCRIPTION,
  CHECK_STATUS_TOOL_DESCRIPTION,
  CONTRIBUTE_TOOL_DESCRIPTION,
  GET_PRICING_TOOL_DESCRIPTION,
  LIBRARIES_TOOL_DESCRIPTION,
  LIST_CHECK_SERVICES_TOOL_DESCRIPTION,
  LOOKUP_TOOL_DESCRIPTION,
  MCP_INSTRUCTIONS,
  PREFLIGHT_TOOL_DESCRIPTION,
  VERIFY_TOOL_DESCRIPTION,
} from "./descriptions.ts";

/**
 * Minimal Streamable HTTP MCP endpoint.
 * JSON-RPC over POST /mcp. Lookups still require a PAYMENT-SIGNATURE on the
 * underlying HTTP API; the tool returns the 402 challenge when unpaid.
 */
const PROTOCOL_VERSION = "2025-03-26";

export const MCP_SERVER_VERSION = "0.3.0";

export const TOOLS = [
  {
    name: "docs_lookup",
    title: "Look up version-pinned docs",
    description: LOOKUP_TOOL_DESCRIPTION,
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      required: ["q"],
      properties: {
        q: { type: "string", description: "Short question or API symbol, e.g. 'useState initializer' or 'registerTool inputSchema'" },
        library: { type: "string", description: "Library slug from docs_libraries, e.g. react, nextjs, x402, solana-kit, mcp-typescript, mcp-python, stripe" },
        version: { type: "string", description: "Optional version prefix to pin, e.g. 19 or 2.4" },
        ref: { type: "string", description: "Optional: Solana address of the agent that referred you. First touch on a new payer sticks." },
        paymentSignature: { type: "string", description: "x402 v2 PAYMENT-SIGNATURE value that pays the 402 challenge from a previous call" },
        format: { type: "string", enum: ["text", "json"], description: "text (default, compact) or json (full HTTP response with attribution and payout lines)" },
      },
    },
  },
  {
    name: "docs_libraries",
    title: "List libraries",
    description: LIBRARIES_TOOL_DESCRIPTION,
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "docs_contribute",
    title: "Contribute a snippet",
    description: CONTRIBUTE_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      required: ["wallet", "library", "libraryVersion", "title", "body", "sourceUrl"],
      properties: {
        wallet: { type: "string", description: "Your Solana address (receives USDC earnings)" },
        library: { type: "string", description: "Lowercase library slug" },
        libraryVersion: { type: "string" },
        title: { type: "string" },
        body: { type: "string", description: "40–1500 characters, short cited excerpt or summary" },
        sourceUrl: { type: "string", description: "https URL on an official-docs host" },
        license: { type: "string" },
      },
    },
  },
  {
    name: "docs_verify",
    title: "Verify a snippet",
    description: VERIFY_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      required: ["wallet", "snippetId", "verdict"],
      properties: {
        wallet: { type: "string", description: "Your Solana address" },
        snippetId: { type: "string" },
        verdict: { type: "string", enum: ["confirm", "stale", "reject"] },
        note: { type: "string" },
      },
    },
  },

  {
    name: "preflight",
    title: "Preflight a service, URL, or package",
    description: PREFLIGHT_TOOL_DESCRIPTION,
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service slug from list_check_services, e.g. openai, stripe, supabase" },
        url: { type: "string", description: "Public https URL to probe when the service is not in the catalog" },
        ecosystem: { type: "string", enum: ["npm", "pypi", "crates", "go"], description: "Registry for a package check (default npm)" },
        name: { type: "string", description: "Package or module name to check on the official registry" },
        paymentSignature: { type: "string", description: "x402 v2 PAYMENT-SIGNATURE from a previous 402" },
        format: { type: "string", enum: ["text", "json"], description: "text (default) or json" },
      },
    },
  },
  {
    name: "check_status",
    title: "Check reachability and official status",
    description: CHECK_STATUS_TOOL_DESCRIPTION,
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string" },
        url: { type: "string" },
        paymentSignature: { type: "string" },
        format: { type: "string", enum: ["text", "json"] },
      },
    },
  },
  {
    name: "check_package",
    title: "Check a package on the official registry",
    description: CHECK_PACKAGE_TOOL_DESCRIPTION,
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "Package or module name, e.g. request or golang.org/x/mod" },
        ecosystem: { type: "string", enum: ["npm", "pypi", "crates", "go"], description: "Default npm" },
        paymentSignature: { type: "string" },
        format: { type: "string", enum: ["text", "json"] },
      },
    },
  },
  {
    name: "get_pricing",
    title: "Cited official plan and limit facts",
    description: GET_PRICING_TOOL_DESCRIPTION,
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      required: ["service"],
      properties: {
        service: { type: "string", description: "Service slug from list_check_services" },
        paymentSignature: { type: "string" },
        format: { type: "string", enum: ["text", "json"] },
      },
    },
  },
  {
    name: "list_check_services",
    title: "List preflight services",
    description: LIST_CHECK_SERVICES_TOOL_DESCRIPTION,
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: {} },
  },
];

export async function handleMcp(
  cfg: AppConfig,
  db: Db,
  req: Request,
  _url: URL,
  dispatch?: (request: Request) => Promise<Response>,
): Promise<Response> {
  if (req.method === "GET") {
    return textResponse(
      200,
      "text/plain; charset=utf-8",
      `llmdocs MCP endpoint (Streamable HTTP, JSON responses). POST JSON-RPC 2.0 to this URL. Tools: docs_lookup, docs_libraries, docs_contribute, docs_verify, preflight, check_status, check_package, get_pricing, list_check_services.\n\n${MCP_INSTRUCTIONS}\n\nInstall: claude mcp add --transport http llmdocs ${cfg.publicBaseUrl}/mcp  |  Cursor/VS Code: see ${cfg.publicBaseUrl}/#install\n`,
    );
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "method_not_allowed" });
  }
  let body: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return mcpMessage(null, undefined, { code: -32700, message: "Parse error" });
  }
  const id = body.id ?? null;
  const method = body.method ?? "";
  const params = body.params ?? {};

  if (method === "initialize") {
    return mcpMessage(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "llmdocs", title: "llmdocs.dev", version: MCP_SERVER_VERSION, websiteUrl: cfg.publicBaseUrl },
      instructions: MCP_INSTRUCTIONS,
    });
  }
  if (method === "notifications/initialized" || method === "initialized") {
    return new Response(null, { status: 204, headers: paymentCorsHeaders() });
  }
  if (method === "ping") {
    return mcpMessage(id, {});
  }
  if (method === "tools/list") {
    return mcpMessage(id, { tools: TOOLS });
  }
  if (method === "tools/call") {
    const name = String(params.name ?? "");
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = await callTool(cfg, db, req, name, args, dispatch);
      return mcpMessage(id, result);
    } catch (err) {
      return mcpMessage(id, undefined, {
        code: -32000,
        message: err instanceof Error ? err.message : "tool_error",
      });
    }
  }
  return mcpMessage(id, undefined, { code: -32601, message: `Method not found: ${method}` });
}

async function callTool(
  cfg: AppConfig,
  db: Db,
  incoming: Request,
  name: string,
  args: Record<string, unknown>,
  dispatch?: (request: Request) => Promise<Response>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  if (name === "docs_libraries") {
    const libraries = await listLibraries(db);
    return { content: [{ type: "text", text: JSON.stringify({ libraries }, null, 2) }] };
  }
  const origin = cfg.publicBaseUrl;
  if (name === "docs_lookup") {
    const q = encodeURIComponent(String(args.q ?? ""));
    const library = args.library ? `&library=${encodeURIComponent(String(args.library))}` : "";
    const version = args.version ? `&version=${encodeURIComponent(String(args.version))}` : "";
    const ref = args.ref ? `&ref=${encodeURIComponent(String(args.ref))}` : "";
    const headers: Record<string, string> = { accept: "application/json" };
    const payment = args.paymentSignature ? String(args.paymentSignature) : incoming.headers.get("PAYMENT-SIGNATURE") ?? incoming.headers.get("X-PAYMENT");
    if (payment) headers["PAYMENT-SIGNATURE"] = payment;
    const incomingRef = incoming.headers.get("X-Llmdocs-Ref");
    if (incomingRef) headers["X-Llmdocs-Ref"] = incomingRef;
    // Keep the caller's client IP on the internal request so the free trial is
    // counted per MCP client, not shared by every MCP user.
    for (const name of ["CF-Connecting-IP", "True-Client-IP", "X-Forwarded-For"]) {
      const value = incoming.headers.get(name);
      if (value) headers[name] = value;
    }
    const lookupReq = new Request(`${origin}/v1/docs/lookup?q=${q}${library}${version}${ref}`, { headers });
    const res = dispatch ? await dispatch(lookupReq) : await fetch(lookupReq);
    const text = await res.text();
    const wantJson = String(args.format ?? "text") === "json";
    return {
      content: [{ type: "text", text: wantJson ? text : renderLookupText(res.status, text, cfg.publicBaseUrl) }],
      isError: res.status >= 400 && res.status !== 402,
    };
  }
  if (name === "docs_contribute" || name === "docs_verify") {
    const path = name === "docs_contribute" ? "/v1/contribute" : "/v1/verify";
    const inner = new Request(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const res = dispatch ? await dispatch(inner) : await fetch(inner);
    const text = await res.text();
    return { content: [{ type: "text", text }], isError: !res.ok };
  }

  const checkTools: Record<string, string> = {
    preflight: "/v1/check/preflight",
    check_status: "/v1/check/status",
    check_package: "/v1/check/package",
    get_pricing: "/v1/check/pricing",
    list_check_services: "/v1/check/services",
  };
  if (name === "list_check_services") {
    const inner = new Request(`${origin}/v1/check/services`, { headers: { accept: "application/json" } });
    const res = dispatch ? await dispatch(inner) : await fetch(inner);
    const text = await res.text();
    return { content: [{ type: "text", text }], isError: !res.ok };
  }
  if (checkTools[name]) {
    const params = new URLSearchParams();
    if (args.service) params.set("service", String(args.service));
    if (args.url) params.set("url", String(args.url));
    if (args.ecosystem) params.set("ecosystem", String(args.ecosystem));
    if (args.name) params.set("name", String(args.name));
    const headers: Record<string, string> = { accept: "application/json" };
    const payment = args.paymentSignature ? String(args.paymentSignature) : incoming.headers.get("PAYMENT-SIGNATURE") ?? incoming.headers.get("X-PAYMENT");
    if (payment) headers["PAYMENT-SIGNATURE"] = payment;
    const incomingRef = incoming.headers.get("X-Llmdocs-Ref");
    if (incomingRef) headers["X-Llmdocs-Ref"] = incomingRef;
    for (const headerName of ["CF-Connecting-IP", "True-Client-IP", "X-Forwarded-For"]) {
      const value = incoming.headers.get(headerName);
      if (value) headers[headerName] = value;
    }
    const qs = params.toString();
    const lookupReq = new Request(`${origin}${checkTools[name]}${qs ? `?${qs}` : ""}`, { headers });
    const res = dispatch ? await dispatch(lookupReq) : await fetch(lookupReq);
    const text = await res.text();
    const wantJson = String(args.format ?? "text") === "json";
    return {
      content: [{ type: "text", text: wantJson ? text : renderCheckText(res.status, text) }],
      isError: res.status >= 400 && res.status !== 402,
    };
  }
  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
}

function mcpMessage(
  id: unknown,
  result?: unknown,
  error?: { code: number; message: string },
): Response {
  const body = error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result };
  return jsonResponse(200, body);
}

type LookupJson = {
  results?: Array<{ id: string; library: string; libraryVersion: string; title: string; body: string; sourceUrl: string; license: string }>;
  payment?: { mode?: string; feeUsd?: number; remainingFreeLookups?: number; transaction?: string | null; asset?: string };
};

/** Compact text for agents: snippets with version and source, plus one payment line. */
export function renderLookupText(status: number, raw: string, origin: string): string {
  if (status !== 200) {
    if (status === 402) {
      return `Payment required: the free trial for today is used up. Pay the x402 challenge below ($0.01 in USDC, PYUSD, or USDT on Solana; pick one entry from accepts) and call docs_lookup again with paymentSignature set to your PAYMENT-SIGNATURE value.\n${raw}`;
    }
    return raw;
  }
  let body: LookupJson;
  try {
    body = JSON.parse(raw) as LookupJson;
  } catch {
    return raw;
  }
  const results = body.results ?? [];
  const lines: string[] = [];
  if (results.length === 0) {
    lines.push(`No matching snippet. Try another wording or a library slug from docs_libraries. Know the answer from an official source? Add it with docs_contribute (${origin}/llms.txt).`);
  }
  for (const r of results) {
    lines.push(`## ${r.title} (${r.library} ${r.libraryVersion})\n${r.body}\nSource: ${r.sourceUrl} · ${r.license} · id ${r.id}`);
  }
  const p = body.payment ?? {};
  if (p.mode === "free") {
    lines.push(`[free trial lookup · ${p.remainingFreeLookups ?? 0} free left today · then $0.01 via x402 in USDC, PYUSD, or USDT]`);
  } else if (p.mode) {
    lines.push(`[paid $${(p.feeUsd ?? 0.01).toFixed(2)} ${p.asset ?? "USDC"}${p.transaction ? ` · tx ${p.transaction}` : ""}]`);
  }
  return lines.join("\n\n");
}


export function renderCheckText(status: number, raw: string): string {
  if (status !== 200) {
    if (status === 402) {
      return `Payment required: the shared free trial for today is used up. Pay the x402 challenge below ($0.01 in USDC, PYUSD, or USDT on Solana) and call again with paymentSignature set to your PAYMENT-SIGNATURE value.\n${raw}`;
    }
    return raw;
  }
  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    const lines: string[] = [];
    if (body.displayName || body.service) {
      lines.push(`# ${String(body.displayName ?? body.service)}${body.overall ? ` — ${String(body.overall)}` : ""}`);
    }
    const official = body.official as { state?: string; description?: string; statusUrl?: string } | null | undefined;
    if (official) {
      lines.push(`Official status: ${official.state ?? "unknown"}${official.description ? ` (${official.description})` : ""}${official.statusUrl ? `\nSource: ${official.statusUrl}` : ""}`);
    }
    const probe = body.probe as { reachable?: boolean; httpStatus?: number | null; latencyMs?: number | null; target?: string; note?: string | null } | undefined;
    if (probe && probe.target) {
      lines.push(`Probe: ${probe.reachable ? "reachable" : "unreachable"} HTTP ${probe.httpStatus ?? "n/a"} in ${probe.latencyMs ?? "?"}ms\nTarget: ${probe.target}${probe.note ? `\n${probe.note}` : ""}`);
    }
    const pricing = (body.pricing as { freshness?: string; plans?: Array<{ name: string; priceUsd: number | null; pricePeriod: string | null; priceNote: string | null; included: string | null; sourceUrl: string; verifiedAt: string | null }>; models?: Array<{ name: string; inputPerMillionUsd: number | null; outputPerMillionUsd: number | null }> | null } | undefined) ?? (body.plans ? body as typeof body & { plans: unknown } : undefined);
    const plans = (body.plans as PricingPlan[] | undefined) ?? pricing?.plans;
    if (plans && Array.isArray(plans)) {
      lines.push(`Pricing freshness: ${String((body.freshness ?? pricing?.freshness) ?? "unknown")}`);
      for (const p of plans) {
        const price = p.priceUsd == null ? "price not published here" : `$${p.priceUsd}${p.pricePeriod ? ` / ${p.pricePeriod}` : ""}`;
        lines.push(`## ${p.name}: ${price}\n${p.priceNote ?? ""}${p.included ? `\nIncluded: ${p.included}` : ""}\nSource: ${p.sourceUrl}${p.verifiedAt ? ` · verified ${p.verifiedAt}` : " · unverified"}`);
      }
    }
    const models = (Array.isArray(body.models) ? body.models : pricing && Array.isArray(pricing.models) ? pricing.models : []) as Array<{ name: string; inputPerMillionUsd: number | null; outputPerMillionUsd: number | null }>;
    if (models.length) {
      lines.push("Model rates (USD per 1M tokens, official page):");
      for (const m of models.slice(0, 12)) {
        lines.push(`- ${m.name}: in ${m.inputPerMillionUsd ?? "n/a"} / out ${m.outputPerMillionUsd ?? "n/a"}`);
      }
    }
    const pkg = body.package as { ecosystem?: string; name?: string; exists?: boolean; latest?: string | null; deprecated?: boolean | null; yanked?: boolean | null; registryUrl?: string } | undefined;
    // When the body itself is a package result
    const pkgBody = body.ecosystem && body.name ? body as typeof pkg : pkg;
    if (pkgBody && pkgBody.name) {
      lines.push(`Package ${pkgBody.ecosystem}:${pkgBody.name}: ${pkgBody.exists ? `exists, latest ${pkgBody.latest ?? "unknown"}` : "not found"}${pkgBody.deprecated ? " (deprecated)" : ""}${pkgBody.yanked ? " (yanked)" : ""}${pkgBody.registryUrl ? `\nRegistry: ${pkgBody.registryUrl}` : ""}`);
    }
    const payment = body.payment as { mode?: string; remainingFreeLookups?: number } | undefined;
    if (payment?.mode === "free") {
      lines.push(`[free trial check · ${payment.remainingFreeLookups ?? 0} free left today · then $0.01 via x402]`);
    } else if (payment?.mode) {
      lines.push(`[paid check · mode ${payment.mode}]`);
    }
    if (typeof body.disclaimer === "string") lines.push(body.disclaimer);
    return lines.filter(Boolean).join("\n\n") || raw;
  } catch {
    return raw;
  }
}

type PricingPlan = { name: string; priceUsd: number | null; pricePeriod: string | null; priceNote: string | null; included: string | null; sourceUrl: string; verifiedAt: string | null };
