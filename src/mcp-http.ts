import type { AppConfig } from "./config.ts";
import type { Db } from "./db.ts";
import { jsonResponse, paymentCorsHeaders, textResponse } from "./payment.ts";
import { listLibraries } from "./db.ts";
import {
  CONTRIBUTE_TOOL_DESCRIPTION,
  LIBRARIES_TOOL_DESCRIPTION,
  LOOKUP_TOOL_DESCRIPTION,
  MCP_INSTRUCTIONS,
  VERIFY_TOOL_DESCRIPTION,
} from "./descriptions.ts";

/**
 * Minimal Streamable HTTP MCP endpoint.
 * JSON-RPC over POST /mcp. Lookups still require a PAYMENT-SIGNATURE on the
 * underlying HTTP API; the tool returns the 402 challenge when unpaid.
 */
const PROTOCOL_VERSION = "2025-03-26";

export const MCP_SERVER_VERSION = "0.2.0";

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
      `llmdocs MCP endpoint (Streamable HTTP, JSON responses). POST JSON-RPC 2.0 to this URL. Tools: docs_lookup, docs_libraries, docs_contribute, docs_verify.\n\n${MCP_INSTRUCTIONS}\n\nInstall: claude mcp add --transport http llmdocs ${cfg.publicBaseUrl}/mcp  |  Cursor/VS Code: see ${cfg.publicBaseUrl}/#install\n`,
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
  payment?: { mode?: string; feeUsd?: number; remainingFreeLookups?: number; transaction?: string | null };
};

/** Compact text for agents: snippets with version and source, plus one payment line. */
export function renderLookupText(status: number, raw: string, origin: string): string {
  if (status !== 200) {
    if (status === 402) {
      return `Payment required: the free trial for today is used up. Pay the x402 challenge below ($0.01 USDC on Solana) and call docs_lookup again with paymentSignature set to your PAYMENT-SIGNATURE value.\n${raw}`;
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
    lines.push(`[free trial lookup · ${p.remainingFreeLookups ?? 0} free left today · then $0.01 USDC via x402]`);
  } else if (p.mode) {
    lines.push(`[paid $${(p.feeUsd ?? 0.01).toFixed(2)} USDC${p.transaction ? ` · tx ${p.transaction}` : ""}]`);
  }
  return lines.join("\n\n");
}
