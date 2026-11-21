/**
 * Box-side payout job. Never import this from the Worker.
 *
 * Reads pending ledger rows from remote D1, sends USDC from the main site
 * wallet when a recipient has accrued at least $0.10, and marks house/reserve
 * shares settled internally. Use --dry-run to plan without sending.
 *
 *   npx tsx scripts/payout.ts --dry-run
 *   npx tsx scripts/payout.ts
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { OWNER_PAYOUT_ADDRESS } from "../src/config.ts";
import { formatUsd } from "../src/money.ts";
import { isSolanaAddress } from "../src/quality.ts";
import {
  planPayouts,
  type PendingLedgerRow,
  type PayoutPlan,
  type PayoutTransfer,
} from "../src/payout-plan.ts";
import { REFERRAL_HOLD_MS, UNLOCK_HELD_REFERRAL_SQL } from "../src/referrals.ts";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = join(ROOT, "payout-logs");
const DEFAULT_KEYFILE = "/home/box/secure/llmdocs-wallets/main.json";
const MAIN_ADDRESS = "EAJiExxSG5K3G4nnqeCZd1DmWMaK6CmisXi53yYa5SJJ";
const BACKUP_ADDRESS = "5qP4XpDyN2bnum8a4EHcT1Zj1xQyhmrLEGpv6fq3iVuJ";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const D1_NAME = "llmdocs";

type D1Response = Array<{ results?: Record<string, unknown>[]; success?: boolean; error?: unknown }>;

function argFlag(name: string): boolean {
  return process.argv.includes(name);
}

function loadMainKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw) || raw.length !== 64) {
    throw new Error("unexpected key file shape");
  }
  const keypair = Keypair.fromSecretKey(Uint8Array.from(raw));
  if (keypair.publicKey.toBase58() !== MAIN_ADDRESS) {
    throw new Error("keyfile does not match the main site wallet; refusing to run");
  }
  return keypair;
}

function assertSafeId(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`refusing to use unsafe id: ${id}`);
  return id;
}

async function d1(command: string): Promise<Record<string, unknown>[]> {
  const { stdout, stderr } = await execFileAsync(
    "npx",
    ["wrangler", "d1", "execute", D1_NAME, "--remote", "--json", "--command", command],
    { cwd: ROOT, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as D1Response;
  const first = parsed[0];
  if (!first || first.success === false) {
    throw new Error(`D1 error: ${JSON.stringify(first ?? stderr)}`);
  }
  return first.results ?? [];
}

async function d1Exec(command: string): Promise<void> {
  await d1(command);
}

async function loadPendingRows(): Promise<PendingLedgerRow[]> {
  const rows = await d1(
    `SELECT id, query_id, wallet, role, amount_micros, status, created_at
     FROM ledger_entries
     WHERE status = 'pending'
     ORDER BY created_at ASC, id ASC`,
  );
  return rows.map((r) => ({
    id: String(r.id),
    wallet: String(r.wallet),
    role: String(r.role),
    amountMicros: Number(r.amount_micros),
    status: String(r.status),
    createdAt: r.created_at == null ? undefined : String(r.created_at),
  }));
}

async function usdcBalanceAndAta(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey,
): Promise<{ micros: number; hasAta: boolean; ata: PublicKey }> {
  const ata = await getAssociatedTokenAddress(mint, owner);
  try {
    const account = await getAccount(connection, ata);
    return { micros: Number(account.amount), hasAta: true, ata };
  } catch {
    return { micros: 0, hasAta: false, ata };
  }
}

async function sendUsdc(opts: {
  connection: Connection;
  from: Keypair;
  mint: PublicKey;
  transfer: PayoutTransfer;
  runId: string;
}): Promise<string> {
  const fromAta = await getAssociatedTokenAddress(opts.mint, opts.from.publicKey);
  const toOwner = new PublicKey(opts.transfer.recipient);
  const toAta = await getAssociatedTokenAddress(opts.mint, toOwner);
  const tx = new Transaction();
  if (opts.transfer.needsAta) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        opts.from.publicKey,
        toAta,
        toOwner,
        opts.mint,
      ),
    );
  }
  tx.add(
    createTransferInstruction(
      fromAta,
      toAta,
      opts.from.publicKey,
      BigInt(opts.transfer.amountMicros),
      [],
      TOKEN_PROGRAM_ID,
    ),
  );
  const sig = await sendAndConfirmTransaction(opts.connection, tx, [opts.from], {
    commitment: "confirmed",
  });
  return sig;
}

function sqlString(value: string | null): string {
  if (value == null) return "NULL";
  return `'${value.replaceAll("'", "''")}'`;
}

async function markEntries(ids: string[], status: string, payoutTx: string | null, runId: string, paidAt: string): Promise<number> {
  const list = ids.map(assertSafeId);
  const inList = list.map((id) => sqlString(id)).join(", ");
  const eligible = await d1(
    `SELECT COUNT(*) AS n FROM ledger_entries WHERE status = 'pending' AND id IN (${inList})`,
  );
  const n = Number(eligible[0]?.n ?? 0);
  if (n !== list.length) {
    throw new Error(`ledger mark expected ${list.length} pending rows, found ${n}`);
  }
  await d1Exec(
    `UPDATE ledger_entries
     SET status = ${sqlString(status)},
         payout_tx = ${sqlString(payoutTx)},
         payout_run_id = ${sqlString(runId)},
         paid_at = ${sqlString(paidAt)}
     WHERE status = 'pending' AND id IN (${inList})`,
  );
  return n;
}

function summarize(plan: PayoutPlan) {
  return {
    transferTotalUsd: formatUsd(plan.transferTotalMicros),
    transfers: plan.transfers.map((t) => ({
      recipient: t.recipient,
      amountUsd: formatUsd(t.amountMicros),
      entries: t.entryIds.length,
      needsAta: t.needsAta,
      source: t.source,
    })),
    internals: plan.internals.map((i) => ({
      wallet: i.wallet,
      amountUsd: formatUsd(i.amountMicros),
      entries: i.entryIds.length,
    })),
    carries: plan.carries.map((c) => ({
      recipient: c.recipient,
      amountUsd: formatUsd(c.amountMicros),
      entries: c.entryIds.length,
      reason: c.reason,
    })),
  };
}

function writeLog(name: string, body: unknown): string {
  mkdirSync(LOG_DIR, { recursive: true });
  const path = join(LOG_DIR, name);
  writeFileSync(path, JSON.stringify(body, null, 2) + "\n");
  return path;
}

function reconcileFromLogs(): Array<{ runId: string; tx: string; entryIds: string[]; status: string }> {
  mkdirSync(LOG_DIR, { recursive: true });
  const out: Array<{ runId: string; tx: string; entryIds: string[]; status: string }> = [];
  for (const name of readdirSync(LOG_DIR)) {
    if (!name.endsWith(".json")) continue;
    try {
      const body = JSON.parse(readFileSync(join(LOG_DIR, name), "utf8")) as {
        runId?: string;
        results?: Array<{ entryIds?: string[]; tx?: string | null; status?: string }>;
      };
      for (const r of body.results ?? []) {
        if (r.tx && r.entryIds && r.entryIds.length > 0) {
          out.push({ runId: body.runId ?? name, tx: r.tx, entryIds: r.entryIds, status: r.status ?? "paid" });
        }
      }
    } catch {
      /* ignore unreadable logs */
    }
  }
  return out;
}

