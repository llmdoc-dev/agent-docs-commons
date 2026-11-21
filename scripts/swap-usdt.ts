/**
 * Daily USDT -> USDC swap for the main site wallet (box-side only; never import from the Worker).
 *
 * The owner does not want to hold USDT, so every run swaps the wallet's whole
 * USDT balance into USDC through Jupiter:
 *   - at most 1% slippage (slippageBps=100), and a peg guard that refuses a
 *     quote whose worst-case output is under 98% of the input,
 *   - at most 25 USDT per run (the rest waits for the next run),
 *   - skips balances under 0.05 USDT,
 *   - idempotent: a lock file stops overlapping runs, and a swap that was sent
 *     but not yet confirmed is checked before anything new is sent,
 *   - writes a JSON log per run to payout-logs/ (gitignored),
 *   - --dry-run quotes and logs without sending.
 *
 *   npm run swap-usdt -- --dry-run
 *   npm run swap-usdt
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { USDC_MINT_MAINNET, USDT_MINT_MAINNET, MAINNET_PAY_TO } from "../src/config.ts";
import { jupiterQuote, jupiterSwap } from "./lib/jupiter.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = join(ROOT, "payout-logs");
const LOCK = join(LOG_DIR, ".swap-usdt.lock");
const STATE = join(LOG_DIR, "swap-usdt-state.json");
const JSONL = join(LOG_DIR, "swap-usdt.jsonl");
const KEYFILE = process.env.MAIN_KEYFILE ?? "/home/box/secure/llmdocs-wallets/main.json";
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

export const SLIPPAGE_BPS = 100; // 1%
export const MIN_SWAP_ATOMIC = 50_000n; // 0.05 USDT
export const MAX_SWAP_ATOMIC = 25_000_000n; // 25 USDT per run
export const PEG_FLOOR_BPS = 9_800n; // worst-case output must be >= 98% of input
const MIN_SOL_LAMPORTS = 10_000_000; // 0.01 SOL for fees
const LOCK_STALE_MS = 15 * 60 * 1000;
const PENDING_GRACE_MS = 3 * 60 * 1000;

/** Pure planning step (unit-tested): how much to swap this run, or why not. */
export function planUsdtSwap(balanceAtomic: bigint): { swap: bigint; reason: string } {
  if (balanceAtomic < MIN_SWAP_ATOMIC) return { swap: 0n, reason: "below 0.05 USDT; skipped" };
  if (balanceAtomic > MAX_SWAP_ATOMIC) return { swap: MAX_SWAP_ATOMIC, reason: "capped at 25 USDT this run; rest waits for the next run" };
  return { swap: balanceAtomic, reason: "swap whole balance" };
}

/** Peg guard (unit-tested): the quote's worst-case output must stay near $1. */
export function quotePassesPegGuard(inAtomic: bigint, minOutAtomic: bigint): boolean {
  return minOutAtomic * 10_000n >= inAtomic * PEG_FLOOR_BPS;
}

type State = { pending?: { signature: string; sentAt: string; amountAtomic: string } | null };

function fmt(atomic: bigint): string {
  const neg = atomic < 0n;
  const v = neg ? -atomic : atomic;
  return `${neg ? "-" : ""}${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, "0")}`;
}

