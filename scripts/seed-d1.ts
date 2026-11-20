/**
 * Apply official seed snippets to the remote D1 database.
 * Does not touch wallet keys. Idempotent (INSERT OR IGNORE).
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "seed", "d1-seed.sql");
const result = spawnSync(
  "npx",
  ["wrangler", "d1", "execute", "llmdocs", "--remote", "--file", file],
  { stdio: "inherit", cwd: root },
);
process.exit(result.status ?? 1);
