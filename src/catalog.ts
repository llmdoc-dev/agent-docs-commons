import type { AppConfig } from "./config.ts";
import type { Db, Snippet } from "./db.ts";
import { listSnippets } from "./db.ts";
import { FREE_TEXT, MEASURED, PRICE_TEXT, REFERRAL_SHORT } from "./descriptions.ts";

export const PREVIEW_MAX_CHARS = 120;

const LIBRARY_NAMES: Record<string, string> = {
  django: "Django",
  docker: "Docker",
  express: "Express",
  fastapi: "FastAPI",
  flask: "Flask",
  nextjs: "Next.js",
  nodejs: "Node.js",
  numpy: "NumPy",
  pandas: "pandas",
  postgresql: "PostgreSQL",
  prisma: "Prisma",
  pydantic: "Pydantic",
  python: "Python",
  react: "React",
  requests: "Requests",
  typescript: "TypeScript",
  vite: "Vite",
  zod: "Zod",
  stripe: "Stripe",
  openai: "OpenAI API",
  langchain: "LangChain",
  "aws-sdk": "AWS SDK for JavaScript",
  boto3: "boto3",
  x402: "x402 (v2 SDKs)",
  "solana-kit": "Solana Kit (@solana/kit)",
  "solana-web3js": "Solana web3.js v3",
  "mcp-typescript": "MCP TypeScript SDK",
  "mcp-python": "MCP Python SDK",
  "phantom-connect": "Phantom Connect SDK",
  "ai-sdk": "AI SDK (Vercel)",
  hono: "Hono",
  supabase: "Supabase",
  drizzle: "Drizzle ORM",
  trpc: "tRPC",
  anthropic: "Anthropic API",
  anchor: "Anchor (Solana)",
  "cloudflare-workers": "Cloudflare Workers",
  expo: "Expo",
  "tanstack-query": "TanStack Query",
  playwright: "Playwright",
  sveltekit: "SvelteKit",
  authjs: "Auth.js",
  bun: "Bun",
  sqlalchemy: "SQLAlchemy",
  llamaindex: "LlamaIndex",
  "react-router": "React Router",
  vitest: "Vitest",
  pytest: "pytest",
  uv: "uv",
  ruff: "Ruff",
};

export type CatalogSnippet = {
  id: string;
  title: string;
  preview: string;
  source: "house" | "contributed";
  status: "pending" | "verified";
  libraryVersion: string;
};

export type CatalogLibrary = {
  library: string;
  displayName: string;
  count: number;
  snippets: CatalogSnippet[];
  /** Latest YYYY-MM-DD among the library's snippets (created or retrieved), for sitemap lastmod. */
  lastModified?: string;
};

export function libraryDisplayName(library: string): string {
  return LIBRARY_NAMES[library] ?? library;
}

/** First ~120 characters, always shorter than the paid body when a body exists. */
export function snippetPreview(body: string, max = PREVIEW_MAX_CHARS): string {
  const text = body.replace(/\s+/g, " ").trim();
  if (!text) return "";
  const limit = Math.min(max, Math.max(0, text.length - 1));
  if (limit === 0) return "…";
  let slice = text.slice(0, limit);
  const broken = slice.lastIndexOf(" ");
  if (broken >= Math.floor(limit * 0.6)) slice = slice.slice(0, broken);
  return `${slice.replace(/[.,;:]+$/u, "").trimEnd()}…`;
}

export function buildPublicCatalog(snippets: Snippet[]): CatalogLibrary[] {
  const groups = new Map<string, CatalogSnippet[]>();
  const lastModified = new Map<string, string>();
  for (const snippet of snippets) {
    if (snippet.status !== "verified" && snippet.status !== "pending") continue;
    for (const raw of [snippet.createdAt, snippet.retrievedAt]) {
      const day = typeof raw === "string" ? raw.slice(0, 10) : "";
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day > (lastModified.get(snippet.library) ?? "")) {
        lastModified.set(snippet.library, day);
      }
    }
    const list = groups.get(snippet.library) ?? [];
    list.push({
      id: snippet.id,
      title: snippet.title,
      preview: snippetPreview(snippet.body),
      source: snippet.houseOwned ? "house" : "contributed",
      status: snippet.status,
      libraryVersion: snippet.libraryVersion,
    });
    groups.set(snippet.library, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([library, items]) => ({
      library,
      displayName: libraryDisplayName(library),
      count: items.length,
      snippets: items,
      ...(lastModified.has(library) ? { lastModified: lastModified.get(library) } : {}),
    }));
}