function loadMainKeypair(): Keypair {
  const raw = JSON.parse(readFileSync(KEYFILE, "utf8"));
  if (!Array.isArray(raw) || raw.length !== 64) throw new Error("unexpected key file shape");
  const kp = Keypair.fromSecretKey(Uint8Array.from(raw));
  if (kp.publicKey.toBase58() !== MAINNET_PAY_TO) throw new Error("keyfile does not match the main site wallet; refusing to run");
  return kp;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(): boolean {
  if (existsSync(LOCK)) {
    try {
      const prev = JSON.parse(readFileSync(LOCK, "utf8")) as { pid: number; at: string };
      const fresh = Date.now() - Date.parse(prev.at) < LOCK_STALE_MS;
      if (fresh && pidAlive(prev.pid)) return false;
    } catch {
      /* unreadable lock: treat as stale */
    }
  }
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  return true;
}

function readState(): State {
  try {
    return JSON.parse(readFileSync(STATE, "utf8")) as State;
  } catch {
    return {};
  }
}

function writeState(state: State): void {
  writeFileSync(STATE, JSON.stringify(state, null, 2));
}

async function tokenBalance(connection: Connection, owner: PublicKey, mint: string): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), owner, false, TOKEN_PROGRAM_ID);
  try {
    return (await getAccount(connection, ata, "confirmed", TOKEN_PROGRAM_ID)).amount;
  } catch {
    return 0n;
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  mkdirSync(LOG_DIR, { recursive: true });
  const startedAt = new Date();
  const log: Record<string, unknown> = { job: "swap-usdt", mode: dryRun ? "dry-run" : "live", startedAt: startedAt.toISOString() };
  const finish = (outcome: string, extra: Record<string, unknown> = {}) => {
    Object.assign(log, { outcome, ...extra, finishedAt: new Date().toISOString() });
    const file = join(LOG_DIR, `${startedAt.toISOString().replace(/[:.]/g, "").slice(0, 17)}-swap-usdt-${dryRun ? "dry-run" : "live"}.json`);
    writeFileSync(file, JSON.stringify(log, null, 2));
    appendFileSync(JSONL, JSON.stringify(log) + "\n");
    console.log(JSON.stringify({ ...log, log: file }, null, 2));
  };

  if (!acquireLock()) {
    finish("skipped", { reason: "another swap-usdt run holds the lock" });
    return;
  }
  try {
    const connection = new Connection(RPC, "confirmed");
    const owner = new PublicKey(MAINNET_PAY_TO);

    // Idempotency: settle the outcome of any swap that was sent but not confirmed.
    const state = readState();
    if (state.pending) {
      const st = await connection.getSignatureStatus(state.pending.signature, { searchTransactionHistory: true });
      const status = st.value;
      if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
        log.previousPending = { ...state.pending, result: status.err ? "failed" : "confirmed" };
        if (!dryRun) writeState({ pending: null });
      } else if (Date.now() - Date.parse(state.pending.sentAt) < PENDING_GRACE_MS) {
        finish("skipped", { reason: "previous swap still confirming", pending: state.pending });
        return;
      } else {
        log.previousPending = { ...state.pending, result: "expired (never landed)" };
        if (!dryRun) writeState({ pending: null });
      }
    }

    const usdtBefore = await tokenBalance(connection, owner, USDT_MINT_MAINNET);
    const usdcBefore = await tokenBalance(connection, owner, USDC_MINT_MAINNET);
    const lamports = await connection.getBalance(owner);
    Object.assign(log, { wallet: owner.toBase58(), usdtBefore: fmt(usdtBefore), usdcBefore: fmt(usdcBefore), solBefore: lamports / 1e9 });

    const plan = planUsdtSwap(usdtBefore);
    log.plan = { swapUsdt: fmt(plan.swap), reason: plan.reason };
    if (plan.swap === 0n) {
      finish("skipped", { reason: plan.reason });
      return;
    }
    if (lamports < MIN_SOL_LAMPORTS) {
      finish("skipped", { reason: "main wallet has under 0.01 SOL for fees" });
      return;
    }

    const quote = await jupiterQuote({
      inputMint: USDT_MINT_MAINNET,
      outputMint: USDC_MINT_MAINNET,
      amount: plan.swap,
      slippageBps: SLIPPAGE_BPS,
    });
    const minOut = BigInt(quote.otherAmountThreshold);
    log.quote = {
      inUsdt: fmt(BigInt(quote.inAmount)),
      expectedUsdc: fmt(BigInt(quote.outAmount)),
      minUsdc: fmt(minOut),
      slippageBps: quote.slippageBps,
      priceImpactPct: quote.priceImpactPct,
      route: quote.routePlan.map((r) => r.swapInfo?.label ?? "?"),
    };
    if (!quotePassesPegGuard(plan.swap, minOut)) {
      finish("aborted", { reason: "peg guard: worst-case output under 98% of input; not swapping, needs a human decision" });
      return;
    }
    if (dryRun) {
      finish("dry-run", { reason: "quote only; nothing sent" });
      return;
    }

    const kp = loadMainKeypair();
    const signature = await jupiterSwap(connection, kp, quote, (sig) => {
      writeState({ pending: { signature: sig, sentAt: new Date().toISOString(), amountAtomic: plan.swap.toString() } });
    });
    writeState({ pending: null });
    const usdtAfter = await tokenBalance(connection, owner, USDT_MINT_MAINNET);
    const usdcAfter = await tokenBalance(connection, owner, USDC_MINT_MAINNET);
    finish("swapped", {
      signature,
      solscan: `https://solscan.io/tx/${signature}`,
      usdtAfter: fmt(usdtAfter),
      usdcAfter: fmt(usdcAfter),
      usdcGained: fmt(usdcAfter - usdcBefore),
    });
  } catch (err) {
    finish("error", { error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  } finally {
    rmSync(LOCK, { force: true });
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  void main();
}
