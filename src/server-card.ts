import { acceptedAssetsPublic, type AppConfig } from "./config.ts";
import { MCP_INSTRUCTIONS, SERVICE_PITCH } from "./descriptions.ts";
import { MCP_SERVER_VERSION, TOOLS } from "./mcp-http.ts";

/** Static MCP server card (SEP-1649 style) so directories can list tools without a live scan. */
export function serverCard(cfg: AppConfig): Record<string, unknown> {
  return {
    serverInfo: { name: "llmdocs", title: "llmdocs.dev", version: MCP_SERVER_VERSION },
    description: SERVICE_PITCH,
    instructions: MCP_INSTRUCTIONS,
    websiteUrl: cfg.publicBaseUrl,
    transport: { type: "streamable-http", url: `${cfg.publicBaseUrl}/mcp` },
    authentication: { required: false, schemes: [] },
    payment: {
      protocol: "x402",
      version: 2,
      scheme: "exact",
      network: cfg.network,
      asset: cfg.asset,
      assets: acceptedAssetsPublic(cfg).map((a) => ({ symbol: a.symbol, mint: a.mint, tokenProgram: a.tokenProgram, default: a.default })),
      priceUsd: cfg.priceLookupUsd,
      discovery: `${cfg.publicBaseUrl}/.well-known/x402`,
    },
    referrals: {
      share: 0.1,
      windowDays: 180,
      capUsdPerReferredAgent: 10,
      how: "Pass ref=<your Solana address> to docs_lookup, ?ref= on HTTP lookups, or the X-Llmdocs-Ref header.",
      rules: `${cfg.publicBaseUrl}/referrals`,
    },
    tools: TOOLS,
    resources: [],
    prompts: [],
  };
}
