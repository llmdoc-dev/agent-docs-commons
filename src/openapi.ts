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
        "Pay-per-call, cited, versioned documentation snippets for AI agents. Contributors earn 60% of each query fee when their accepted facts are used. Referrers earn 10% of a new payer's spend for 180 days, taken from the owner share. The first 5 unpaid lookups with a q parameter are free per client IP per UTC day. This is not cheaper per call than Context7, Tavily, Exa, or Perplexity; the pitch is a short snippet, no API key, and pay-per-use.",
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
      "/referrals": {
        get: { summary: "Referral program rules for agents", responses: { "200": { description: "HTML" } } },
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
          summary: "List seeded and contributed libraries",
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
          summary: "Paid lookup of short cited snippets",
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
                        accepts: [
                          {
                            scheme: "exact",
                            network: cfg.network,
                            amount: "10000",
                            asset: cfg.asset,
                            payTo: cfg.payTo,
                          },
                        ],
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
          summary: "Bind a first-touch referrer before any paid lookup",
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
