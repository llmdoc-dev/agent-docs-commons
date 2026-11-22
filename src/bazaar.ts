/** x402 Bazaar discovery declaration for the paid docs lookup. */
export function lookupBazaarExtension(): Record<string, unknown> {
  const inputSchema = {
    properties: {
      q: { type: "string", description: "Short question or API symbol, e.g. useState or registerTool" },
      library: { type: "string", description: "Library slug from /v1/docs/libraries, e.g. react, nextjs, x402, solana-kit, mcp-typescript, mcp-python, stripe" },
      version: { type: "string", description: "Optional library version prefix to pin" },
      ref: { type: "string", description: "Optional referrer Solana address (referrer earns 10% of this payer's spend for 180 days, up to $10)" },
    },
    required: ["q"],
  };
  const outputExample = {
    results: [
      {
        id: "react-usestate",
        library: "react",
        libraryVersion: "19.0",
        title: "useState declares a state variable",
        body: "useState is a React Hook that lets you add a state variable to your component.",
        sourceUrl: "https://react.dev/reference/react/useState",
        license: "CC-BY-4.0",
        houseOwned: true,
      },
    ],
    payment: { mode: "x402", feeUsd: 0.01 },
  };
  return {
    bazaar: {
      info: {
        input: {
          type: "http",
          method: "GET",
          queryParams: { q: "useState", library: "react" },
        },
        output: { type: "json", example: outputExample },
      },
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          input: {
            type: "object",
            properties: {
              type: { type: "string", const: "http" },
              method: { type: "string", enum: ["GET", "HEAD", "DELETE"] },
              queryParams: { type: "object", ...inputSchema },
            },
            required: ["type", "method"],
            additionalProperties: false,
          },
          output: {
            type: "object",
            properties: {
              type: { type: "string" },
              example: { type: "object" },
            },
            required: ["type"],
          },
        },
        required: ["input"],
      },
    },
  };
}

export function lookupResourceUrl(publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}/v1/docs/lookup`;
}

export function robotsTxt(publicBaseUrl: string): string {
  const origin = publicBaseUrl.replace(/\/+$/, "");
  return `# llmdocs.dev is meant to be read by humans, search engines, and AI agents.
User-agent: *
Allow: /
Allow: /browse/
Disallow: /v1/payouts/

# Content signals (search index and query-time model input are welcome).
Content-signal: search=yes, ai-input=yes

Sitemap: ${origin}/sitemap.xml
`;
}

export function sitemapXml(
  publicBaseUrl: string,
  catalog: Array<{ library: string; lastModified?: string }> = [],
): string {
  const origin = publicBaseUrl.replace(/\/+$/, "");
  const latest = catalog.reduce((max, lib) => (lib.lastModified && lib.lastModified > max ? lib.lastModified : max), "");
  const catalogLastmod = latest || undefined;
  const urls: Array<{ path: string; lastmod?: string }> = [
    { path: "/", lastmod: catalogLastmod },
    { path: "/browse", lastmod: catalogLastmod },
    ...catalog.map((lib) => ({ path: `/browse/${encodeURIComponent(lib.library)}`, lastmod: lib.lastModified })),
    { path: "/referrals" },
    { path: "/llms.txt", lastmod: catalogLastmod },
    { path: "/openapi.json" },
    { path: "/.well-known/x402" },
    { path: "/.well-known/mcp/server-card.json" },
  ];
  const body = urls
    .map(({ path, lastmod }) =>
      lastmod
        ? `  <url><loc>${origin}${path}</loc><lastmod>${lastmod}</lastmod></url>`
        : `  <url><loc>${origin}${path}</loc></url>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;
}
