import { describe, expect, it } from "vitest";
import { rankSnippets, selectForAnswer } from "../src/search.ts";
import type { Snippet } from "../src/db.ts";

function snip(partial: Partial<Snippet> & Pick<Snippet, "id" | "title" | "body" | "library">): Snippet {
  return {
    libraryVersion: "19.0.0",
    sourceUrl: "https://react.dev/x",
    license: "CC-BY-4.0",
    contentHash: partial.id,
    submitterWallet: "platform",
    status: "verified",
    createdAt: "2026-11-20T00:00:00.000Z",
    retrievedAt: "2026-11-20",
    ...partial,
  };
}

describe("rankSnippets", () => {
  const catalog = [
    snip({
      id: "usestate",
      library: "react",
      title: "useState declares a state variable",
      body: "useState is a React Hook that lets you add a state variable to a component.",
    }),
    snip({
      id: "middleware",
      library: "express",
      title: "Using middleware",
      body: "Middleware functions have access to the request, the response, and next.",
    }),
  ];

  it("ranks the matching library snippet first", () => {
    const ranked = rankSnippets(catalog, "how does useState work", "react");
    expect(ranked[0]?.snippet.id).toBe("usestate");
    expect(selectForAnswer(ranked).map((r) => r.snippet.id)).toEqual(["usestate"]);
  });

  it("does not return rejected snippets in the answer set", () => {
    const rejected = snip({
      id: "bad",
      library: "react",
      title: "useState secrets",
      body: "useState is a React Hook that lets you add a state variable to a component.",
      status: "rejected",
    });
    const ranked = rankSnippets([...catalog, rejected], "useState", "react");
    expect(selectForAnswer(ranked).some((r) => r.snippet.id === "bad")).toBe(false);
  });
});