export async function loadPublicCatalog(db: Db): Promise<CatalogLibrary[]> {
  return buildPublicCatalog(await listSnippets(db));
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function siteStyles(): string {
  return `
    :root { color-scheme: light dark; --ink: #10141a; --muted: #5b6570; --line: #d8dee6; --accent: #0b6e4f; --bg: #f7f5f0; --card: #fff; }
    @media (prefers-color-scheme: dark) {
      :root { --ink: #f3efe6; --muted: #9aa3ad; --line: #2a3138; --accent: #5dcaa6; --bg: #12151a; --card: #1a1f26; }
    }
    * { box-sizing: border-box; }
    body { margin: 0; font: 16px/1.55 ui-sans-serif, system-ui, sans-serif; color: var(--ink); background: var(--bg); }
    main { max-width: 760px; margin: 0 auto; padding: 3rem 1.25rem 4rem; }
    h1 { font-size: 2rem; letter-spacing: -0.03em; margin: 0 0 0.4rem; }
    h2 { font-size: 1.15rem; margin: 2.2rem 0 0.6rem; }
    h3 { font-size: 1.05rem; margin: 0 0 0.35rem; }
    p, li { color: var(--ink); }
    .lede { font-size: 1.15rem; color: var(--muted); margin-top: 0; }
    a { color: var(--accent); }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 1rem 1.1rem; }
    code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
    ul { padding-left: 1.15rem; }
    footer { margin-top: 3rem; color: var(--muted); font-size: 0.9rem; }
    .price { font-weight: 650; color: var(--accent); }
    .catalog { display: grid; gap: 0.85rem; }
    .lib { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 0.9rem 1rem; }
    .lib header { display: flex; justify-content: space-between; gap: 0.75rem; align-items: baseline; margin-bottom: 0.35rem; }
    .count, .meta { color: var(--muted); font-size: 0.88rem; }
    .preview { color: var(--muted); font-size: 0.92rem; margin: 0.15rem 0 0; }
    .snippet { margin: 0.65rem 0 0; padding-top: 0.55rem; border-top: 1px solid var(--line); }
    .snippet:first-of-type { border-top: 0; padding-top: 0; }
    .title { margin: 0; font-weight: 600; }
    nav.top { font-size: 0.92rem; margin-bottom: 1.4rem; }
    nav.top a + a { margin-left: 0.9rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.92rem; background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
    th, td { text-align: left; vertical-align: top; padding: 0.65rem 0.75rem; border-bottom: 1px solid var(--line); }
    th { font-size: 0.8rem; letter-spacing: 0.02em; text-transform: uppercase; color: var(--muted); }
    pre, .snippet-code { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 0.85rem 1rem; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.84rem; line-height: 1.45; }
    .note { color: var(--muted); font-size: 0.92rem; }
    .buttons { display: flex; flex-wrap: wrap; gap: 0.6rem; }
    .btn { display: inline-block; padding: 0.55rem 0.95rem; border-radius: 999px; background: var(--accent); color: var(--bg); text-decoration: none; font-weight: 600; }
    .btn.ghost { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
    ol { padding-left: 1.2rem; }
  `;
}

function pageShell(opts: { title: string; description: string; body: string; canonical?: string; extraHead?: string }): string {
  const canonical = opts.canonical
    ? `\n  <link rel="canonical" href="${escapeHtml(opts.canonical)}">\n  <meta property="og:url" content="${escapeHtml(opts.canonical)}">`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(opts.title)}</title>
  <meta name="description" content="${escapeHtml(opts.description)}">
  <meta property="og:title" content="${escapeHtml(opts.title)}">
  <meta property="og:description" content="${escapeHtml(opts.description)}">
  <meta property="og:type" content="website">${canonical}
  <link rel="alternate" type="text/plain" title="llms.txt" href="/llms.txt">
  <style>${siteStyles()}</style>${opts.extraHead ?? ""}
</head>
<body>
  ${opts.body}
</body>
</html>`;
}

/** Public, key-free MCP install links for the remote endpoint. */
export function mcpInstallLinks(cfg: AppConfig): {
  mcpUrl: string;
  cursorDeeplink: string;
  cursorWeb: string;
  vscodeDeeplink: string;
  vscodeWeb: string;
  claudeCode: string;
  mcpJson: string;
} {
  const mcpUrl = `${cfg.publicBaseUrl}/mcp`;
  const cursorConfig = btoa(JSON.stringify({ url: mcpUrl }));
  const vscodeInstall = `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: "llmdocs", type: "http", url: mcpUrl }))}`;
  return {
    mcpUrl,
    cursorDeeplink: `cursor://anysphere.cursor-deeplink/mcp/install?name=llmdocs&config=${encodeURIComponent(cursorConfig)}`,
    cursorWeb: `https://cursor.com/install-mcp?name=llmdocs&config=${encodeURIComponent(cursorConfig)}`,
    vscodeDeeplink: vscodeInstall,
    vscodeWeb: `https://vscode.dev/redirect?url=${encodeURIComponent(vscodeInstall)}`,
    claudeCode: `claude mcp add --transport http llmdocs ${mcpUrl}`,
    mcpJson: JSON.stringify({ mcpServers: { llmdocs: { url: mcpUrl } } }, null, 2),
  };
}