async function main(): Promise<void> {
  const dryRun = argFlag("--dry-run");
  const ownerAddress = process.env.OWNER_PAYOUT_ADDRESS ?? OWNER_PAYOUT_ADDRESS;
  const keyfile = process.env.LLMDOCS_MAIN_KEYFILE ?? DEFAULT_KEYFILE;
  if (!isSolanaAddress(ownerAddress)) throw new Error("owner payout address is not a valid Solana address");
  if (ownerAddress === BACKUP_ADDRESS || ownerAddress === MAIN_ADDRESS) {
    // Paying the owner is fine when they are not the site wallets. Main is the source, never a recipient of this job.
  }
  const runId = crypto.randomUUID();
  const paidAt = new Date().toISOString();

  // Unlock held referral lines that have met the $0.10 spend threshold and 7-day hold.
  const unlockCutoff = new Date(Date.now() - REFERRAL_HOLD_MS).toISOString();
  await d1Exec(UNLOCK_HELD_REFERRAL_SQL(unlockCutoff));

  const pendingBefore = await loadPendingRows();

  // Reconcile: if a previous live run sent a tx but failed to mark D1, mark now and do not resend.
  const prior = reconcileFromLogs();
  const reconciled = [];
  if (!dryRun) {
    const stillPending = new Set(pendingBefore.map((r) => r.id));
    for (const item of prior) {
      const pendingIds = item.entryIds.filter((id) => stillPending.has(id));
      if (pendingIds.length === 0) continue;
      const n = await markEntries(pendingIds, item.status === "settled_internal" ? "settled_internal" : "paid", item.tx, item.runId, paidAt);
      reconciled.push({ tx: item.tx, marked: n });
      for (const id of pendingIds) stillPending.delete(id);
    }
  }

  const pending = dryRun ? pendingBefore : await loadPendingRows();
  const connection = new Connection(RPC, "confirmed");
  const mint = new PublicKey(USDC_MINT);
  const mainPk = new PublicKey(MAIN_ADDRESS);
  const mainTok = await usdcBalanceAndAta(connection, mint, mainPk);

  const recipients = new Set<string>([ownerAddress]);
  for (const row of pending) {
    if (isSolanaAddress(row.wallet) && row.wallet !== MAIN_ADDRESS && row.wallet !== BACKUP_ADDRESS) {
      recipients.add(row.wallet);
    }
  }
  const existingAtas = new Set<string>();
  for (const addr of recipients) {
    const info = await usdcBalanceAndAta(connection, mint, new PublicKey(addr));
    if (info.hasAta) existingAtas.add(addr);
  }

  const plan = planPayouts(pending, {
    ownerAddress,
    mainBalanceMicros: mainTok.micros,
    existingAtas,
  });

  const preview = {
    runId,
    mode: dryRun ? "dry_run" : "live",
    at: paidAt,
    ownerAddress,
    mainWallet: MAIN_ADDRESS,
    mainUsdc: formatUsd(mainTok.micros),
    pendingRows: pending.length,
    reconciled,
    plan: summarize(plan),
  };

  if (dryRun) {
    const path = writeLog(`${paidAt.slice(0, 19).replaceAll(":", "")}-dry-run.json`, preview);
    await d1Exec(
      `INSERT INTO payout_runs (id, mode, created_at, summary_json) VALUES (${sqlString(runId)}, 'dry_run', ${sqlString(paidAt)}, ${sqlString(JSON.stringify(preview))})`,
    );
    console.log(JSON.stringify({ ...preview, log: path, note: "Dry-run only. No USDC was sent." }, null, 2));
    return;
  }

  // Live: load the main key only after planning, never print it.
  const from = loadMainKeypair(keyfile);
  if (from.publicKey.toBase58() === BACKUP_ADDRESS) {
    throw new Error("refusing to spend from the backup wallet");
  }

  const results: Array<{ kind: string; recipient: string; amountUsd: string; tx: string | null; entryIds: string[]; status: string }> = [];

  for (const item of plan.internals) {
    const n = await markEntries(item.entryIds, "settled_internal", null, runId, paidAt);
    results.push({
      kind: "internal",
      recipient: item.wallet,
      amountUsd: formatUsd(item.amountMicros),
      tx: null,
      entryIds: item.entryIds,
      status: `settled_internal (${n} rows)`,
    });
  }

  for (const transfer of plan.transfers) {
    if (transfer.recipient === MAIN_ADDRESS || transfer.recipient === BACKUP_ADDRESS) {
      throw new Error("refusing to transfer to the main or backup site wallet");
    }
    const tx = await sendUsdc({ connection, from, mint, transfer, runId });
    // Persist the signature in the log immediately so a D1 failure cannot cause a retry send.
    const midPath = writeLog(`${runId}-in-flight.json`, { runId, results: [...results, { kind: "transfer", recipient: transfer.recipient, amountUsd: formatUsd(transfer.amountMicros), tx, entryIds: transfer.entryIds, status: "sent" }] });
    const n = await markEntries(transfer.entryIds, "paid", tx, runId, paidAt);
    results.push({
      kind: "transfer",
      recipient: transfer.recipient,
      amountUsd: formatUsd(transfer.amountMicros),
      tx,
      entryIds: transfer.entryIds,
      status: `paid (${n} rows)`,
    });
    void midPath;
  }

  const after = await usdcBalanceAndAta(connection, mint, mainPk);
  const summary = { ...preview, mode: "live", results, mainUsdcAfter: formatUsd(after.micros) };
  const path = writeLog(`${paidAt.slice(0, 19).replaceAll(":", "")}-live.json`, summary);
  await d1Exec(
    `INSERT INTO payout_runs (id, mode, created_at, summary_json) VALUES (${sqlString(runId)}, 'live', ${sqlString(paidAt)}, ${sqlString(JSON.stringify(summary))})`,
  );
  console.log(JSON.stringify({ ...summary, log: path }, null, 2));
}

main().catch((err) => {
  console.error("PAYOUT_FAILED", err instanceof Error ? err.message : err);
  process.exit(1);
});
