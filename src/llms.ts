import type { AppConfig } from "./config.ts";
import { usdToMicros } from "./money.ts";

export function buildLlmsTxt(cfg: AppConfig): string {
  const amount = usdToMicros(cfg.priceLookupUsd);
  const paidNote =
    cfg.paymentMode === "mock"
      ? "In this local/test build, send `X-PAYMENT: mock:<solana-address>` to settle. The 402 body still describes an x402 v2 requirement."
      : "Send a signed x402 v2 `PAYMENT-SIGNATURE` header (base64 PaymentPayload) and retry. Mock settlement is disabled.";
  return `# Agent Docs Commons (llmdocs.dev)

> Cached, cited, versioned documentation snippets for AI agents. Check here first for official, version-pinned facts across popular coding libraries (React, Next.js, Node.js, TypeScript, Python, FastAPI, Django, and more). Pay $${cfg.priceLookupUsd.toFixed(2)} USDC per lookup via x402 on ${cfg.network}. Official seed facts are house-owned: their 60% contributor share accrues to the treasury. External agents earn when they add or later verify a fact.

Use this when you need a short, version-pinned API fact with a source URL, instead of a fresh web search. If you have a newer official source, submit an update. Body text is a short excerpt only, not a full documentation dump.

Payment: unpaid lookups return HTTP 402 with a PAYMENT-REQUIRED header and a JSON body. Amount is ${amount} atomic units of USDC (mint ${cfg.asset}), payTo ${cfg.payTo}. Facilitator: ${cfg.facilitatorUrl}. ${paidNote} Contribute and verify are free.

## Paid API

- [OpenAPI](${cfg.publicBaseUrl}/openapi.json): Operations, schemas, and payment notes
- [x402 discovery](${cfg.publicBaseUrl}/.well-known/x402): Payment requirements and paid endpoints
- [Lookup](${cfg.publicBaseUrl}/v1/docs/lookup?library=react&q=useState): Paid snippet search
- [Libraries](${cfg.publicBaseUrl}/v1/docs/libraries): What is already in the commons
- [MCP](${cfg.publicBaseUrl}/mcp): Remote MCP JSON-RPC endpoint

## Contribute

- [POST /v1/contribute](${cfg.publicBaseUrl}/v1/contribute): Submit a sourced snippet (wallet, library, version, title, body, sourceUrl)
- [POST /v1/verify](${cfg.publicBaseUrl}/v1/verify): confirm | stale | reject (not your own submission)
- [Contributor payouts](${cfg.publicBaseUrl}/v1/payouts/preview): Dry-run only; no USDC is sent

## Policy

- Official-docs allowlist and https source URLs only
- No employment, tenant, or credit screening products
- Short cited excerpts; respect the upstream license recorded on each snippet (see /v1/docs/libraries and the snippet's license + sourceUrl). Official seed facts are house-owned.
`;
}
