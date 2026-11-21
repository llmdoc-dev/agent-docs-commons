/**
 * Minimal Jupiter (lite-api) swap helper for box-side scripts. Never import from the Worker.
 * The caller passes a Keypair it loaded itself; this module never reads or prints key files.
 */
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";

export const JUPITER_API = process.env.JUPITER_API_URL ?? "https://lite-api.jup.ag/swap/v1";

export type JupiterQuote = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<{ swapInfo?: { label?: string } }>;
  [k: string]: unknown;
};

export async function jupiterQuote(opts: {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
}): Promise<JupiterQuote> {
  const url = new URL(`${JUPITER_API}/quote`);
  url.searchParams.set("inputMint", opts.inputMint);
  url.searchParams.set("outputMint", opts.outputMint);
  url.searchParams.set("amount", opts.amount.toString());
  url.searchParams.set("slippageBps", String(opts.slippageBps));
  url.searchParams.set("swapMode", "ExactIn");
  url.searchParams.set("restrictIntermediateTokens", "true");
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const body = (await res.json()) as JupiterQuote & { error?: string };
  if (!res.ok || body.error) throw new Error(`jupiter quote failed: HTTP ${res.status} ${body.error ?? ""}`.trim());
  if (body.inputMint !== opts.inputMint || body.outputMint !== opts.outputMint || body.inAmount !== opts.amount.toString()) {
    throw new Error("jupiter quote does not match the request");
  }
  if (Number(body.slippageBps) > opts.slippageBps) throw new Error("jupiter quote slippage exceeds the cap");
  return body;
}

/** Build, sign, send, and confirm the swap. Returns the transaction signature. */
export async function jupiterSwap(
  connection: Connection,
  signer: Keypair,
  quote: JupiterQuote,
  onSent?: (signature: string) => void,
): Promise<string> {
  const res = await fetch(`${JUPITER_API}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: signer.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 200_000, priorityLevel: "medium" } },
    }),
  });
  const body = (await res.json()) as { swapTransaction?: string; error?: string };
  if (!res.ok || !body.swapTransaction) throw new Error(`jupiter swap build failed: HTTP ${res.status} ${body.error ?? ""}`.trim());
  const tx = VersionedTransaction.deserialize(Buffer.from(body.swapTransaction, "base64"));
  const keys = tx.message.staticAccountKeys;
  const required = tx.message.header.numRequiredSignatures;
  if (!keys[0]?.equals(signer.publicKey) || required !== 1) {
    throw new Error("jupiter transaction must have our wallet as the only signer and fee payer");
  }
  tx.sign([signer]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  onSent?.(sig);
  const latest = await connection.getLatestBlockhash("confirmed");
  const conf = await connection.confirmTransaction(
    { signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
    "confirmed",
  );
  if (conf.value.err) throw new Error(`swap ${sig} failed on-chain: ${JSON.stringify(conf.value.err)}`);
  return sig;
}
