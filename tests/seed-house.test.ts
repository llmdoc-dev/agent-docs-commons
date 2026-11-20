import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { checkSourceUrl, MAX_BODY_CHARS, MIN_BODY_CHARS } from "../src/quality.ts";
import { getSnippet, openDb } from "../src/db.ts";
import { seedOfficialSnippets } from "../src/app.ts";
import { HOUSE_WALLET } from "../src/payout.ts";

const SEED_PATH = new URL("../seed/snippets.json", import.meta.url);
type SeedRow = {
  id: string;
  library: string;
  libraryVersion: string;
  title: string;
  body: string;
  sourceUrl: string;
  license: string;
  retrievedAt: string;
};

describe("official seed catalog", () => {
  const rows = JSON.parse(readFileSync(SEED_PATH, "utf8")) as SeedRow[];

  it("has ~15–20 licensed libraries and records license plus source URL on every snippet", () => {
    const libraries = [...new Set(rows.map((r) => r.library))].sort();
    expect(libraries.length).toBeGreaterThanOrEqual(15);
    expect(libraries.length).toBeLessThanOrEqual(20);
    expect(rows.length).toBe(53);
    expect(libraries).not.toContain("tailwind");
    for (const row of rows) {
      expect(row.license.trim().length).toBeGreaterThan(0);
      expect(row.sourceUrl.startsWith("https://")).toBe(true);
      expect(row.body.length).toBeGreaterThanOrEqual(MIN_BODY_CHARS);
      expect(row.body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
      const source = checkSourceUrl(row.sourceUrl);
      expect(source.ok, `${row.id} ${row.sourceUrl}`).toBe(true);
    }
  });

  it("inserts house-owned official snippets and is idempotent", () => {
    const db = openDb(":memory:");
    const first = seedOfficialSnippets(db);
    expect(first).toBe(rows.length);
    const sample = getSnippet(db, "react-usestate");
    expect(sample?.houseOwned).toBe(true);
    expect(sample?.submitterWallet).toBe(HOUSE_WALLET);
    expect(seedOfficialSnippets(db)).toBe(0);
    const next = getSnippet(db, "next-app-router");
    expect(next?.houseOwned).toBe(true);
    expect(next?.license).toBe("MIT");
  });

  it("migrates legacy platform-seeded rows to house-owned treasury facts", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-commons-migrate-"));
    const path = join(dir, "old.sqlite");
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE snippets (
        id TEXT PRIMARY KEY,
        library TEXT NOT NULL,
        library_version TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        source_url TEXT NOT NULL,
        license TEXT NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        submitter_wallet TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        retrieved_at TEXT NOT NULL
      );
    `);
    raw.prepare(
      `INSERT INTO snippets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "legacy-seed",
      "react",
      "19.0.0",
      "legacy",
      "A long enough body for a migrated official seed snippet used only in this test.",
      "https://react.dev/reference/react/useState",
      "CC-BY-4.0",
      "legacy-hash",
      "platform",
      "verified",
      "2026-11-20T00:00:00.000Z",
      "2026-11-20",
    );
    raw.close();

    const db = openDb(path);
    const migrated = getSnippet(db, "legacy-seed");
    expect(migrated?.houseOwned).toBe(true);
    expect(migrated?.submitterWallet).toBe(HOUSE_WALLET);
  });
});