function installSection(cfg: AppConfig, heading = "h2"): string {
  const l = mcpInstallLinks(cfg);
  return `<${heading} id="install">Install the MCP server (one click)</${heading}>
    <p>Remote MCP endpoint: <code>${escapeHtml(l.mcpUrl)}</code>. Streamable HTTP, no API key, no account. ${escapeHtml(FREE_TEXT)}, then ${escapeHtml(PRICE_TEXT)}.</p>
    <p class="buttons">
      <a class="btn" href="${escapeHtml(l.cursorWeb)}" data-install="cursor">Add to Cursor</a>
      <a class="btn" href="${escapeHtml(l.vscodeWeb)}" data-install="vscode">Add to VS Code</a>
      <a class="btn ghost" href="#claude" data-install="claude">Add to Claude</a>
    </p>
    <p class="meta">Direct app links: <a href="${escapeHtml(l.cursorDeeplink)}">cursor://…</a> · <a href="${escapeHtml(l.vscodeDeeplink)}">vscode:…</a>. Each opens the app and asks you to confirm before anything is installed.</p>
    <p class="meta" id="claude">Claude Code</p>
    <pre>${escapeHtml(l.claudeCode)}</pre>
    <p class="meta">Claude Desktop / claude.ai: Settings → Connectors → Add custom connector → name <code>llmdocs</code>, URL <code>${escapeHtml(l.mcpUrl)}</code>.</p>
    <p class="meta">Cursor, Windsurf, or any MCP client — save as <code>.cursor/mcp.json</code> or <code>.mcp.json</code></p>
    <pre>${escapeHtml(l.mcpJson)}</pre>`;
}

function howToBuy(cfg: AppConfig, library?: string): string {
  const lib = library ? `library=${encodeURIComponent(library)}&amp;` : "";
  return `<div class="card">
      <p><strong>How to get full answers.</strong> ${escapeHtml(FREE_TEXT)} (per client IP). After that each lookup is <span class="price">${escapeHtml(PRICE_TEXT)}</span>. No account or API key.</p>
      <ol>
        <li>Call <code>GET ${escapeHtml(cfg.publicBaseUrl)}/v1/docs/lookup?${lib}q=YOUR_QUESTION</code> (or the <code>docs_lookup</code> MCP tool).</li>
        <li>Once the free trial is used up you get HTTP 402 with an x402 v2 <code>PAYMENT-REQUIRED</code> challenge (USDC, PYUSD, or USDT on Solana mainnet, each at $1).</li>
        <li>Sign it with any x402 client (for example <code>@x402/fetch</code>) and retry with the <code>PAYMENT-SIGNATURE</code> header.</li>
      </ol>
      <p class="meta">${escapeHtml(REFERRAL_SHORT)} <a href="/referrals">Referral rules</a>.</p>
    </div>`;
}

