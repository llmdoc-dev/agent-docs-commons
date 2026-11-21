import type { AppConfig } from "./config.ts";
import { usdToMicros } from "./money.ts";
import { isSolanaAddress } from "./quality.ts";
import { lookupBazaarExtension } from "./bazaar.ts";

export const MOCK_PAYMENT_PREFIX = "mock:";

export type SettledPayment = {
  mode: "mock" | "x402";
  payerWallet: string | null;
  rawHeader: string;
  transaction?: string | null;
  paymentId?: string;
  alreadySettled?: boolean;
};

export type ResourceInfo = {
  url: string;
  description: string;
  mimeType: "application/json";
  serviceName: string;
  tags?: string[];
};

export type PaymentRequirements = {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    name: "USDC";
    feePayer?: string;
    decimals: 6;
  };
};

export type PaymentRequired = {
  x402Version: 2;
  error: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions: Record<string, unknown>;
  facilitator: { url: string };
  mockSettlement?: { header: string; example: string };
};

export type PaymentPayload = {
  x402Version: number;
  resource?: ResourceInfo | { url: string };
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
};

let feePayerCache: { key: string; feePayer: string | undefined; at: number } | null = null;
const FEE_PAYER_TTL_MS = 5 * 60 * 1000;

export async function facilitatorFeePayer(cfg: AppConfig): Promise<string | undefined> {
  const key = `${cfg.facilitatorUrl}|${cfg.network}`;
  if (feePayerCache && feePayerCache.key === key && Date.now() - feePayerCache.at < FEE_PAYER_TTL_MS) {
    return feePayerCache.feePayer;
  }
  try {
    const url = `${cfg.facilitatorUrl.replace(/\/+$/, "")}/supported`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return feePayerCache?.key === key ? feePayerCache.feePayer : undefined;
    const body = (await res.json()) as { kinds?: Array<{ scheme?: string; network?: string; extra?: { feePayer?: string } }> };
    const match = (body.kinds ?? []).find(
      (k) => k.scheme === "exact" && k.network === cfg.network && k.extra?.feePayer,
    );
    const feePayer = match?.extra?.feePayer;
    feePayerCache = { key, feePayer, at: Date.now() };
    return feePayer;
  } catch {
    return feePayerCache?.key === key ? feePayerCache.feePayer : undefined;
  }
}

export async function buildRequirements(
  cfg: AppConfig,
  resource: ResourceInfo,
  priceUsd: number,
): Promise<PaymentRequirements> {
  const feePayer = await facilitatorFeePayer(cfg);
  return {
    scheme: "exact",
    network: cfg.network,
    amount: String(usdToMicros(priceUsd)),
    asset: cfg.asset,
    payTo: cfg.payTo,
    maxTimeoutSeconds: 60,
    extra: {
      name: "USDC",
      decimals: 6,
      ...(feePayer ? { feePayer } : {}),
    },
  };
}

export async function buildChallenge(
  cfg: AppConfig,
  resource: ResourceInfo,
  priceUsd: number,
  error = "PAYMENT-SIGNATURE header is required",
): Promise<PaymentRequired> {
  const accepts = [await buildRequirements(cfg, resource, priceUsd)];
  const challenge: PaymentRequired = {
    x402Version: 2,
    error,
    resource,
    accepts,
    extensions: lookupBazaarExtension(),
    facilitator: { url: cfg.facilitatorUrl },
  };
  if (cfg.paymentMode === "mock") {
    challenge.mockSettlement = {
      header: "X-PAYMENT",
      example: "mock:<solana-address>",
    };
  }
  return challenge;
}

export function lookupResource(cfg: AppConfig, resourceUrl: string): ResourceInfo {
  return {
    url: resourceUrl,
    description: "Cited, versioned documentation snippet lookup",
    mimeType: "application/json",
    serviceName: "llmdocs",
    tags: ["docs", "developers", "x402"],
  };
}

