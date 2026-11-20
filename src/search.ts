import type { Snippet } from "./db.ts";

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((t) => t.length >= 2);
}

export type RankedSnippet = { snippet: Snippet; score: number };

export function rankSnippets(
  snippets: Snippet[],
  question: string,
  library?: string,
): RankedSnippet[] {
  const qTokens = tokens(question);
  if (qTokens.length === 0) return [];
  const filtered = library
    ? snippets.filter((s) => s.library === library.toLowerCase())
    : snippets;
  const ranked: RankedSnippet[] = [];
  for (const snippet of filtered) {
    const titleToks = new Set(tokens(snippet.title));
    const bodyToks = new Set(tokens(`${snippet.body} ${snippet.libraryVersion}`));
    let score = 0;
    let hits = 0;
    for (const t of qTokens) {
      if (titleToks.has(t)) {
        score += 3;
        hits += 1;
      } else if (bodyToks.has(t)) {
        score += 1;
        hits += 1;
      }
    }
    if (hits === 0) continue;
    if (hits === qTokens.length) score += 2;
    if (snippet.status === "verified") score += 2;
    if (snippet.status === "rejected") score -= 5;
    ranked.push({ snippet, score });
  }
  ranked.sort((a, b) => b.score - a.score || a.snippet.title.localeCompare(b.snippet.title));
  return ranked;
}

export function selectForAnswer(ranked: RankedSnippet[], limit = 3): RankedSnippet[] {
  return ranked.filter((r) => r.score > 0 && r.snippet.status !== "rejected").slice(0, limit);
}
