import type { AppConfig } from "../config.ts";
import { escapeHtml, pageShell, topNav } from "../catalog.ts";
import { FREE_TEXT, PRICE_TEXT } from "../descriptions.ts";
import { listServices } from "./seed.ts";
import { CHECK_DISCLAIMER } from "./types.ts";

export function checkPageHtml(cfg: AppConfig): string {
  const origin = cfg.publicBaseUrl;
  const services = listServices();
  const rows = services
    .map((s) => {
      const docs = s.docsLibrary
        ? `<a href="/browse/${escapeHtml(s.docsLibrary)}">${escapeHtml(s.docsLibrary)} docs</a>`
        : "—";
      const verified = s.plans.filter((p) => p.verifiedAt).length;
      const freshness = escapeHtml(s.freshness);
      return `<tr>
        <td><code>${escapeHtml(s.slug)}</code><br><span class="meta">${escapeHtml(s.displayName)}</span></td>
        <td>${escapeHtml(s.category)}</td>
        <td>${freshness} (${verified} verified plan${verified === 1 ? "" : "s"})</td>
        <td><a href="${escapeHtml(s.pricingUrl)}">Official pricing</a></td>
        <td>${docs}</td>
      </tr>`;
    })
    .join("\n");

  const description = `Check whether an API, site, or package is up, and read cited current plan and limit facts, before you rely on it. Part of llmdocs.dev.`;
  const body = `<main>
    ${topNav()}
    <h1>Check before you rely on it</h1>
    <p class="lede">One preflight for AI agents: is the service reachable, is the package still maintained, and what does the official pricing page say right now? Every number has a source URL and a verified date. If we could not read a figure, it is left blank — never guessed.</p>
    <p class="price">${escapeHtml(PRICE_TEXT)}. ${escapeHtml(FREE_TEXT)}. Check tools share the same daily free cap as docs lookups.</p>

    <div class="card">
      <h2>For agents</h2>
      <p>New tools on the existing <a href="/mcp">llmdocs MCP server</a>: <code>preflight</code>, <code>check_status</code>, <code>check_package</code>, <code>get_pricing</code>, and <code>list_check_services</code> (free). REST equivalents:</p>
      <pre class="snippet-code">GET ${escapeHtml(origin)}/v1/check/preflight?service=openai
GET ${escapeHtml(origin)}/v1/check/status?service=stripe
GET ${escapeHtml(origin)}/v1/check/pricing?service=supabase
GET ${escapeHtml(origin)}/v1/check/package?ecosystem=npm&amp;name=request
GET ${escapeHtml(origin)}/v1/check/services</pre>
      <p class="note">Need the docs for a library after a check looks good? Use <a href="/browse">the catalog</a> or the <code>docs_lookup</code> tool. ${escapeHtml(CHECK_DISCLAIMER)}</p>
    </div>

    <h2>Seeded services (${services.length})</h2>
    <p class="note">Pricing facts were read from official pages on 25 Nov 2026. <code>verified</code> means we captured plan or model numbers from the source. <code>partial</code> means some numbers are cited and the rest are blank. <code>unknown</code> means the official page was recorded but numbers were not readable, so they are null.</p>
    <table>
      <thead><tr><th>Service</th><th>Category</th><th>Pricing facts</th><th>Source</th><th>Docs in llmdocs</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <h2>Also check a package</h2>
    <p>Any npm, PyPI, crates.io, or Go module name: we ask the official registry whether it exists, what the latest version is, and whether it is deprecated or yanked.</p>

    <footer>
      This page is free. Paid check calls (after the daily cap) use the same x402 payment as <a href="/">docs lookups</a>.
    </footer>
  </main>`;

  return pageShell({
    title: "Check — status, packages, and pricing facts — llmdocs.dev",
    description,
    body,
    canonical: `${origin}/check`,
  });
}