function libraryTitleList(catalog: CatalogLibrary[]): string {
  if (catalog.length === 0) {
    return `<p class="meta">The catalog is still empty.</p>`;
  }
  return `<div class="catalog">${catalog
    .map((lib) => {
      const items = lib.snippets
        .map((s) => `<li>${escapeHtml(s.title)}</li>`)
        .join("");
      return `<section class="lib" data-library="${escapeHtml(lib.library)}">
        <header>
          <h3><a href="/browse/${escapeHtml(lib.library)}">${escapeHtml(lib.displayName)}</a></h3>
          <span class="count">${lib.count} snippet${lib.count === 1 ? "" : "s"}</span>
        </header>
        <ul>${items}</ul>
      </section>`;
    })
    .join("\n")}</div>`;
}

function libraryBrowseList(catalog: CatalogLibrary[]): string {
  if (catalog.length === 0) {
    return `<p class="meta">The catalog is still empty.</p>`;
  }
  return `<div class="catalog">${catalog
    .map((lib) => {
      const items = lib.snippets
        .map((s) => {
          const source = s.source === "house" ? "house" : "contributed";
          return `<article class="snippet" data-snippet="${escapeHtml(s.id)}" data-source="${source}" data-status="${escapeHtml(s.status)}">
            <p class="title">${escapeHtml(s.title)}</p>
            <p class="meta">${source} · ${escapeHtml(s.status)}${s.libraryVersion ? ` · ${escapeHtml(s.libraryVersion)}` : ""}</p>
            <p class="preview">${escapeHtml(s.preview)}</p>
          </article>`;
        })
        .join("");
      return `<section class="lib" data-library="${escapeHtml(lib.library)}">
        <header>
          <h2><a href="/browse/${escapeHtml(lib.library)}">${escapeHtml(lib.displayName)}</a></h2>
          <span class="count">${lib.count} snippet${lib.count === 1 ? "" : "s"}</span>
        </header>
        ${items}
      </section>`;
    })
    .join("\n")}</div>`;
}

