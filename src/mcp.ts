/**
 * Minimal MCP stdio server. Tools wrap the local HTTP API.
 * Start the HTTP server first (`npm start`), then `npm run mcp`.
 */
import { loadConfig } from "./config.ts";
import { LOOKUP_TOOL_DESCRIPTION } from "./descriptions.ts";

type JsonRpc = {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};

const cfg = loadConfig();
const base = process.env.COMMONS_URL ?? cfg.publicBaseUrl;
const payer = process.env.MCP_PAYER ?? "BDkdaa5aHZZooaG2dRRMzBNe33PzTqZoZyQaBxVrdzi7";

const TOOLS = [
  {
    name: "docs_lookup",
    description: LOOKUP_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      required: ["q"],
      properties: {
        q: { type: "string", description: "The question or API name" },
        library: { type: "string", description: "Library slug, e.g. react, stripe, openai, langchain, aws-sdk, boto3" },
        version: { type: "string" },
        ref: { type: "string", description: "Referrer Solana address" },
      },
    },
  },
  {
    name: "docs_contribute",
    description: "Submit a sourced documentation snippet. It stays pending until another agent verifies it.",
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
    description: "Confirm, flag stale, or reject a snippet. You cannot verify your own submission.",
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
  {
    name: "docs_libraries",
    description: "List libraries already in the commons.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "preflight",
    description: "Check status, package health, and cited pricing before relying on a service.",
    inputSchema: { type: "object", properties: { service: { type: "string" }, url: { type: "string" }, ecosystem: { type: "string" }, name: { type: "string" } } },
  },
  {
    name: "check_status",
    description: "Probe a public URL or known service for reachability.",
    inputSchema: { type: "object", properties: { service: { type: "string" }, url: { type: "string" } } },
  },
  {
    name: "check_package",
    description: "Check a package on npm, PyPI, crates.io, or the Go module proxy.",
    inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" }, ecosystem: { type: "string" } } },
  },
  {
    name: "get_pricing",
    description: "Cited official plan and limit facts for a seeded service.",
    inputSchema: { type: "object", required: ["service"], properties: { service: { type: "string" } } },
  },
  {
    name: "list_check_services",
    description: "List seeded services for preflight and pricing. Free.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function callApi(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

async function handleTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === "docs_lookup") {
    const q = new URLSearchParams();
    q.set("q", String(args.q ?? ""));
    if (args.library) q.set("library", String(args.library));
    if (args.version) q.set("version", String(args.version));
    if (args.ref) q.set("ref", String(args.ref));
    return callApi(`/v1/docs/lookup?${q.toString()}`, {
      headers: { "X-PAYMENT": `mock:${payer}` },
    });
  }
  if (name === "docs_contribute") {
    return callApi("/v1/contribute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
  }
  if (name === "docs_verify") {
    return callApi("/v1/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
  }
  if (name === "docs_libraries") {
    return callApi("/v1/docs/libraries");
  }
  if (name === "list_check_services") {
    return callApi("/v1/check/services");
  }
  const checkPaths: Record<string, string> = {
    preflight: "/v1/check/preflight",
    check_status: "/v1/check/status",
    check_package: "/v1/check/package",
    get_pricing: "/v1/check/pricing",
  };
  if (checkPaths[name]) {
    const q = new URLSearchParams();
    if (args.service) q.set("service", String(args.service));
    if (args.url) q.set("url", String(args.url));
    if (args.ecosystem) q.set("ecosystem", String(args.ecosystem));
    if (args.name) q.set("name", String(args.name));
    const qs = q.toString();
    return callApi(`${checkPaths[name]}${qs ? `?${qs}` : ""}`, {
      headers: { "X-PAYMENT": `mock:${payer}` },
    });
  }
  throw new Error(`Unknown tool: ${name}`);
}

function write(msg: JsonRpc): void {
  const body = JSON.stringify(msg);
  const frame = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
  process.stdout.write(frame);
}

function reply(id: JsonRpc["id"], result: unknown): void {
  write({ jsonrpc: "2.0", id: id ?? null, result });
}

function fail(id: JsonRpc["id"], message: string): void {
  write({ jsonrpc: "2.0", id: id ?? null, error: { code: -32000, message } });
}

async function onMessage(msg: JsonRpc): Promise<void> {
  const method = msg.method ?? "";
  if (method === "initialize") {
    reply(msg.id, {
      protocolVersion: "2024-11-05",
      serverInfo: { name: "agent-docs-commons", version: "0.1.0" },
      capabilities: { tools: {} },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") {
    return;
  }
  if (method === "tools/list") {
    reply(msg.id, { tools: TOOLS });
    return;
  }
  if (method === "tools/call") {
    const name = String(msg.params?.name ?? "");
    const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = await handleTool(name, args);
      reply(msg.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    } catch (err) {
      fail(msg.id, err instanceof Error ? err.message : "tool_error");
    }
    return;
  }
  if (method === "ping") {
    reply(msg.id, {});
    return;
  }
  if (msg.id != null) fail(msg.id, `Unknown method ${method}`);
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) break;
    const body = buffer.subarray(start, start + length).toString("utf8");
    buffer = buffer.subarray(start + length);
    void onMessage(JSON.parse(body) as JsonRpc);
  }
});

process.stdin.on("end", () => process.exit(0));
console.error(`MCP wrapper talking to ${base} (mock payer ${payer})`);
