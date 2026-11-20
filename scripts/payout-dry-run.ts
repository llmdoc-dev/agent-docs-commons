import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { dryRunPayload } from "../src/app.ts";
import { formatUsd } from "../src/money.ts";

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const summary = dryRunPayload(db);
console.log(JSON.stringify({
  ...summary,
  totals: {
    ...summary.totals,
    pendingUsd: formatUsd(summary.totals.pendingMicros),
    platformUsd: formatUsd(summary.totals.platformMicros),
    reserveUsd: formatUsd(summary.totals.reserveMicros),
  },
}, null, 2));
console.log("\nNo USDC was sent (dry-run only).");
