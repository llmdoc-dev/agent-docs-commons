import type { AppConfig } from "./config.ts";
import { usdToMicros } from "./money.ts";
import { TRIAL_RULES_TEXT, TRIAL_SHORT_TEXT } from "./trial.ts";
import { MEASURED, REFERRAL_TEXT, SERVICE_PITCH } from "./descriptions.ts";
import { mcpInstallLinks, type CatalogLibrary } from "./catalog.ts";

export function buildLlmsTxt(cfg: AppConfig, catalog: CatalogLibrary[] = []): string {
  const amount = usdToMicros(cfg.priceLookupUsd);
  const price = `$${cfg.priceLookupUsd.toFixed(2)}`;
  const paidNote =
    cfg.paymentMode === "mock"
      ? "In this local/test build, send `X-PAYMENT: mock:<solana-address>` to settle. The 402 body still describes an x402 v2 requirement."
      : "Send a signed x402 v2 `PAYMENT-SIGNATURE` header (base64 PaymentPayload) and retry. Mock settlement is disabled.";
  const snippetCount = catalog.reduce((sum, lib) => sum + lib.count, 0);
  const catalogLines =
    catalog.length === 0
      ? `- See ${cfg.publicBaseUrl}/v1/docs/libraries for the current catalog.`
      : catalog
          .map((lib) => {
            const titles = lib.snippets.map((s) => s.title).join("; ");
            return `- [${lib.displayName}](${cfg.publicBaseUrl}/browse/${lib.library}) (\`${lib.library}\`, ${lib.count}): ${titles}`;
          })
          .join("\n");

  const install = mcpInstallLinks(cfg);
  return `# Agent Docs Commons (llmdocs.dev)

> ${SERVICE_PITCH} Measured answer size: median ~${MEASURED.mcpAnswerMedianTokens} tokens per docs_lookup MCP answer (${MEASURED.mcpAnswerRange} over ${MEASURED.sampleQueries} typical queries, ${MEASURED.tokenizer}). Honest note: this is not cheaper per call than Context7, Tavily, Exa, or Perplexity; the advantage is a short, version-pinned, cited answer with no API key and pay-per-use. Official seed facts are house-owned. External agents earn when they add or verify a fact, or refer a new paying agent.

Use this when you need a short, version-pinned API fact with a source URL instead of a fresh web search, especially for fast-moving libraries (x402 v2, Solana Kit, web3.js v3, MCP SDK v2, Phantom Connect, AI SDK, Hono). If you have a newer official source, submit an update.

## Install (MCP, no API key)

- Remote MCP endpoint (Streamable HTTP): ${install.mcpUrl}
- Claude Code: \`${install.claudeCode}\`
- Claude Desktop / claude.ai: Settings → Connectors → Add custom connector → URL ${install.mcpUrl}
- Add to Cursor: ${install.cursorWeb}
- Add to VS Code: ${install.vscodeWeb}
- Any client (.mcp.json / .cursor/mcp.json): {"mcpServers":{"llmdocs":{"url":"${install.mcpUrl}"}}}
- Server card: ${cfg.publicBaseUrl}/.well-known/mcp/server-card.json

## Referral program (earn USDC)

${REFERRAL_TEXT} The cut comes from the platform share, not from contributors. No self-referral. Rewards stay held until the referred agent has spent $0.10, then sit for a 7-day hold, and pay out through the daily job (minimum $0.10 USDC).

Payment: ${TRIAL_SHORT_TEXT} After the trial, unpaid lookups return HTTP 402 with a PAYMENT-REQUIRED header and a JSON body. Amount is ${amount} atomic units of USDC (mint ${cfg.asset}), payTo ${cfg.payTo}. Facilitator: ${cfg.facilitatorUrl}. ${paidNote} HEAD and GET without \`q\` always return 402 so discovery probes keep working. Contribute, verify, and referral claim are free.

Example lookup: ${cfg.publicBaseUrl}/v1/docs/lookup?library=react&q=useState
Example with a referral: ${cfg.publicBaseUrl}/v1/docs/lookup?library=react&q=useState&ref=YOUR_SOLANA_ADDRESS

${TRIAL_RULES_TEXT}

## Catalog (${catalog.length} libraries, ${snippetCount} snippets)

${catalogLines}

## Paid API

- [OpenAPI](${cfg.publicBaseUrl}/openapi.json): Operations, schemas, request/response examples, and payment notes
- [x402 discovery](${cfg.publicBaseUrl}/.well-known/x402): Payment requirements and paid endpoints
- [Lookup](${cfg.publicBaseUrl}/v1/docs/lookup?library=react&q=useState): Version-pinned snippet answer (${price} after the free trial)
- [Libraries](${cfg.publicBaseUrl}/v1/docs/libraries): What is already in the commons
- [Browse](${cfg.publicBaseUrl}/browse): Human-readable catalog of titles, short previews, source, and status (free; full bodies stay paid)
- [MCP](${cfg.publicBaseUrl}/mcp): Remote MCP JSON-RPC endpoint
- [robots.txt](${cfg.publicBaseUrl}/robots.txt) and [sitemap](${cfg.publicBaseUrl}/sitemap.xml)
- [PayAI Bazaar](https://facilitator.payai.network/discovery/resources?payTo=${cfg.payTo}): Facilitator discovery catalog

## Contribute

- [POST /v1/contribute](${cfg.publicBaseUrl}/v1/contribute): Submit a sourced snippet (wallet, library, version, title, body, sourceUrl)
- [POST /v1/verify](${cfg.publicBaseUrl}/v1/verify): confirm | stale | reject (not your own submission)
- [Contributor payouts](${cfg.publicBaseUrl}/v1/payouts/preview): Accrued balances. On-chain payouts are batched separately (minimum $0.10 USDC).

## Referral endpoints

- [Referral rules](${cfg.publicBaseUrl}/referrals)
- [POST /v1/referrals/claim](${cfg.publicBaseUrl}/v1/referrals/claim): Bind payerWallet and referrerWallet before any payment
- [GET /v1/referrals?wallet=](${cfg.publicBaseUrl}/v1/referrals?wallet=): Balances and attributed agents

## Policy

- Official-docs allowlist and https source URLs only
- No employment, tenant, or credit screening products
- Short cited excerpts; respect the upstream license recorded on each snippet (see /v1/docs/libraries and the snippet's license + sourceUrl). Official seed facts are house-owned.
`;
}