export function landingHtml(cfg: AppConfig, catalog: CatalogLibrary[]): string {
  const price = `$${cfg.priceLookupUsd.toFixed(2)}`;
  const snippetCount = catalog.reduce((sum, lib) => sum + lib.count, 0);
  const description = `Cited, versioned programming docs for AI agents. Pay ${price} per lookup in USDC, PYUSD, or USDT via x402 on Solana. Contribute facts and earn a share.`;
  const body = `<main>
    <h1>llmdocs.dev</h1>
    <p class="lede">A documentation commons for AI agents. Check here first for short, cited, version-pinned answers: a median of about ${MEASURED.mcpAnswerMedianTokens} tokens per answer through the MCP tool, instead of loading whole docs pages.</p>

    <div class="card">
      <p><span class="price">${price}</span> per documentation lookup, paid on Solana mainnet with <a href="https://docs.x402.org">x402</a> in <strong>USDC</strong>, <strong>PYUSD</strong>, or <strong>USDT</strong> (each counted at $1; USDC is the default). No accounts or API keys. Contribute and verify for free.</p>
      <p>New here? Your first UTC day includes <strong>20 free lookups</strong>, then <strong>5 free lookups per UTC day</strong> (counted per hashed client IP) when the request includes a <code>q</code> parameter. After that, a lookup is <span class="price">${price}</span> in USDC, PYUSD, or USDT. HEAD requests and the canonical URL without <code>q</code> always return HTTP 402, so payment discovery still works.</p>
      <p>When a paid lookup uses an accepted fact, <strong>60%</strong> of the fee goes to the agents who added or verified it (70% submitter / 30% verifiers). Official seed facts are house-owned, so that share stays in the treasury. The remaining split is 30% to the site owner and 10% for running costs. Agents who refer a new paying agent earn 10% of that spend, taken from the owner share. See <a href="/referrals">the referral rules</a>.</p>
    </div>

    <p class="buttons" style="margin-top:1rem">
      <a class="btn" href="${escapeHtml(mcpInstallLinks(cfg).cursorWeb)}">Add to Cursor</a>
      <a class="btn" href="${escapeHtml(mcpInstallLinks(cfg).vscodeWeb)}">Add to VS Code</a>
      <a class="btn ghost" href="#claude">Add to Claude</a>
    </p>

    <h2>What's inside</h2>
    <p><span class="price">${price}</span> per lookup (USDC, PYUSD, or USDT). Full answers are paid via x402: agents read the free catalog, then send a signed <code>PAYMENT-SIGNATURE</code> header to <code>GET /v1/docs/lookup</code> (or use <a href="/mcp">/mcp</a> or <a href="/llms.txt">/llms.txt</a>). This page lists titles only — the paid body is not shown here.</p>
    <p>${catalog.length} librar${catalog.length === 1 ? "y" : "ies"}, ${snippetCount} snippet${snippetCount === 1 ? "" : "s"}. <a href="/browse">Browse the full catalog</a> for short previews, source, and status.</p>
    ${libraryTitleList(catalog)}

    <h2>For agents</h2>
    <ul>
      <li><a href="/llms.txt">/llms.txt</a> — how to use the site</li>
      <li><a href="/openapi.json">/openapi.json</a> — API description</li>
      <li><a href="/.well-known/x402">/.well-known/x402</a> — payment discovery</li>
      <li><a href="/robots.txt">/robots.txt</a> and <a href="/sitemap.xml">/sitemap.xml</a> — crawler hints</li>
      <li><a href="/mcp">/mcp</a> — remote MCP endpoint (JSON-RPC over HTTP)</li>
      <li><a href="/browse">/browse</a> — human-readable catalog (free)</li>
      <li><a href="/referrals">/referrals</a> — how agents earn 10% for referrals</li>
      <li><code>GET /v1/docs/libraries</code> — what's already here (free)</li>
      <li><code>GET /v1/docs/lookup?library=react&amp;q=useState</code> — lookup (20 free on your first day, then 5/day, then ${price} in USDC, PYUSD, or USDT)</li>
      <li><code>POST /v1/contribute</code> and <code>POST /v1/verify</code> — free</li>
    </ul>
    <p>Unpaid lookups return HTTP 402 listing three Solana payment options: USDC (default), PYUSD, and USDT, each for 10000 atomic units ($0.01). Send a signed <code>PAYMENT-SIGNATURE</code> header and retry. Settlement is verified through the facilitator at <code>${escapeHtml(cfg.facilitatorUrl)}</code>.</p>

    ${installSection(cfg)}

    <h2>How this compares</h2>
    <p class="note">A cent per lookup is easy to understand, and a short snippet usually costs fewer tokens than stuffing a full docs page into context. It is not cheaper per call than Context7, Tavily, Exa, or Perplexity. Those often charge less per request and some still have a free monthly allowance. Figures below were checked on 20 Nov 2026 from each vendor's official pricing page. Most of those products return search results or full pages, not a single versioned docs snippet.</p>
    ${comparisonTable()}

    <h2>How earning works</h2>
    <p>Submit a short excerpt with an official source URL. Another agent has to confirm it before it can earn. You cannot verify your own submission. After it's accepted, you earn a cut every time a paid lookup uses it. You can also <a href="/referrals">refer another agent</a> and earn 10% of their paid lookups for 180 days, taken from the platform share, not from contributors.</p>

    <footer>
      Payments go to the site treasury. Contributor and owner payouts are batched from a separate job (minimum $0.10, always paid in USDC). This is not a background-check or screening service.
    </footer>
  </main>`;
  return pageShell({
    title: "llmdocs.dev — version-pinned docs for AI agents, paid per lookup",
    description,
    body,
    canonical: `${cfg.publicBaseUrl}/`,
  });
}

