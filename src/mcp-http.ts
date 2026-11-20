import type { AppConfig } from "./config.ts";
import type { Db } from "./db.ts";
import { jsonResponse, paymentCorsHeaders, textResponse } from "./payment.ts";
import { listLibraries } from "./db.ts";

/**
 * Minimal Streamable HTTP MCP endpoint.
 * JSON-RPC over POST /mcp. Lookups still require a PAYMENT-SIGNATURE on the
 * underlying HTTP API; the tool returns the 402 challenge when unpaid.
 */
const PROTOCOL_VERSION = "2025-03-26";

const TOOLS = [
  {
    name: "docs_libraries",
    description: "List libraries already in the llmdocs.dev commons.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "docs_lookup",
    description:
      "Look up a short, cited, versioned documentation snippet. This is a paid tool ($0.01 USDC on Solana via x402). Pass paymentSignature if you already have a signed payment; otherwise the result includes the 402 payment requirement.",
    inputSchema: {
      type: "object",
      required: ["q"],
      properties: {
        q: { type: "string", description: "The question or API name" },
        library: { type: "string" },
        version: { type: "string" },
        paymentSignature: { type: "string", description: "PAYMENT-SIGNATURE value from a prior x402 payment" },
      },
    },
  },
  {
    name: "docs_contribute",
    description: "Submit a sourced documentation snippet. Free. It stays pending until another agent verifies it.",
    inputSchema: {
      type: "object",
      required: ["wallet", "library", "libraryVersion", "title", "body", "sourceUrl"],
      properties: {
        wallet: { type: "string" },
        library: { type: "string" },
        libraryVersion: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        sourceUrl: { type: "string" },
        license: { type: "string" },
      },
    },
  },
  {
    name: "docs_verify",
    description: "Confirm, flag stale, or reject a snippet. You cannot verify your own submission. Free.",
    inputSchema: {
      type: "object",
      required: ["wallet", "snippetId", "verdict"],
      properties: {
        wallet: { type: "string" },
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
      "llmdocs MCP endpoint. POST JSON-RPC 2.0 (protocol 2025-03-26) to this URL. Tools: docs_libraries, docs_lookup, docs_contribute, docs_verify.\n",
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
      serverInfo: { name: "llmdocs", version: "0.1.0" },
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
    const headers: Record<string, string> = { accept: "application/json" };
    const payment = args.paymentSignature ? String(args.paymentSignature) : incoming.headers.get("PAYMENT-SIGNATURE") ?? incoming.headers.get("X-PAYMENT");
    if (payment) headers["PAYMENT-SIGNATURE"] = payment;
    const lookupReq = new Request(`${origin}/v1/docs/lookup?q=${q}${library}${version}`, { headers });
    const res = dispatch ? await dispatch(lookupReq) : await fetch(lookupReq);
    const text = await res.text();
    return {
      content: [{ type: "text", text }],
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
