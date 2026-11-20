import type { Db } from "./db.ts";
import { getSnippet, getSnippetByHash, insertSnippet } from "./db.ts";
import { HOUSE_WALLET } from "./payout.ts";
import { contentHash } from "./quality.ts";
import officialSnippets from "../seed/snippets.json" with { type: "json" };

export type OfficialSnippet = {
  id: string;
  library: string;
  libraryVersion: string;
  title: string;
  body: string;
  sourceUrl: string;
  license: string;
  retrievedAt: string;
};

export const OFFICIAL_SNIPPETS = officialSnippets as OfficialSnippet[];

/** Insert any official seed snippets that are not already in the database. */
export async function seedOfficialSnippets(db: Db): Promise<number> {
  let n = 0;
  for (const row of OFFICIAL_SNIPPETS) {
    if (await getSnippet(db, row.id)) continue;
    const hash = contentHash(row);
    if (await getSnippetByHash(db, hash)) continue;
    await insertSnippet(db, {
      id: row.id,
      library: row.library,
      libraryVersion: row.libraryVersion,
      title: row.title,
      body: row.body,
      sourceUrl: row.sourceUrl,
      license: row.license,
      contentHash: hash,
      submitterWallet: HOUSE_WALLET,
      houseOwned: true,
      status: "verified",
      retrievedAt: row.retrievedAt,
    });
    n += 1;
  }
  return n;
}

export async function seedIfEmpty(db: Db): Promise<number> {
  return seedOfficialSnippets(db);
}
