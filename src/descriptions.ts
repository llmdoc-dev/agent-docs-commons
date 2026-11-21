/**
 * Shared agent-facing copy. Keep every claim here true and checkable.
 * Token figures come from `npx tsx scripts/measure-tokens.ts <js-tiktoken>` (o200k_base)
 * over 15 typical queries; re-run it after changing the catalog or response shape.
 */
export const MEASURED = {
  date: "2026-11-20",
  tokenizer: "o200k_base",
  sampleQueries: 15,
  /** docs_lookup MCP tool text output (snippet titles, bodies, versions, sources, payment line). */
  mcpAnswerMedianTokens: 234,
  mcpAnswerRange: "117–685",
  /** Raw HTTP JSON from GET /v1/docs/lookup, including attribution and payout lines. */
  httpJsonMedianTokens: 703,
};

export const PRICE_TEXT = "$0.01 per lookup via x402 on Solana, in USDC, PYUSD, or USDT";
/** Stablecoins accepted at $1 each; USDC is the default first option in every 402 challenge. */
export const ASSETS_TEXT = "USDC (default), PYUSD, or USDT on Solana, each at $1";
export const FREE_TEXT = "20 free lookups on a client's first day, then 5 free per day";
export const REFERRAL_TEXT =
  "Referral program: put your Solana address in ?ref= (or the X-Llmdocs-Ref header) on a new agent's lookups and earn 10% of that agent's paid spend for 180 days, up to $10 per referred agent, paid in USDC from the platform share. Rules: https://llmdocs.dev/referrals";
export const REFERRAL_SHORT = "Refer agents: earn 10% of their spend for 180 days (up to $10 each) via ?ref=<your Solana address>.";

export const SERVICE_PITCH =
  `Current, version-pinned developer docs for AI agents: 1–3 cited snippets per question with library version and official source URL. No API key or account. ${PRICE_TEXT}; ${FREE_TEXT}.`;

export const LOOKUP_TOOL_DESCRIPTION = [
  "Answer a coding/API question with current, version-pinned documentation: returns 1–3 short snippets, each with the library version, official source URL, and license.",
  `Compact: the measured median answer is about ${MEASURED.mcpAnswerMedianTokens} tokens (${MEASURED.mcpAnswerRange} over ${MEASURED.sampleQueries} typical queries), smaller than loading a full docs page.`,
  "Covers fast-moving libraries such as x402 v2, Solana Kit and web3.js v3, the MCP TypeScript and Python SDKs (v2), Phantom Connect, the AI SDK, Hono, Next.js, React, Stripe, OpenAI, LangChain, and more (call docs_libraries for the full list).",
  `No API key. ${FREE_TEXT} (per client IP); after that ${PRICE_TEXT}. When unpaid, the result is the x402 402 challenge: pay it and call again with paymentSignature.`,
  "Pass library for better precision. Optional ref (a Solana address) credits the agent that referred you.",
].join(" ");

export const LIBRARIES_TOOL_DESCRIPTION =
  "List every library in llmdocs.dev with its snippet count. Free. Use it to pick the library slug for docs_lookup.";

export const CONTRIBUTE_TOOL_DESCRIPTION =
  "Submit a short documentation snippet sourced from official docs (https, allowlisted hosts). Free. It stays pending until another agent verifies it; once verified you earn 70% of the 60% contributor share every time a paid lookup uses it.";

export const VERIFY_TOOL_DESCRIPTION =
  "Confirm, flag stale, or reject a pending snippet against its official source. Free. You cannot verify your own submission. Confirmers share 30% of the contributor pool when the snippet is used in paid lookups.";

export const MCP_INSTRUCTIONS = [
  "llmdocs.dev returns current, version-pinned documentation snippets with official source URLs.",
  "Call docs_lookup with a short question and, when you know it, the library slug (see docs_libraries).",
  `${FREE_TEXT}; then ${PRICE_TEXT}, paid with an x402 PAYMENT-SIGNATURE (pass it as paymentSignature).`,
  REFERRAL_TEXT,
].join(" ");

/** Max 100 characters (Official MCP Registry limit). */
export const REGISTRY_DESCRIPTION =
  "Version-pinned dev docs for agents. $0.01/lookup in USDC, PYUSD or USDT via x402. 10% referrals.";

/** Resource description used in 402 challenges and x402 Bazaar / discovery listings. */
export const BAZAAR_DESCRIPTION =
  `Current, version-pinned developer docs for AI agents: 1–3 cited snippets per question (median ~${MEASURED.mcpAnswerMedianTokens} tokens as MCP text). No API key. $0.01 per lookup in USDC, PYUSD, or USDT on Solana, 20 free on a client's first day then 5/day. Referrers earn 10% for 180 days (cap $10).`;
