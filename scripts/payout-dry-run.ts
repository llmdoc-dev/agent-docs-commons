import { loadConfig } from "../src/config.ts";
import { openMigratedDb } from "../src/sqlite.ts";
import { dryRunPayload } from "../src/app.ts";
import { formatUsd } from "../src/money.ts";

const cfg = loadConfig();
const db = await openMigratedDb(cfg.dbPath);
const summary = await dryRunPayload(db);
console.log(JSON.stringify({
  ...summary,
  totals: {
    ...summary.totals,
    pendingUsd: formatUsd(summary.totals.pendingMicros),
    platformUsd: formatUsd(summary.totals.platformMicros),
    reserveUsd: formatUsd(summary.totals.reserveMicros),
    treasuryUsd: formatUsd(summary.totals.treasuryMicros),
  },
}, null, 2));
console.log("\nNo USDC was sent (dry-run only).");
