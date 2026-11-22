import { describe, expect, it } from "vitest";
import { buildPublicCatalog, snippetPreview, PREVIEW_MAX_CHARS } from "../src/catalog.ts";
import type { Snippet } from "../src/db.ts";

function snippet(partial: Partial<Snippet> & Pick<Snippet, "id" | "library" | "title" | "body" | "status">): Snippet {
  return {
    libraryVersion: "1",
    sourceUrl: "https://example.com",
    license: "MIT",
    contentHash: partial.id,
    submitterWallet: partial.houseOwned ? "house" : "BDkdaa5aHZZooaG2dRRMzBNe33PzTqZoZyQaBxVrdzi7",
    houseOwned: false,
    createdAt: "2026-11-20T00:00:00Z",
    retrievedAt: "2026-11-20T00:00:00Z",
    ...partial,
  };
}

describe("snippetPreview", () => {
  it("caps previews at 120 characters and never returns the full paid body", () => {
    const body =
      "useState is a React Hook that lets you add a state variable to a component. Call const [state, setState] = useState(initialValue) at the top level of your component. React keeps the state between re-renders.";
    const preview = snippetPreview(body);
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS + 1); // includes ellipsis
    expect(preview).not.toBe(body);
    expect(body.startsWith(preview.slice(0, -1).trim()) || body.includes(preview.slice(0, 20))).toBe(true);
    expect(preview).not.toContain("React keeps the state between re-renders");
  });

  it("still withholds the last character of a short body so the paid text is never complete", () => {
    const preview = snippetPreview("Short paid body.");
    expect(preview).toBe("Short paid…");
    expect(preview).not.toBe("Short paid body.");
  });
});

describe("buildPublicCatalog", () => {
  it("groups by library, keeps pending contributions, and drops rejected snippets", () => {
    const catalog = buildPublicCatalog([
      snippet({ id: "r1", library: "react", title: "useState", body: "A house body that is definitely longer than the preview cap for safety.", status: "verified", houseOwned: true }),
      snippet({ id: "r2", library: "react", title: "pending hook", body: "A contributed pending body that also needs to be long enough to truncate in the preview.", status: "pending", houseOwned: false }),
      snippet({ id: "r3", library: "react", title: "rejected hook", body: "This rejected body must not appear in the public catalog at all.", status: "rejected", houseOwned: false }),
      snippet({ id: "d1", library: "django", title: "QuerySet", body: "Django QuerySet filtering is described in the official docs at length so this preview stays short. UNIQUE_DJANGO_PAID_TAIL should never appear in the catalog JSON.", status: "verified", houseOwned: true }),
    ]);
    expect(catalog.map((l) => l.library)).toEqual(["django", "react"]);
    const react = catalog.find((l) => l.library === "react")!;
    expect(react.count).toBe(2);
    expect(react.displayName).toBe("React");
    expect(react.snippets.map((s) => s.title)).toEqual(["useState", "pending hook"]);
    expect(react.snippets[0]!.source).toBe("house");
    expect(react.snippets[1]!.source).toBe("contributed");
    expect(react.snippets[1]!.status).toBe("pending");
    expect(react.snippets.some((s) => s.title === "rejected hook")).toBe(false);
    expect(JSON.stringify(catalog)).not.toContain("UNIQUE_DJANGO_PAID_TAIL");
    expect(catalog[0]!.snippets[0]!).not.toHaveProperty("body");
  });
});

describe("catalog lastModified", () => {
  it("uses the latest created or retrieved day per library and feeds sitemap lastmod", async () => {
    const { sitemapXml } = await import("../src/bazaar.ts");
    const catalog = buildPublicCatalog([
      snippet({ id: "v1", library: "vitest", title: "a", body: "A vitest body long enough to make a preview for the catalog.", status: "verified", houseOwned: true, createdAt: "2026-11-20T00:00:00.000Z", retrievedAt: "2026-11-22" }),
      snippet({ id: "v2", library: "vitest", title: "b", body: "Another vitest body long enough to make a preview for the catalog.", status: "verified", houseOwned: true, createdAt: "2026-11-21T00:00:00.000Z", retrievedAt: "2026-11-21" }),
    ]);
    expect(catalog[0]!.lastModified).toBe("2026-11-22");
    const xml = sitemapXml("https://llmdocs.dev", catalog);
    expect(xml).toContain("<loc>https://llmdocs.dev/browse/vitest</loc><lastmod>2026-11-22</lastmod>");
    expect(xml).toContain("<loc>https://llmdocs.dev/referrals</loc></url>");
  });
});
