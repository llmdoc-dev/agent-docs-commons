/**
 * Shared free-trial / x402 gate so check tools consume the same daily cap as docs lookups.
 */
import { assetSymbolForMint, type AppConfig } from "../config.ts";
import {
  findSettledPayment,
  insertLedgerLines,
  recordQuery,
  recordSettledPayment,
  type Db,
} from "../db.ts";
import { formatUsd, usdToMicros } from "../money.ts";
import { splitQueryFee } from "../payout.ts";
import {
  compactJsonResponse,
  extractPaymentHeader,
  jsonResponse,
  lookupResource,
  requirePayment,
} from "../payment.ts";
import {
  REFERRAL_CAP_MICROS,
  bindReferrerOnFirstPaidLookup,
  markFirstPaidAndAccrual,
  readOfferedReferrer,
  referralWindowActive,
  unlockHeldReferralLines,
} from "../referrals.ts";
import { TRIAL_SHORT_TEXT, consumeFreeLookup } from "../trial.ts";

export type MeteredOk = {
  kind: "free" | "paid";
  remainingFreeLookups?: number;
  payment?: {
    mode: "mock" | "x402";
    payerWallet: string | null;
    transaction?: string | null;
    alreadySettled?: boolean;
    asset?: string;
  };
  responseHeaders: Record<string, string>;
};

export async function gateCheckRequest(
  cfg: AppConfig,
  db: Db,
  req: Request,
  opts: { resourceUrl: string; description: string; discoveryProbe: boolean },
): Promise<{ ok: true; gate: MeteredOk } | { ok: false; response: Response }> {
  const hasPayment = Boolean(extractPaymentHeader(req));

  if (!hasPayment && !opts.discoveryProbe) {
    const trial = await consumeFreeLookup(db, req);
    if (trial.ok) {
      return {
        ok: true,
        gate: {
          kind: "free",
          remainingFreeLookups: trial.remaining,
          responseHeaders: { "cache-control": "no-store" },
        },
      };
    }
  }

  const resource = lookupResource(cfg, opts.resourceUrl);
  resource.description = opts.description;
  const gate = await requirePayment(cfg, req, {
    resourceUrl: opts.resourceUrl,
    description: opts.description,
    priceUsd: cfg.priceLookupUsd,
  });
  if (!gate.ok) return { ok: false, response: gate.response };
  if (opts.discoveryProbe && req.method === "HEAD") {
    return { ok: false, response: new Response(null, { status: 200, headers: gate.responseHeaders }) };
  }
  // For GET discovery probes (missing required params), the caller returns 400 after payment.
  if (gate.payment.mode === "x402" && gate.payment.paymentId) {
    const prior = await findSettledPayment(db, gate.payment.paymentId);
    if (prior) {
      gate.payment.alreadySettled = true;
    } else {
      await recordSettledPayment(db, {
        id: gate.payment.paymentId,
        payerWallet: gate.payment.payerWallet,
        transactionSig: gate.payment.transaction ?? null,
        asset: gate.payment.asset ?? cfg.asset,
      });
    }
  }
  return {
    ok: true,
    gate: {
      kind: "paid",
      payment: gate.payment,
      responseHeaders: gate.responseHeaders,
    },
  };
}

export async function recordCheckAndRespond(
  cfg: AppConfig,
  db: Db,
  req: Request,
  url: URL,
  gate: MeteredOk,
  body: unknown,
  question: string,
  library: string | null,
): Promise<Response> {
  const paymentBlock =
    gate.kind === "free"
      ? {
          mode: "free" as const,
          feeUsd: 0,
          remainingFreeLookups: gate.remainingFreeLookups ?? 0,
          trial: TRIAL_SHORT_TEXT,
          payerWallet: null,
          transaction: null,
        }
      : {
          mode: gate.payment!.mode,
          feeUsd: cfg.priceLookupUsd,
          asset: assetSymbolForMint(gate.payment!.asset ?? cfg.asset),
          assetMint: gate.payment!.asset ?? cfg.asset,
          payerWallet: gate.payment!.payerWallet,
          transaction: gate.payment!.transaction ?? null,
        };

  if (gate.kind === "free") {
    await recordQuery(db, {
      payerWallet: null,
      library,
      question,
      feeMicros: 0,
      paymentMode: "free",
      snippetIds: [],
      settlementTx: null,
    });
    return compactJsonResponse(200, { ...asObject(body), payment: paymentBlock }, gate.responseHeaders);
  }

  const payment = gate.payment!;
  let payoutLines: ReturnType<typeof splitQueryFee> = [];
  if (!payment.alreadySettled) {
    const offered = readOfferedReferrer(req, url);
    let referrerWallet: string | undefined;
    let capRemaining: number | undefined;
    if (payment.payerWallet) {
      const attr = await bindReferrerOnFirstPaidLookup(db, {
        payerWallet: payment.payerWallet,
        offeredReferrer: offered,
      });
      if (attr && referralWindowActive(attr, new Date())) {
        const remaining = REFERRAL_CAP_MICROS - attr.earnedMicros;
        if (remaining > 0) {
          referrerWallet = attr.referrerWallet;
          capRemaining = remaining;
        }
      }
    }
    payoutLines = splitQueryFee(
      cfg.priceLookupUsd,
      [],
      referrerWallet ? { referrerWallet, referralCapRemainingMicros: capRemaining } : {},
    );
    const queryId = await recordQuery(db, {
      payerWallet: payment.payerWallet,
      library,
      question,
      feeMicros: usdToMicros(cfg.priceLookupUsd),
      paymentMode: payment.mode,
      snippetIds: [],
      settlementTx: payment.transaction ?? null,
      paymentAsset: payment.asset ?? cfg.asset,
    });
    await insertLedgerLines(db, queryId, payoutLines, payment.asset ?? cfg.asset);
    if (payment.payerWallet) {
      const referralLine = payoutLines.find((l) => l.role === "referral");
      await markFirstPaidAndAccrual(db, {
        payerWallet: payment.payerWallet,
        amountMicros: referralLine?.amountMicros ?? 0,
      });
      await unlockHeldReferralLines(db);
    }
  }

  const payout = {
    split:
      payoutLines.some((l) => l.role === "referral")
        ? "Check tools have no contributor snippets, so the 60% pool goes to the treasury. 10% referrer, 20% platform, 10% reserve."
        : "Check tools have no contributor snippets, so the 60% pool goes to the treasury. 30% platform, 10% reserve.",
    lines: payoutLines.map((l) => ({
      wallet: l.wallet,
      role: l.role,
      snippetId: l.snippetId,
      amountUsd: formatUsd(l.amountMicros),
      houseOwned: Boolean(l.houseOwned),
    })),
  };

  return compactJsonResponse(200, { ...asObject(body), payment: paymentBlock, payout }, gate.responseHeaders);
}

function asObject(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? (body as Record<string, unknown>) : { result: body };
}

export function checkResourceUrl(publicBaseUrl: string, path: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}${path}`;
}

/** Useful so unused imports don't trip if jsonResponse is needed by callers. */
export { jsonResponse };
