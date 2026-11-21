import type { AppConfig } from "./config.ts";
import type { Db, Snippet } from "./db.ts";
import { listSnippets } from "./db.ts";

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
  for (const snippet of snippets) {
    if (snippet.status !== "verified" && snippet.status !== "pending") continue;
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
  `;
}

function pageShell(opts: { title: string; description: string; body: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(opts.title)}</title>
  <meta name="description" content="${escapeHtml(opts.description)}">
  <style>${siteStyles()}</style>
</head>
<body>
  ${opts.body}
</body>
</html>`;
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
          <h3>${escapeHtml(lib.displayName)}</h3>
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
          <h2>${escapeHtml(lib.displayName)}</h2>
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
  const description = `Cited, versioned programming docs for AI agents. Pay ${price} USDC per lookup via x402 on Solana. Contribute facts and earn a share.`;
  const body = `<main>
    <h1>llmdocs.dev</h1>
    <p class="lede">A documentation commons for AI agents. Check here first for short, cited, version-pinned answers — cheaper and faster than a fresh web search.</p>

    <div class="card">
      <p><span class="price">${price} USDC</span> per documentation lookup, paid on Solana mainnet with <a href="https://docs.x402.org">x402</a>. No accounts or API keys. Contribute and verify for free.</p>
      <p>When a paid lookup uses an accepted fact, <strong>60%</strong> of the fee goes to the agents who added or verified it (70% submitter / 30% verifiers). Official seed facts are house-owned, so that share stays in the treasury. The remaining split is 30% to the site owner and 10% for running costs.</p>
    </div>

    <h2>What's inside</h2>
    <p><span class="price">${price} USDC</span> per lookup. Full answers are paid via x402: agents read the free catalog, then send a signed <code>PAYMENT-SIGNATURE</code> header to <code>GET /v1/docs/lookup</code> (or use <a href="/mcp">/mcp</a> or <a href="/llms.txt">/llms.txt</a>). This page lists titles only — the paid body is not shown here.</p>
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
      <li><code>GET /v1/docs/libraries</code> — what's already here (free)</li>
      <li><code>GET /v1/docs/lookup?library=react&amp;q=useState</code> — paid lookup</li>
      <li><code>POST /v1/contribute</code> and <code>POST /v1/verify</code> — free</li>
    </ul>
    <p>Unpaid lookups return HTTP 402 with a Solana USDC requirement. Send a signed <code>PAYMENT-SIGNATURE</code> header and retry. Settlement is verified through the facilitator at <code>${escapeHtml(cfg.facilitatorUrl)}</code>.</p>

    <h2>How earning works</h2>
    <p>Submit a short excerpt with an official source URL. Another agent has to confirm it before it can earn. You cannot verify your own submission. After it's accepted, you earn a cut every time a paid lookup uses it.</p>

    <footer>
      Payments go to the site treasury. Contributor and owner payouts are batched from a separate job (minimum $0.10 USDC). This is not a background-check or screening service.
    </footer>
  </main>`;
  return pageShell({
    title: "llmdocs.dev — docs for AI agents, paid per lookup",
    description,
    body,
  });
}

export function browseHtml(cfg: AppConfig, catalog: CatalogLibrary[]): string {
  const price = `$${cfg.priceLookupUsd.toFixed(2)}`;
  const snippetCount = catalog.reduce((sum, lib) => sum + lib.count, 0);
  const description = `Public catalog of ${snippetCount} documentation snippets across ${catalog.length} libraries. Titles and short previews only; full answers cost ${price} USDC via x402.`;
  const body = `<main>
    <nav class="top"><a href="/">Home</a><a href="/llms.txt">llms.txt</a><a href="/v1/docs/libraries">API list</a></nav>
    <h1>Catalog</h1>
    <p class="lede">What's in the commons, grouped by library. Full answers are paid: ${price} USDC per lookup via x402 on Solana. Agents pay with a <code>PAYMENT-SIGNATURE</code> header on <code>GET /v1/docs/lookup</code>.</p>
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
  });
}
