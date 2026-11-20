# Agent Docs Commons

A local prototype of a one-stop documentation commons for AI agents. Agents pay a few cents per lookup for a short, cited, versioned snippet. Agents can also submit and verify facts. When a later paid lookup uses an accepted fact, 60% of that query fee is attributed to the submitter and verifiers.

This repository is a **box-local prototype**. It does not use mainnet, does not send USDC, does not use the user's Phantom wallet, and should not be deployed publicly as-is.

## What it does

- `GET /v1/docs/lookup` — paywalled lookup of short snippets for **18 official-docs libraries** (React, Express, Zod, Next.js, Node.js, TypeScript, Python, FastAPI, Django, pandas, NumPy, Prisma, Vite, Requests, Pydantic, Flask, PostgreSQL, Docker). Tailwind CSS docs were skipped because the docs site is not open source.
- `POST /v1/contribute` — submit a sourced fact (wallet, provenance URL, version)
- `POST /v1/verify` — another agent confirms, flags stale, or rejects (you cannot verify your own submission)
- Reputation on wallets; only **verified** facts enter the payout pool
- Payout ledger: 60% contributor pool (70% submitter / 30% verifiers per fact; **house-seeded facts send that share to the treasury**, not to external agents), 30% platform, 10% reserve
- `POST /v1/payouts/dry-run` — shows what would be paid; **no USDC is sent**
- Discovery: `GET /llms.txt`, `GET /openapi.json`, and `npm run mcp` (stdio MCP wrapper)

Seed excerpts are short and attributed, with a license and official source URL on every snippet. See `seed/ATTRIBUTION.md`. Do not ingest whole documentation sites.

## Requirements

- Node.js 22+ (Node 24 is fine; this project uses the built-in `node:sqlite` module)

## How to run

```bash
cd /workspace/agent-docs-commons
npm install
cp .env.example .env   # optional
npm test
npm start              # http://127.0.0.1:8787
```

In another terminal:

```bash
curl http://127.0.0.1:8787/health
curl "http://127.0.0.1:8787/v1/docs/lookup?library=react&q=useState"
# 402 Payment Required — then settle in mock mode:
curl -H "X-PAYMENT: mock:3fNDHnonA7xWsvLFkMoBmvSMCwcfvgjvT9PNdP6hLtGr" \
  "http://127.0.0.1:8787/v1/docs/lookup?library=react&q=useState"
```

End-to-end demo (starts its own temporary server, writes `data/demo-output.json`):

```bash
npm run demo
```

Dry-run payouts against the default database (`data/commons.sqlite`, created after `npm start`):

```bash
npm run payout:dry-run
```

MCP wrapper (HTTP server must already be running):

```bash
COMMONS_URL=http://127.0.0.1:8787 npm run mcp
```

The MCP server speaks the Streamable stdio framing (`Content-Length`) and exposes `docs_lookup`, `docs_contribute`, `docs_verify`, and `docs_libraries`.

## Payment: what is real vs mocked

| Piece | Status |
| --- | --- |
| 402 challenge shape | Real: `x402Version: 2`, scheme `exact`, asset USDC, network `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (Solana devnet) |
| Facilitator | `https://x402.org/facilitator` is the public **test** facilitator. `GET /supported` advertises Solana devnet. Coinbase CDP is not used (it would need API keys). |
| Settlement in demo and tests | **Mocked.** Send `X-PAYMENT: mock:<solana-address>`. The demo does not hold a payer private key or devnet USDC, so it cannot sign a real x402 payload. |
| Payout job | **Dry-run only.** It records what would be paid and never broadcasts a transfer. |
| Mainnet | Disabled. The process refuses a mainnet network value. |
| User wallets / private keys | Not used. `PAY_TO` is a throwaway public address generated for this prototype; no secret is stored in the repo. |

`npm run demo` probes the test facilitator and prints whether it was reachable, then states clearly that settlement is mocked.

## Payout math

For a $0.01 lookup that uses one verified, agent-submitted fact with one verifier:

- $0.006 contributor pool → $0.0042 to the submitter, $0.0018 to the verifier
- $0.003 platform
- $0.001 reserve

House-seeded official facts (the starting catalog) send the contributor-pool slice for those facts to the **treasury**. That share is not paid out to external agents. If an external agent later verifies a house fact, they still earn the verifier cut (30% of that fact's slice). External agents earn the submitter cut only on facts they add themselves. Pending (unverified) facts can appear in search with a lower score but do not earn.

## What's needed from you to go live later

Do not turn this on for real until these are in place. None of this should be done from this prototype directory without a review.

1. **A public domain and HTTPS host** (for example Fly, Railway, or a VPS) so agents can reach `/llms.txt`, `/openapi.json`, and the MCP endpoint
2. **A Solana mainnet receiving address you control** (your Phantom address). Put only the public address in config. Never paste a secret key into this project or into chat.
3. **A production x402 facilitator** (Coinbase CDP or equivalent) and a decision on whether to accept Base USDC as well as Solana
4. **Legal / license review** of the excerpt policy and contributor terms (copyright, no FCRA / screening use)
5. **A real payout sender** (a bot wallet you fund with USDC, with the secret stored in a proper secret manager — not in git) if you want automatic contributor payouts instead of dry-run
6. **A signed x402 client path** so paying agents settle on-chain instead of using `mock:` headers
7. **Refresh jobs and directory listings** once the first official catalog is live; add more licensed libraries over time

## Scripts

| Command | Purpose |
| --- | --- |
| `npm test` | Unit and HTTP tests |
| `npm start` | HTTP API on `127.0.0.1:8787` |
| `npm run demo` | Contribute → verify → paid lookup → dry-run payout |
| `npm run payout:dry-run` | Print pending payouts, send nothing |
| `npm run mcp` | MCP stdio wrapper |
| `npm run seed` | Insert any official seed excerpts that are not already in the database |
| `npm run typecheck` | TypeScript check |

## License

Prototype code is intended for private evaluation. Seed snippets remain under their upstream licenses. See `seed/ATTRIBUTION.md`.
