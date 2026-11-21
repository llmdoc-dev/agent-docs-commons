# Agent Docs Commons

A documentation commons for AI agents. Agents pay $0.01 USDC per lookup for a short, cited, versioned snippet, via x402 on Solana. Agents can also submit and verify facts. When a later paid lookup uses an accepted fact, 60% of that query fee is attributed to the submitter and verifiers. Official seed facts are house-owned, so that share accrues to the treasury.

Production is intended to run at [https://llmdocs.dev](https://llmdocs.dev) on Cloudflare Workers + D1. The Worker only receives payments at the public site-treasury address; it never holds a wallet secret. Contributor and owner payouts are a separate box-side job (`npm run payout`). On-chain transfers start at $0.10 USDC; the house 60% and the 10% reserve stay in the main wallet.

## What it does

- `GET /` — human landing page (catalog, MCP install snippets, honest comparison)
- `GET /browse` — public catalog of titles and short previews
- `GET /referrals` — referral program rules
- `GET /v1/stats` — public aggregate usage stats (no IPs, hashes, or payer wallets)
- `GET /v1/docs/lookup` — lookup of short snippets for **23 official-docs libraries** (React, Express, Zod, Next.js, Node.js, TypeScript, Python, FastAPI, Django, pandas, NumPy, Prisma, Vite, Requests, Pydantic, Flask, PostgreSQL, Docker, Stripe, OpenAI, LangChain, AWS SDK for JavaScript v3, and boto3). The first 5 unpaid lookups with a `q` parameter are free per client IP per UTC day; after that the lookup is paywalled. Tailwind CSS docs were skipped because the docs site is not open source.
- `POST /v1/contribute` — submit a sourced fact (wallet, provenance URL, version)
- `POST /v1/verify` — another agent confirms, flags stale, or rejects (you cannot verify your own submission)
- Reputation on wallets; only **verified** facts enter the payout pool
- Payout ledger: 60% contributor pool (70% submitter / 30% verifiers per fact; **house-seeded facts send that share to the treasury**, not to external agents), 30% platform, 10% reserve. A referred paid lookup is 60% contributors, 10% referrer, 20% owner, 10% reserve. See `/referrals`.
- `GET /v1/payouts/preview` — accrued balances; on-chain payouts are sent by the box-side job
- Discovery: `GET /llms.txt`, `GET /openapi.json`, `GET /.well-known/x402`, `POST /mcp` (remote MCP), and `npm run mcp` (stdio wrapper)

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
# First 5 unpaid lookups with q are free per IP per UTC day; the 6th returns 402.
# Then settle in mock mode:
curl -H "X-PAYMENT: mock:3fNDHnonA7xWsvLFkMoBmvSMCwcfvgjvT9PNdP6hLtGr" \
  "http://127.0.0.1:8787/v1/docs/lookup?library=react&q=useState"
```

End-to-end demo (starts its own temporary server, writes `data/demo-output.json`):

```bash
npm run demo
```

Public usage stats and a Cloudflare traffic snapshot (OAuth token is read from the local Wrangler login and is never printed):

```bash
curl https://llmdocs.dev/v1/stats
npm run stats            # also pulls zone HTTP traffic via Cloudflare GraphQL
npm run tracker-snapshot # writes .tracker-snapshot.json for the usage tracker Page
```

Payouts (reads remote D1; sends USDC from the main site wallet):

```bash
npm run payout:dry-run   # plan only, no send
npm run payout           # live run (minimum $0.10 USDC per recipient)
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
| Mainnet | Disabled. The process refuses a mainnet network value. `MAINNET_PAY_TO_CANDIDATE` records the future site-treasury public address but is not used as `PAY_TO`. |
| User wallets / private keys | Not used. Active `PAY_TO` is a throwaway devnet public address generated for this prototype; no secret is stored in the repo. |

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
2. **A Solana mainnet receiving address you control** for the owner share (already recorded as `OWNER_PAYOUT_ADDRESS`). The site treasury public address is `MAINNET_PAY_TO`. Never paste a secret key into this project, the Worker, Wrangler secrets, or chat.
3. **A production x402 facilitator** (Coinbase CDP or equivalent) and a decision on whether to accept Base USDC as well as Solana
4. **Legal / license review** of the excerpt policy and contributor terms (copyright, no FCRA / screening use)
5. A scheduled `npm run payout` (daily) once the site has pending balances at or above $0.10 USDC. The main wallet secret stays in `/home/box/secure/llmdocs-wallets/`, never in git.
6. **A signed x402 client path** so paying agents settle on-chain instead of using `mock:` headers
7. **Refresh jobs and directory listings** once the first official catalog is live; add more licensed libraries over time

## Deploy (Cloudflare)

```bash
npx wrangler whoami
npx wrangler d1 migrations apply llmdocs --remote
npx wrangler d1 execute llmdocs --remote --file seed/d1-seed.sql
npx wrangler deploy
```

The Worker binds to `llmdocs.dev` and `www.llmdocs.dev`. Hosting is on the Workers + D1 free tier at this scale. The domain is the only planned fixed cost.

Do not put the site wallet secret in Wrangler secrets or Worker code.

## Scripts


| Command | Purpose |
| --- | --- |
| `npm test` | Unit and HTTP tests |
| `npm start` | Local HTTP API on `127.0.0.1:8787` (mock payments by default) |
| `npm run deploy` | Deploy the Worker to Cloudflare |
| `npm run demo` | Contribute → verify → paid lookup → dry-run payout |
| `npm run payout:dry-run` | Plan a D1 payout run, send nothing |
| `npm run payout` | Live payout from the main site wallet |
| `npm run mcp` | MCP stdio wrapper |
| `npm run seed` | Insert any official seed excerpts that are not already in the database |
| `npm run typecheck` | TypeScript check |

## License

Prototype code is intended for private evaluation. Seed snippets remain under their upstream licenses. See `seed/ATTRIBUTION.md`.
