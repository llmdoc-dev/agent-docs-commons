import type { AppConfig } from "./config.ts";

export function buildOpenApi(cfg: AppConfig): Record<string, unknown> {
  const paymentHeader = {
    name: "X-PAYMENT",
    in: "header",
    required: true,
    description:
      cfg.paymentMode === "mock"
        ? "Prototype mock settlement: mock:<solana-address>. A 402 response describes the real Solana-devnet x402 challenge."
        : "x402 payment payload for Solana devnet USDC.",
    schema: { type: "string" },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "Agent Docs Commons",
      version: "0.1.0",
      description:
        "Pay-per-call, cited, versioned documentation snippets for AI agents. Contributors earn 60% of each query fee when their accepted facts are used. Solana devnet / mock payments only.",
    },
    servers: [{ url: cfg.publicBaseUrl }],
    paths: {
      "/health": {
        get: { summary: "Liveness and payment mode", responses: { "200": { description: "OK" } } },
      },
      "/llms.txt": {
        get: { summary: "Agent-oriented site index", responses: { "200": { description: "Markdown" } } },
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
          responses: {
            "200": { description: "Snippets plus payout attribution" },
            "402": { description: "Payment required (x402 challenge)" },
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
