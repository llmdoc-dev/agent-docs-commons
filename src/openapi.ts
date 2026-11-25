import { acceptedAssetsSentence, type AppConfig } from "./config.ts";
import { MEASURED, REFERRAL_SHORT, REFERRAL_TEXT, SERVICE_PITCH } from "./descriptions.ts";

export function buildOpenApi(cfg: AppConfig): Record<string, unknown> {
  const paymentHeader = {
    name: "PAYMENT-SIGNATURE",
    in: "header",
    required: true,
    description:
      cfg.paymentMode === "mock"
        ? "Local/test mock settlement: mock:<solana-address>. A 402 response describes the x402 v2 requirement."
        : `x402 v2 PAYMENT-SIGNATURE (or X-PAYMENT) on Solana, paying ${acceptedAssetsSentence(cfg)} (each at $1; pick one entry from the 402 accepts list).`,
    schema: { type: "string" },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "Agent Docs Commons",
      version: "0.2.0",
      description: `${SERVICE_PITCH} Measured answer size: median ~${MEASURED.mcpAnswerMedianTokens} tokens as MCP text, ~${MEASURED.httpJsonMedianTokens} tokens as full HTTP JSON (${MEASURED.tokenizer}, ${MEASURED.sampleQueries} typical queries, ${MEASURED.date}). ${REFERRAL_TEXT} Contributors earn 60% of each paid lookup fee that uses their verified facts. Honest note: per call this is not cheaper than Context7, Tavily, Exa, or Perplexity; the pitch is short version-pinned answers, no API key, and pay-per-use.`,
      contact: { email: "dyvnkcxp@mail.grokbot.com", url: cfg.publicBaseUrl },
      "x-guidance":
        "Start at /llms.txt or /v1/docs/libraries. GET /v1/docs/lookup?library=<slug>&q=<question>: the first 20 unpaid lookups on a client's first UTC day are free, then 5 per day; after that it returns HTTP 402 (x402 v2 exact on Solana; accepts USDC (default), PYUSD, or USDT at $1 each). Retry with a PAYMENT-SIGNATURE header. Add ref=<your Solana address> to earn 10% of a referred agent's spend. Contribute and verify are free. No API keys.",
      "x-referral-program": { share: 0.1, windowDays: 180, capUsdPerReferredAgent: 10, rules: `${cfg.publicBaseUrl}/referrals` },
    },
    servers: [{ url: cfg.publicBaseUrl }],
    paths: {
      "/": {
        get: { summary: "Landing page: catalog titles, pricing, and one-click MCP install links", responses: { "200": { description: "HTML" } } },
      },
      "/browse": {
        get: { summary: "Human-readable catalog of snippet titles and short previews", responses: { "200": { description: "HTML" } } },
      },
      "/browse/{library}": {
        get: {
          summary: "Indexable per-library page: snippet titles, previews (max 120 chars), versions, and how to buy",
          parameters: [{ name: "library", in: "path", required: true, schema: { type: "string" }, example: "x402" }],
          responses: { "200": { description: "HTML" }, "404": { description: "Library not in the catalog" } },
        },
      },

      "/check": {
        get: { summary: "Human page: preflight status, package health, and cited pricing facts", responses: { "200": { description: "HTML" } } },
      },
      "/v1/check/services": {
        get: { summary: "List seeded services for preflight and pricing (free)", responses: { "200": { description: "JSON" } } },
      },
      "/v1/check/preflight": {
        get: {
          summary: "Combined status, package, and cited pricing check",
          description: "Shares the docs lookup free daily cap, then $0.01 via x402. Pass service, url, and/or package name. Pricing fields are null when unverified.",
          parameters: [
            { name: "service", in: "query", schema: { type: "string" }, example: "openai" },
            { name: "url", in: "query", schema: { type: "string" }, description: "Public https URL to probe" },
            { name: "ecosystem", in: "query", schema: { type: "string", enum: ["npm", "pypi", "crates", "go"] } },
            { name: "name", in: "query", schema: { type: "string" }, description: "Package name for a registry check" },
            { name: "PAYMENT-SIGNATURE", in: "header", required: false, schema: { type: "string" } },
          ],
          responses: { "200": { description: "Preflight JSON" }, "402": { description: "Payment required" }, "400": { description: "Missing params" }, "404": { description: "Unknown service" } },
        },
      },
      "/v1/check/status": {
        get: {
          summary: "Reachability probe and official status",
          description: "Shares the docs lookup free daily cap, then $0.01 via x402.",
          parameters: [
            { name: "service", in: "query", schema: { type: "string" } },
            { name: "url", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "Status JSON" }, "402": { description: "Payment required" } },
        },
      },
      "/v1/check/pricing": {
        get: {
          summary: "Cited plan and limit facts from official pages",
          description: "Shares the docs lookup free daily cap, then $0.01 via x402. Unknown figures are null.",
          parameters: [{ name: "service", in: "query", required: true, schema: { type: "string" }, example: "supabase" }],
          responses: { "200": { description: "Pricing JSON" }, "402": { description: "Payment required" }, "404": { description: "Unknown service" } },
        },
      },
      "/v1/check/package": {
        get: {
          summary: "Official registry package health",
          description: "Shares the docs lookup free daily cap, then $0.01 via x402.",
          parameters: [
            { name: "ecosystem", in: "query", schema: { type: "string", enum: ["npm", "pypi", "crates", "go"] }, example: "npm" },
            { name: "name", in: "query", required: true, schema: { type: "string" }, example: "request" },
          ],
          responses: { "200": { description: "Package JSON" }, "402": { description: "Payment required" } },
        },
      },
      "/.well-known/mcp/server-card.json": {
        get: { summary: "Static MCP server card: tools, transport, pricing, referral terms", responses: { "200": { description: "JSON" } } },
      },
      "/referrals": {
        get: { summary: "Referral program: earn 10% of a referred agent's paid spend for 180 days, up to $10 per agent", responses: { "200": { description: "HTML" } } },
      },
      "/health": {
        get: { summary: "Liveness and payment mode", responses: { "200": { description: "OK" } } },
      },
      "/.well-known/x402": {
        get: { summary: "x402 discovery: payment requirements, free trial, answer size, and referral terms", responses: { "200": { description: "OK" } } },
      },
      "/mcp": {
        post: { summary: "Remote MCP endpoint (Streamable HTTP): docs_lookup, docs_libraries, docs_contribute, docs_verify, preflight, check_status, check_package, get_pricing, list_check_services", responses: { "200": { description: "JSON-RPC" } } },
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
      "/v1/stats": {
        get: {
          summary: "Public aggregate usage stats",
          description:
            "Totals and daily series for lookups, revenue, ledger buckets, referrals, contributions, and payouts. No IP addresses, identity hashes, or individual payer wallets are included. Main-wallet balances are read from a public Solana RPC.",
          responses: { "200": { description: "Aggregate-only JSON" } },
        },
      },
      "/v1/docs/libraries": {
        get: {
          summary: "List every library and snippet count (free)",
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  examples: {
                    libraries: {
                      summary: "Library list",
                      value: {
                        libraries: [
                          { library: "react", count: 5 },
                          { library: "stripe", count: 4 },
                          { library: "openai", count: 4 },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/v1/docs/lookup": {
        get: {
          summary: "Version-pinned docs answer: 1–3 cited snippets for a question ($0.01 USDC after the free trial)",
          description: `Returns up to 3 short snippets with library version, official source URL, and license. Median full JSON response ~${MEASURED.httpJsonMedianTokens} tokens; the docs_lookup MCP tool returns a compact text form (median ~${MEASURED.mcpAnswerMedianTokens} tokens). Free: 20 lookups on a client's first UTC day, then 5 per day (hashed client IP). Then HTTP 402 with an x402 v2 challenge. ${REFERRAL_SHORT}`,
          parameters: [
            paymentHeader,
            { name: "q", in: "query", required: true, schema: { type: "string" }, example: "useState" },
            { name: "library", in: "query", required: false, schema: { type: "string", examples: ["react", "express", "zod", "stripe", "openai"] }, example: "react" },
            { name: "version", in: "query", required: false, schema: { type: "string" } },
            {
              name: "ref",
              in: "query",
              required: false,
              description: "Referrer Solana address. First touch on a new payer's first paid lookup sticks. Invalid or self-referrals are ignored.",
              schema: { type: "string" },
            },
            {
              name: "X-Llmdocs-Ref",
              in: "header",
              required: false,
              description: "Same as the ref query parameter.",
              schema: { type: "string" },
            },
          ],
          "x-payment-info": {
            protocols: cfg.assets.map((a) => ({
              name: "x402",
              version: 2,
              scheme: "exact",
              network: cfg.network,
              asset: a.mint,
              payTo: cfg.payTo,
              amount: String(Math.round(cfg.priceLookupUsd * 1_000_000)),
              currency: a.symbol,
              tokenProgram: a.tokenProgram,
              facilitator: cfg.facilitatorUrl,
            })),
            fixed: cfg.priceLookupUsd,
            currency: "USD",
            acceptedCurrencies: cfg.assets.map((a) => a.symbol),
          },
          responses: {
            "200": {
              description: "Snippets plus payout attribution. May also be a free-trial response (payment.mode=free) when the daily IP quota has not been used up.",
              content: {
                "application/json": {
                  examples: {
                    paid: {
                      summary: "Paid lookup",
                      value: {
                        results: [
                          {
                            id: "react-usestate",
                            library: "react",
                            libraryVersion: "19.0.0",
                            title: "useState declares a state variable",
                            body: "useState is a React Hook that lets you add a state variable to a component.",
                            sourceUrl: "https://react.dev/reference/react/useState",
                            license: "CC-BY-4.0",
                            houseOwned: true,
                            score: 12,
                          },
                        ],
                        payout: {
                          split: "60% contributor pool, 30% platform, 10% reserve",
                          lines: [
                            { wallet: "platform", role: "platform", amountUsd: "0.003000" },
                            { wallet: "reserve", role: "reserve", amountUsd: "0.001000" },
                            { wallet: "treasury", role: "house", amountUsd: "0.006000", houseOwned: true },
                          ],
                        },
                        payment: { mode: "x402", feeUsd: 0.01, payerWallet: "7vUCMQL5U5RtyLskFrrW7L5i7YV4pTtqg72qG87BoxSB" },
                      },
                    },
                  },
                },
              },
            },
            "402": {
              description: "Payment required (x402 challenge with PAYMENT-REQUIRED header). Also returned by HEAD and by GET without q, and by GET with q after the free trial is used up.",
              content: {
                "application/json": {
                  examples: {
                    unpaid: {
                      summary: "Unpaid 402 challenge",
                      value: {
                        x402Version: 2,
                        error: "PAYMENT-SIGNATURE header is required",
                        resource: {
                          url: `${cfg.publicBaseUrl}/v1/docs/lookup`,
                          description: "Documentation lookup",
                          mimeType: "application/json",
                        },
                        accepts: cfg.assets.map((a) => ({
                          scheme: "exact",
                          network: cfg.network,
                          amount: "10000",
                          asset: a.mint,
                          payTo: cfg.payTo,
                          extra: { name: a.symbol, decimals: a.decimals },
                        })),
                        facilitator: { url: cfg.facilitatorUrl },
                      },
                    },
                  },
                },
              },
            },
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
      "/v1/referrals/claim": {
        post: {
          summary: "Bind a first-touch referrer (10% of the payer's spend for 180 days, up to $10) before any paid lookup",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["payerWallet", "referrerWallet"],
                  properties: {
                    payerWallet: { type: "string" },
                    referrerWallet: { type: "string" },
                  },
                },
                examples: {
                  claim: {
                    value: {
                      payerWallet: "3fNDHnonA7xWsvLFkMoBmvSMCwcfvgjvT9PNdP6hLtGr",
                      referrerWallet: "BDkdaa5aHZZooaG2dRRMzBNe33PzTqZoZyQaBxVrdzi7",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Already claimed this pair" },
            "201": { description: "Attribution created" },
            "400": { description: "Invalid wallet or self-referral" },
            "409": { description: "Already attributed or payer already paid" },
          },
        },
      },
      "/v1/referrals": {
        get: {
          summary: "Referral balances and attributed agents for a wallet",
          parameters: [{ name: "wallet", in: "query", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Balances and attributions" }, "400": { description: "wallet required" } },
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
