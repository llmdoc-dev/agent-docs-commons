import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "./config.ts";
import { usdToMicros } from "./money.ts";
import { isSolanaAddress } from "./quality.ts";

export const MOCK_PAYMENT_PREFIX = "mock:";

export type SettledPayment = {
  mode: "mock" | "x402";
  payerWallet: string | null;
  rawHeader: string;
};

export type PaymentChallenge = {
  x402Version: 2;
  error: "PAYMENT_REQUIRED";
  accepts: Array<{
    scheme: "exact";
    network: string;
    amount: string;
    asset: "USDC";
    payTo: string;
    description: string;
    mimeType: "application/json";
    resource: string;
  }>;
  facilitator: { url: string; note: string };
  mockSettlement?: { header: string; example: string };
};

export function buildChallenge(
  cfg: AppConfig,
  resource: string,
  description: string,
  priceUsd: number,
): PaymentChallenge {
  const amount = String(usdToMicros(priceUsd));
  const challenge: PaymentChallenge = {
    x402Version: 2,
    error: "PAYMENT_REQUIRED",
    accepts: [
      {
        scheme: "exact",
        network: cfg.network,
        amount,
        asset: "USDC",
        payTo: cfg.payTo,
        description,
        mimeType: "application/json",
        resource,
      },
    ],
    facilitator: {
      url: cfg.facilitatorUrl,
      note: "x402.org facilitator advertises Solana devnet (solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1). This prototype does not settle mainnet payments.",
    },
  };
  if (cfg.paymentMode === "mock") {
    challenge.mockSettlement = {
      header: "X-PAYMENT",
      example: "mock:<solana-address>",
    };
  }
  return challenge;
}

export function parsePaymentHeader(raw: string | undefined, mode: AppConfig["paymentMode"]): SettledPayment | null {
  if (!raw) return null;
  const value = raw.trim();
  if (value.startsWith(MOCK_PAYMENT_PREFIX)) {
    if (mode !== "mock") return null;
    const wallet = value.slice(MOCK_PAYMENT_PREFIX.length).trim();
    if (!isSolanaAddress(wallet)) return null;
    return { mode: "mock", payerWallet: wallet, rawHeader: value };
  }
  // A real x402 payload would be verified with the facilitator here.
  // This prototype does not hold a payer key, so signed payloads are not settled.
  if (mode === "x402") {
    return null;
  }
  return null;
}

export function requirePayment(
  cfg: AppConfig,
  req: IncomingMessage,
  res: ServerResponse,
  opts: { resource: string; description: string; priceUsd: number },
): SettledPayment | null {
  const header = headerValue(req, "x-payment") ?? headerValue(req, "payment-signature");
  const settled = parsePaymentHeader(header, cfg.paymentMode);
  if (settled) {
    res.setHeader("X-PAYMENT-RESPONSE", `${settled.mode}-settled`);
    return settled;
  }
  const challenge = buildChallenge(cfg, opts.resource, opts.description, opts.priceUsd);
  res.statusCode = 402;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(challenge, null, 2));
  return null;
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}
