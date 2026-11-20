import { loadConfig } from "../src/config.ts";
import { openDb, listSnippets } from "../src/db.ts";
import { seedIfEmpty } from "../src/app.ts";

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const inserted = seedIfEmpty(db);
const all = listSnippets(db);
console.log(`Inserted ${inserted} seed snippets. Catalog now has ${all.length} snippets.`);
for (const s of all) {
  console.log(`- ${s.library}@${s.libraryVersion} ${s.id} [${s.status}] ${s.sourceUrl}`);
}