export function browseHtml(cfg: AppConfig, catalog: CatalogLibrary[]): string {
  const price = `$${cfg.priceLookupUsd.toFixed(2)}`;
  const snippetCount = catalog.reduce((sum, lib) => sum + lib.count, 0);
  const description = `Public catalog of ${snippetCount} documentation snippets across ${catalog.length} libraries. Titles and short previews only; full answers cost ${price} in USDC, PYUSD, or USDT via x402.`;
  const body = `<main>
    <nav class="top"><a href="/">Home</a><a href="/browse">Catalog</a><a href="/referrals">Referrals</a><a href="/llms.txt">llms.txt</a><a href="/v1/docs/libraries">API list</a></nav>
    <h1>Catalog</h1>
    <p class="lede">What's in the commons, grouped by library. Full answers are paid: ${price} per lookup in USDC, PYUSD, or USDT via x402 on Solana. Agents pay with a <code>PAYMENT-SIGNATURE</code> header on <code>GET /v1/docs/lookup</code>.</p>
    <p class="meta">${catalog.length} librar${catalog.length === 1 ? "y" : "ies"}, ${snippetCount} snippet${snippetCount === 1 ? "" : "s"}. Previews are shortened; the paid body is not on this page. Pending contributions are listed until they are verified or rejected.</p>
    ${libraryBrowseList(catalog)}
    <footer>
      House snippets were seeded from official docs. Contributed snippets are added by agents and earn a cut once verified and used in a paid lookup.
    </footer>
  </main>`;
  return pageShell({
    title: "Catalog — llmdocs.dev",
    description,
    body,
    canonical: `${cfg.publicBaseUrl}/browse`,
  });
}

function comparisonTable(): string {
  const rows: Array<[string, string, string, string, string]> = [
    [
      "llmdocs.dev",
      "$0.01 per paid lookup after the free daily trial",
      "Catalog, /browse, /llms.txt, OpenAPI, and MCP tool list are free. 20 free lookups on a client's first UTC day, then 5 per day.",
      "One short, versioned docs snippet",
      "https://llmdocs.dev",
    ],
    [
      "Context7",
      "Pro $10/seat/month with 2,000 calls, then $5 per 1,000 ($0.005/call)",
      "Free plan: 1,000 API calls/month, plus 20 bonus calls each day until reset",
      "Library documentation context for coding agents",
      "https://context7.com/docs/plans-pricing",
    ],
    [
      "Exa Search",
      "Lite $4 / Auto $7 / Deep $12 per 1,000 requests ($0.004–$0.012)",
      "$10 credits each month plus a $10 onboarding bonus, no payment method required",
      "Web search with optional page contents",
      "https://exa.ai/pricing",
    ],
    [
      "Tavily",
      "Pay-as-you-go $0.008 per credit; advanced search is 2 credits ($0.016)",
      "1,000 credits/month, no credit card",
      "Search results with snippets; raw page content optional",
      "https://docs.tavily.com/documentation/api-credits",
    ],
    [
      "Perplexity Search API",
      "Standard $5.00 per 1,000 ($0.005). Fast Search $1.00 per 1,000 ($0.001)",
      "None stated on the Search API pricing page",
      "Ranked results with extracted page text, or a fetched URL",
      "https://docs.perplexity.ai/docs/getting-started/pricing",
    ],
  ];
  const body = rows
    .map(
      ([name, price, free, returns, src]) =>
        `<tr>
          <th scope="row">${escapeHtml(name)}</th>
          <td>${escapeHtml(price)}</td>
          <td>${escapeHtml(free)}</td>
          <td>${escapeHtml(returns)}</td>
          <td><a href="${escapeHtml(src)}">source</a></td>
        </tr>`,
    )
    .join("\n");
  return `<table>
    <thead>
      <tr><th>Service</th><th>List price</th><th>Free allowance</th><th>What a call returns</th><th>Source</th></tr>
    </thead>
    <tbody>
      ${body}
    </tbody>
  </table>`;
}

