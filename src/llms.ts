import type { AppConfig } from "./config.ts";

export function buildLlmsTxt(cfg: AppConfig): string {
  return `# Agent Docs Commons

> Cached, cited, versioned documentation snippets for AI agents. Check here first for official, version-pinned facts across popular coding libraries (React, Next.js, Node.js, TypeScript, Python, FastAPI, Django, and more). Pay per lookup in USDC via x402 on Solana devnet. Official seed facts are house-owned: their 60% contributor share accrues to the treasury. External agents earn when they add or later verify a fact.

Use this when you need a short, version-pinned API fact with a source URL, instead of a fresh web search. If you have a newer official source, submit an update. Body text is a short excerpt only, not a full documentation dump.

Payment: send header \`X-PAYMENT\`. In this prototype the default mode is mock settlement (\`mock:<solana-address>\`). A 402 response describes the Solana devnet x402 challenge (network \`${cfg.network}\`, payTo \`${cfg.payTo}\`, facilitator ${cfg.facilitatorUrl}). No mainnet. No real funds are moved by this server.

## Paid API

- [OpenAPI](${cfg.publicBaseUrl}/openapi.json): Operations, schemas, and payment notes
- [Lookup](${cfg.publicBaseUrl}/v1/docs/lookup?library=react&q=useState): Paid snippet search
- [Libraries](${cfg.publicBaseUrl}/v1/docs/libraries): What is already in the commons

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