function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToUtf8(value: string): string {
  const bin = atob(value);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodePaymentRequiredHeader(challenge: PaymentRequired): string {
  const wire = {
    x402Version: challenge.x402Version,
    error: challenge.error,
    resource: challenge.resource,
    accepts: challenge.accepts,
    extensions: challenge.extensions,
  };
  return utf8ToBase64(JSON.stringify(wire));
}

export function encodePaymentResponseHeader(body: unknown): string {
  return utf8ToBase64(JSON.stringify(body));
}

function header(req: Request, name: string): string | null {
  return req.headers.get(name);
}

export function extractPaymentHeader(req: Request): string | null {
  return (
    header(req, "PAYMENT-SIGNATURE") ??
    header(req, "payment-signature") ??
    header(req, "X-PAYMENT") ??
    header(req, "x-payment")
  );
}

function looksLikeBase64(value: string): boolean {
  return /^[A-Za-z0-9+/]+=*$/.test(value) && value.length > 16 && !value.trim().startsWith("{");
}

export function decodePaymentPayload(raw: string): PaymentPayload | null {
  const value = raw.trim();
  const candidates = [value];
  if (looksLikeBase64(value)) {
    try {
      candidates.unshift(base64ToUtf8(value));
    } catch {
      /* not base64 */
    }
  }
  for (const text of candidates) {
    try {
      const parsed = JSON.parse(text) as PaymentPayload;
      if (parsed && typeof parsed === "object" && parsed.accepted && parsed.payload) {
        return parsed;
      }
    } catch {
      /* next */
    }
  }
  return null;
}

function parseMock(raw: string): SettledPayment | null {
  if (!raw.startsWith(MOCK_PAYMENT_PREFIX)) return null;
  const wallet = raw.slice(MOCK_PAYMENT_PREFIX.length).trim();
  if (!isSolanaAddress(wallet)) return null;
  return { mode: "mock", payerWallet: wallet, rawHeader: raw };
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function paymentIdFor(rawHeader: string, payload: PaymentPayload | null, transaction?: string | null): Promise<string> {
  if (transaction) return `tx:${transaction}`;
  const fromPayload =
    (payload?.payload && (payload.payload["transaction"] ?? payload.payload["signature"] ?? payload.payload["tx"])) ??
    null;
  if (typeof fromPayload === "string" && fromPayload.length > 8) return `tx:${fromPayload}`;
  return `h:${await sha256Hex(rawHeader)}`;
}

type FacilitatorResult = {
  ok: boolean;
  payer: string | null;
  transaction: string | null;
  raw: Record<string, unknown>;
};

function facilitatorErrorMessage(body: Record<string, unknown>, fallback: string): string {
  const reason = body.invalidReason ?? body.error ?? body.message;
  if (typeof reason === "string" && reason.trim()) {
    const cleaned = reason.replace(/\s+/g, " ").trim();
    return `${fallback}: ${cleaned.slice(0, 240)}`;
  }
  return fallback;
}

function readFacilitatorResult(body: Record<string, unknown>): FacilitatorResult {
  const payer =
    (typeof body.payer === "string" && body.payer) ||
    (typeof body.payerAddress === "string" && body.payerAddress) ||
    null;
  const transaction =
    (typeof body.transaction === "string" && body.transaction) ||
    (typeof body.txHash === "string" && body.txHash) ||
    null;
  const ok =
    body.success === true ||
    body.isValid === true ||
    body.valid === true ||
    (typeof body.invalidReason === "undefined" && Boolean(payer || transaction) && body.success !== false && body.isValid !== false);
  return { ok, payer, transaction, raw: body };
}

async function callFacilitator(
  cfg: AppConfig,
  path: "/verify" | "/settle",
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<FacilitatorResult> {
  const url = `${cfg.facilitatorUrl.replace(/\/+$/, "")}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      x402Version: 2,
      paymentPayload,
      paymentRequirements,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ok: false, payer: null, transaction: null, raw: { status: res.status, body: text.slice(0, 500) } };
  }
  if (!res.ok) {
    return { ok: false, payer: null, transaction: null, raw: parsed };
  }
  return readFacilitatorResult(parsed);
}

function requirementsCompatible(accepted: PaymentRequirements, expected: PaymentRequirements): boolean {
  return (
    accepted.scheme === expected.scheme &&
    accepted.network === expected.network &&
    accepted.asset === expected.asset &&
    accepted.payTo === expected.payTo &&
    accepted.amount === expected.amount
  );
}

export type PaymentGate =
  | { ok: true; payment: SettledPayment; responseHeaders: Record<string, string> }
  | { ok: false; response: Response };

export async function requirePayment(
  cfg: AppConfig,
  req: Request,
  opts: { resourceUrl: string; description: string; priceUsd: number },
): Promise<PaymentGate> {
  const resource = { ...lookupResource(cfg, opts.resourceUrl), description: opts.description };
  const raw = extractPaymentHeader(req);
  const corsHeaders = paymentCorsHeaders();

  if (cfg.paymentMode === "mock") {
    const settled = raw ? parseMock(raw.trim()) : null;
    if (settled) {
      return {
        ok: true,
        payment: settled,
        responseHeaders: { "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, mode: "mock" }), ...corsHeaders },
      };
    }
    // In mock mode, ignore unsigned real payloads and return a 402 (tests do not send them).
    const challenge = await buildChallenge(cfg, resource, opts.priceUsd);
    return { ok: false, response: paymentRequiredResponse(challenge, corsHeaders) };
  }

  // Production: mock settlement is disabled.
  if (!raw) {
    const challenge = await buildChallenge(cfg, resource, opts.priceUsd);
    return { ok: false, response: paymentRequiredResponse(challenge, corsHeaders) };
  }
  if (raw.trim().startsWith(MOCK_PAYMENT_PREFIX)) {
    const challenge = await buildChallenge(cfg, resource, opts.priceUsd, "mock settlement is disabled");
    return { ok: false, response: paymentRequiredResponse(challenge, corsHeaders) };
  }

  const payload = decodePaymentPayload(raw);
  if (!payload) {
    const challenge = await buildChallenge(cfg, resource, opts.priceUsd, "Invalid PAYMENT-SIGNATURE payload");
    return { ok: false, response: paymentRequiredResponse(challenge, corsHeaders) };
  }

  const expected = await buildRequirements(cfg, resource, opts.priceUsd);
  if (!requirementsCompatible(payload.accepted, expected)) {
    const challenge = await buildChallenge(
      cfg,
      resource,
      opts.priceUsd,
      "Payment payload does not match the advertised requirements",
    );
    return { ok: false, response: paymentRequiredResponse(challenge, corsHeaders) };
  }

  try {
    const verified = await callFacilitator(cfg, "/verify", payload, expected);
    if (!verified.ok) {
      const challenge = await buildChallenge(
        cfg,
        resource,
        opts.priceUsd,
        facilitatorErrorMessage(verified.raw, "Payment verification failed"),
      );
      return { ok: false, response: paymentRequiredResponse(challenge, corsHeaders) };
    }
    const settled = await callFacilitator(cfg, "/settle", payload, expected);
    if (!settled.ok) {
      const challenge = await buildChallenge(
        cfg,
        resource,
        opts.priceUsd,
        facilitatorErrorMessage(settled.raw, "Payment settlement failed"),
      );
      return { ok: false, response: paymentRequiredResponse(challenge, corsHeaders) };
    }
    const transaction = settled.transaction;
    const payer = settled.payer ?? extractPayer(payload);
    const payment: SettledPayment = {
      mode: "x402",
      payerWallet: payer,
      rawHeader: raw,
      transaction,
      paymentId: await paymentIdFor(raw, payload, transaction),
    };
    const responseHeaders = {
      "PAYMENT-RESPONSE": encodePaymentResponseHeader({
        success: true,
        payer,
        transaction,
        network: cfg.network,
      }),
      ...corsHeaders,
    };
    return { ok: true, payment, responseHeaders };
  } catch {
    return {
      ok: false,
      response: jsonResponse(502, { error: "facilitator_unreachable" }, corsHeaders),
    };
  }
}

function extractPayer(payload: PaymentPayload): string | null {
  const p = payload.payload;
  const candidates = [p["payer"], p["from"], p["authority"], p["signer"]];
  const auth = p["authorization"];
  if (auth && typeof auth === "object") {
    const from = (auth as { from?: unknown }).from;
    candidates.push(from);
  }
  for (const c of candidates) {
    if (typeof c === "string" && isSolanaAddress(c)) return c;
  }
  return null;
}

export function paymentCorsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, PAYMENT-SIGNATURE, X-PAYMENT, PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-Llmdocs-Ref",
    "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE, EXTENSION-RESPONSES",
  };
}

export function paymentRequiredResponse(challenge: PaymentRequired, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(challenge, null, 2), {
    status: 402,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "PAYMENT-REQUIRED": encodePaymentRequiredHeader(challenge),
      ...extraHeaders,
      ...paymentCorsHeaders(),
    },
  });
}

export function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...paymentCorsHeaders(),
      ...extraHeaders,
    },
  });
}

export function textResponse(status: number, type: string, body: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": type,
      ...paymentCorsHeaders(),
      ...extraHeaders,
    },
  });
}