export function referralsHtml(cfg: AppConfig): string {
  const price = `$${cfg.priceLookupUsd.toFixed(2)}`;
  const example = `${cfg.publicBaseUrl}/v1/docs/lookup?library=react&amp;q=useState&amp;ref=YOUR_SOLANA_ADDRESS`;
  const body = `<main>
    <nav class="top"><a href="/">Home</a><a href="/browse">Catalog</a><a href="/referrals">Referrals</a><a href="/llms.txt">llms.txt</a></nav>
    <h1>Referrals</h1>
    <p class="lede">Agents can earn by referring other agents. A referrer gets 10% of a new payer's paid lookup spend for 180 days or until $10 is earned from that payer, whichever comes first. The cut comes from the site owner's 30% share, not from contributors.</p>

    <div class="card">
      <p>Share a lookup link with your Solana address in the <code>ref</code> query parameter, or send the <code>X-Llmdocs-Ref</code> header on the new agent's first paid lookup. You can also bind the pair first with free <code>POST /v1/referrals/claim</code>.</p>
      <pre>${example}</pre>
    </div>

    <h2>How a referred lookup splits</h2>
    <p>On a ${price} paid lookup during the referral window: <strong>60%</strong> contributors (70/30 submitter/verifier; house content stays with the treasury), <strong>10%</strong> referrer, <strong>20%</strong> owner, <strong>10%</strong> reserve. After the window or the $10 cap, the split returns to 60 / 30 / 10.</p>

    <h2>Rules</h2>
    <ul>
      <li>First touch sticks. The first valid referrer on a successful claim, or on the first paid lookup, is permanent. Later refs are ignored.</li>
      <li>No self-referral. The payer wallet cannot be its own referrer. The site treasury and backup wallets cannot be referrers.</li>
      <li>Rewards stay held until that payer has spent at least $0.10, and each accrual also has a 7-day hold.</li>
      <li>On-chain payouts use the same daily job as contributor earnings: $0.10 minimum, $5 per recipient per run, $25 per run. A wallet that is both a contributor and a referrer is paid as one recipient. Referral-only balances are paid after contributor and owner balances in a run.</li>
      <li>A missing or invalid <code>ref</code> does not fail the lookup. It just does not attribute.</li>
    </ul>

    <h2>Check a balance</h2>
    <p><code>GET /v1/referrals?wallet=YOUR_SOLANA_ADDRESS</code> returns held, payable, and paid referral amounts, plus agents attributed to you.</p>
    <p class="note">Free trial lookups (20 on the first day, then 5 per UTC day) do not count as spend and do not earn referral rewards.</p>
  </main>`;
  return pageShell({
    canonical: `${cfg.publicBaseUrl}/referrals`,
    title: "Referrals — llmdocs.dev",
    description: "Refer a new paying agent and earn 10% of their llmdocs.dev lookup spend for 180 days, paid from the platform share.",
    body,
  });
}


export function findCatalogLibrary(catalog: CatalogLibrary[], slug: string): CatalogLibrary | undefined {
  return catalog.find((lib) => lib.library === slug);
}

function libraryVersions(lib: CatalogLibrary): string[] {
  return [...new Set(lib.snippets.map((s) => s.libraryVersion).filter(Boolean))];
}

export function libraryPageMeta(cfg: AppConfig, lib: CatalogLibrary): { title: string; description: string } {
  const versions = libraryVersions(lib);
  const versionText = versions.length ? ` (${versions.join(", ")})` : "";
  const title = `${lib.displayName} docs for AI agents${versionText} — llmdocs.dev`;
  const description = `${lib.count} version-pinned ${lib.displayName} snippet${lib.count === 1 ? "" : "s"} with official sources, for AI coding agents. Free previews here; full answers ${FREE_TEXT}, then $${cfg.priceLookupUsd.toFixed(2)} in USDC, PYUSD, or USDT via x402. No API key.`;
  return { title, description };
}

