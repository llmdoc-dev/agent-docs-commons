/** x402 Bazaar discovery declaration for the paid docs lookup. */
export function lookupBazaarExtension(): Record<string, unknown> {
  const inputSchema = {
    properties: {
      q: { type: "string", description: "The question or API symbol to look up, e.g. useState" },
      library: { type: "string", description: "Library id, e.g. react, express, zod, nextjs" },
      version: { type: "string", description: "Optional library version pin" },
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

# Content signals (search index and query-time model input are welcome).
Content-signal: search=yes, ai-input=yes

Sitemap: ${origin}/sitemap.xml
`;
}

export function sitemapXml(publicBaseUrl: string): string {
  const origin = publicBaseUrl.replace(/\/+$/, "");
  const urls = [
    "/",
    "/browse",
    "/referrals",
    "/llms.txt",
    "/openapi.json",
    "/.well-known/x402",
    "/robots.txt",
    "/v1/docs/libraries",
    "/mcp",
  ];
  const body = urls
    .map((path) => `  <url><loc>${origin}${path}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;
}
