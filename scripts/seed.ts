import { loadConfig } from "../src/config.ts";
import { listSnippets } from "../src/db.ts";
import { openMigratedDb } from "../src/sqlite.ts";
import { seedOfficialSnippets } from "../src/seed-data.ts";

const cfg = loadConfig();
const db = await openMigratedDb(cfg.dbPath);
const inserted = await seedOfficialSnippets(db);
const all = await listSnippets(db);
console.log(`Inserted ${inserted} seed snippets. Catalog now has ${all.length} snippets.`);
for (const s of all) {
  console.log(`- ${s.library}@${s.libraryVersion} ${s.id} [${s.status}] house=${s.houseOwned} ${s.sourceUrl}`);
}