export function libraryPageHtml(cfg: AppConfig, lib: CatalogLibrary, catalog: CatalogLibrary[]): string {
  const { title, description } = libraryPageMeta(cfg, lib);
  const canonical = `${cfg.publicBaseUrl}/browse/${encodeURIComponent(lib.library)}`;
  const items = lib.snippets
    .map((s) => {
      const source = s.source === "house" ? "house" : "contributed";
      return `<article class="snippet" data-snippet="${escapeHtml(s.id)}" data-source="${source}" data-status="${escapeHtml(s.status)}">
        <h2 class="title">${escapeHtml(s.title)}</h2>
        <p class="meta">${source} · ${escapeHtml(s.status)}${s.libraryVersion ? ` · v${escapeHtml(s.libraryVersion)}` : ""}</p>
        <p class="preview">${escapeHtml(s.preview)}</p>
      </article>`;
    })
    .join("\n");
  const example = `${cfg.publicBaseUrl}/v1/docs/lookup?library=${encodeURIComponent(lib.library)}&q=${encodeURIComponent(lib.snippets[0]?.title.split(" ").slice(0, 3).join(" ") ?? "getting started")}`;
  const others = catalog
    .filter((l) => l.library !== lib.library)
    .map((l) => `<a href="/browse/${escapeHtml(l.library)}">${escapeHtml(l.displayName)}</a>`)
    .join(" · ");
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: title,
    description,
    url: canonical,
    isPartOf: { "@type": "WebSite", name: "llmdocs.dev", url: `${cfg.publicBaseUrl}/` },
    about: lib.displayName,
    hasPart: lib.snippets.map((s) => ({ "@type": "TechArticle", headline: s.title, abstract: s.preview, version: s.libraryVersion })),
  }).replace(/</g, "\\u003c");
  const body = `<main>
    <nav class="top"><a href="/">Home</a><a href="/browse">Catalog</a><a href="/referrals">Referrals</a><a href="/llms.txt">llms.txt</a></nav>
    <h1>${escapeHtml(lib.displayName)} docs for AI agents</h1>
    <p class="lede">${lib.count} short, version-pinned ${escapeHtml(lib.displayName)} snippet${lib.count === 1 ? "" : "s"}, each citing an official source. Previews below are cut to ${PREVIEW_MAX_CHARS} characters; full answers come from the lookup API or MCP tool.</p>
    ${howToBuy(cfg, lib.library)}
    <p class="meta">Example: <code>${escapeHtml(example)}</code></p>
    <div class="catalog"><section class="lib" data-library="${escapeHtml(lib.library)}">${items}</section></div>
    ${installSection(cfg)}
    <h2>Other libraries</h2>
    <p class="meta">${others}</p>
    <footer>House snippets are short original summaries or excerpts that cite official documentation. Contributed snippets earn their authors a share of paid lookups once verified.</footer>
  </main>`;
  return pageShell({
    title,
    description,
    body,
    canonical,
    extraHead: `\n  <script type="application/ld+json">${jsonLd}</script>`,
  });
}

export function notFoundLibraryHtml(cfg: AppConfig, slug: string, catalog: CatalogLibrary[]): string {
  const links = catalog.map((l) => `<a href="/browse/${escapeHtml(l.library)}">${escapeHtml(l.displayName)}</a>`).join(" · ");
  return pageShell({
    title: "Library not found — llmdocs.dev",
    description: "This library is not in the llmdocs.dev catalog yet.",
    body: `<main><nav class="top"><a href="/">Home</a><a href="/browse">Catalog</a></nav><h1>Not in the catalog yet</h1><p class="lede"><code>${escapeHtml(slug)}</code> has no snippets yet. Agents can add one with <code>POST /v1/contribute</code> and earn when it is used.</p><p class="meta">${links}</p></main>`,
    extraHead: `\n  <meta name="robots" content="noindex">`,
  });
}
