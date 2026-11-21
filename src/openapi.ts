import type { AppConfig } from "./config.ts";

export function buildOpenApi(cfg: AppConfig): Record<string, unknown> {
  const paymentHeader = {
    name: "PAYMENT-SIGNATURE",
    in: "header",
    required: true,
    description:
      cfg.paymentMode === "mock"
        ? "Local/test mock settlement: mock:<solana-address>. A 402 response describes the x402 v2 requirement."
        : "x402 v2 PAYMENT-SIGNATURE (or X-PAYMENT) for Solana USDC.",
    schema: { type: "string" },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "Agent Docs Commons",
      version: "0.1.0",
      description:
        "Pay-per-call, cited, versioned documentation snippets for AI agents. Contributors earn 60% of each query fee when their accepted facts are used.",
      contact: { email: "dyvnkcxp@mail.grokbot.com", url: cfg.publicBaseUrl },
      "x-guidance":
        "Start at /llms.txt. Unpaid GET /v1/docs/lookup returns HTTP 402 (x402 v2 exact USDC on Solana). Retry with a PAYMENT-SIGNATURE header. Contribute and verify are free. No API keys.",
    },
    servers: [{ url: cfg.publicBaseUrl }],
    paths: {
      "/": {
        get: { summary: "Human landing page with a public catalog of titles", responses: { "200": { description: "HTML" } } },
      },
      "/browse": {
        get: { summary: "Human-readable catalog of snippet titles and short previews", responses: { "200": { description: "HTML" } } },
      },
      "/health": {
        get: { summary: "Liveness and payment mode", responses: { "200": { description: "OK" } } },
      },
      "/.well-known/x402": {
        get: { summary: "x402 discovery document", responses: { "200": { description: "OK" } } },
      },
      "/mcp": {
        post: { summary: "Remote MCP JSON-RPC endpoint", responses: { "200": { description: "JSON-RPC" } } },
      },
      "/llms.txt": {
        get: { summary: "Agent-oriented site index", responses: { "200": { description: "Markdown" } } },
      },
      "/robots.txt": {
        get: { summary: "Crawler rules and content signals", responses: { "200": { description: "text" } } },
      },
      "/sitemap.xml": {
        get: { summary: "Public URL list", responses: { "200": { description: "XML" } } },
      },
      "/v1/docs/libraries": {
        get: { summary: "List seeded and contributed libraries", responses: { "200": { description: "OK" } } },
      },
      "/v1/docs/lookup": {
        get: {
          summary: "Paid lookup of short cited snippets",
          parameters: [
            paymentHeader,
            { name: "q", in: "query", required: true, schema: { type: "string" } },
            { name: "library", in: "query", required: false, schema: { type: "string", examples: ["react", "express", "zod"] } },
            { name: "version", in: "query", required: false, schema: { type: "string" } },
          ],
          "x-payment-info": {
            protocols: [
              {
                name: "x402",
                version: 2,
                scheme: "exact",
                network: cfg.network,
                asset: cfg.asset,
                payTo: cfg.payTo,
                amount: String(Math.round(cfg.priceLookupUsd * 1_000_000)),
                currency: "USDC",
                facilitator: cfg.facilitatorUrl,
              },
            ],
            fixed: cfg.priceLookupUsd,
            currency: "USDC",
          },
          responses: {
            "200": { description: "Snippets plus payout attribution" },
            "402": { description: "Payment required (x402 challenge with PAYMENT-REQUIRED header)" },
          },
        },
      },
      "/v1/contribute": {
        post: {
          summary: "Submit a sourced, versioned snippet",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["wallet", "library", "libraryVersion", "title", "body", "sourceUrl"],
                  properties: {
                    wallet: { type: "string" },
                    library: { type: "string" },
                    libraryVersion: { type: "string" },
                    title: { type: "string" },
                    body: { type: "string", maxLength: 1500 },
                    sourceUrl: { type: "string", format: "uri" },
                    license: { type: "string" },
                    retrievedAt: { type: "string" },
                  },
                },
              },
            },
          },
          responses: { "201": { description: "Pending snippet" }, "400": { description: "Rejected by quality checks" } },
        },
      },
      "/v1/verify": {
        post: {
          summary: "Confirm, flag stale, or reject a snippet. You cannot verify your own submission.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
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
            },
          },
          responses: { "200": { description: "Updated status" } },
        },
      },
      "/v1/records/{id}": {
        get: {
          summary: "One snippet plus verification history",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "OK" }, "404": { description: "Not found" } },
        },
      },
      "/v1/payouts/dry-run": {
        post: {
          summary: "Run the payout job in dry-run mode (no USDC sent)",
          responses: { "200": { description: "What would be paid" } },
        },
      },
    },
  };
}
