export const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/** Official Circle USDC mints. */
export const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_MINT_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/** SPL Token and Token-2022 program ids. */
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/**
 * Tether USD₮ on Solana mainnet, as listed on https://tether.to/en/supported-protocols/
 * (SPL Token program, 6 decimals; checked on-chain 2026-11-21).
 */
export const USDT_MINT_MAINNET = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
/**
 * PayPal USD (PYUSD), issued by Paxos, Solana mainnet, as listed on
 * https://docs.paxos.com/guides/stablecoin/pyusd/mainnet (Token-2022, 6 decimals).
 */
export const PYUSD_MINT_MAINNET = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";

export type AssetSymbol = "USDC" | "PYUSD" | "USDT";

export type PaymentAsset = {
  symbol: AssetSymbol;
  mint: string;
  decimals: 6;
  tokenProgram: string;
  issuer: string;
};

export const MAINNET_ASSETS: Record<AssetSymbol, PaymentAsset> = {
  USDC: { symbol: "USDC", mint: USDC_MINT_MAINNET, decimals: 6, tokenProgram: TOKEN_PROGRAM, issuer: "Circle" },
  PYUSD: { symbol: "PYUSD", mint: PYUSD_MINT_MAINNET, decimals: 6, tokenProgram: TOKEN_2022_PROGRAM, issuer: "Paxos (PayPal USD)" },
  USDT: { symbol: "USDT", mint: USDT_MINT_MAINNET, decimals: 6, tokenProgram: TOKEN_PROGRAM, issuer: "Tether" },
};

/** Default order matters: the first entry is the default (USDC). */
export const DEFAULT_MAINNET_ASSET_ORDER: AssetSymbol[] = ["USDC", "PYUSD", "USDT"];

const DEVNET_USDC: PaymentAsset = {
  symbol: "USDC",
  mint: USDC_MINT_DEVNET,
  decimals: 6,
  tokenProgram: TOKEN_PROGRAM,
  issuer: "Circle",
};

/**
 * Accepted assets for a network. On mainnet, `enabled` (comma list of symbols,
 * e.g. "USDC,PYUSD") restricts the list; USDC is always kept and always first.
 */
export function assetsForNetwork(network: string, enabled?: string): PaymentAsset[] {
  if (!isMainnetNetwork(network)) return [DEVNET_USDC];
  const wanted = enabled
    ? new Set(
        enabled
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
      )
    : null;
  return DEFAULT_MAINNET_ASSET_ORDER.filter((sym) => sym === "USDC" || !wanted || wanted.has(sym)).map(
    (sym) => MAINNET_ASSETS[sym],
  );
}

/** Map a mint to its symbol (for ledger and stats display). Unknown mints return the mint. */
export function assetSymbolForMint(mint: string | null | undefined): string {
  if (!mint) return "USDC";
  if (mint === USDC_MINT_DEVNET) return "USDC";
  for (const a of Object.values(MAINNET_ASSETS)) if (a.mint === mint) return a.symbol;
  return mint;
}

/** Public test facilitator (Solana devnet only). */
export const DEFAULT_FACILITATOR = "https://x402.org/facilitator";
/**
 * Production facilitator: PayAI (`https://facilitator.payai.network`).
 * Supports x402 v2 exact on Solana mainnet without an account or API key for ordinary exact payments.
 * Dexter also lists Solana mainnet, but its advertised fee payer was too close to
 * the rent-exempt floor to settle when we tested (InsufficientFundsForRent).
 */
export const PRODUCTION_FACILITATOR = "https://facilitator.payai.network";

/** Throwaway devnet address generated for the prototype. No secret is in the repo. */
export const DEFAULT_PAY_TO = "Gm3Ae1UTwJsLj5NKHhznJccYiGLMMdfJiZUJ39hLAsoH";

/**
 * Public address of the llmdocs.dev site treasury (Solana mainnet).
 * This is a public receive address only. The secret key is not in this repo,
 * not in Worker bindings, and not in Wrangler secrets.
 */
export const MAINNET_PAY_TO = "EAJiExxSG5K3G4nnqeCZd1DmWMaK6CmisXi53yYa5SJJ";
/** Associated USDC token account for MAINNET_PAY_TO. Public address only. */
export const MAINNET_USDC_ATA = "HRrDNF7wbaX7yZEG52vzTt6JR4JDvPiUZB4wkn4pgBYB";
/** Main wallet PYUSD (Token-2022) and USDT associated token accounts. Public addresses only. */
export const MAINNET_PYUSD_ATA = "DYKf6yrv1aPrZKVpBZ8M5CFwUEirxxwxHWrgiphpCYZi";
export const MAINNET_USDT_ATA = "GLgbqRQBS5gL4A6putusVqtoWARRqjCb381xmQaqs3uz";
/** @deprecated use MAINNET_PAY_TO */
export const MAINNET_PAY_TO_CANDIDATE = MAINNET_PAY_TO;

/** Owner Phantom public address; receives the 30% owner share from a later payout job. */
export const OWNER_PAYOUT_ADDRESS = "7vUCMQL5U5RtyLskFrrW7L5i7YV4pTtqg72qG87BoxSB";

export const PLATFORM_WALLET = "platform";

export type PaymentMode = "mock" | "x402";

export type AppConfig = {
  port: number;
  paymentMode: PaymentMode;
  payTo: string;
  network: string;
  facilitatorUrl: string;
  priceLookupUsd: number;
  dbPath: string;
  publicBaseUrl: string;
  /** Default (first) payment asset mint: USDC. */
  asset: string;
  /** Every accepted payment asset, default first. */
  assets: PaymentAsset[];
  ownerPayoutAddress: string;
};

export function isMainnetNetwork(network: string): boolean {
  return network.includes("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") || /mainnet/i.test(network);
}

export function usdcMintForNetwork(network: string): string {
  return isMainnetNetwork(network) ? USDC_MINT_MAINNET : USDC_MINT_DEVNET;
}

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[name];
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const paymentMode = (readEnv("PAYMENT_MODE") ?? "mock") as PaymentMode;
  if (paymentMode !== "mock" && paymentMode !== "x402") {
    throw new Error("PAYMENT_MODE must be mock or x402");
  }
  const network = readEnv("X402_NETWORK") ?? SOLANA_DEVNET_CAIP2;
  const allowMainnet = readEnv("ALLOW_MAINNET") === "1" || readEnv("X402_ALLOW_MAINNET") === "1";
  const effectiveNetwork = overrides.network ?? network;
  const effectiveMode = overrides.paymentMode ?? paymentMode;
  if (isMainnetNetwork(effectiveNetwork) && effectiveMode === "x402" && !allowMainnet && overrides.network === undefined) {
    // Allow an explicit override (tests/worker) or ALLOW_MAINNET=1. Default Node boot stays off mainnet.
    throw new Error("Mainnet is disabled unless ALLOW_MAINNET=1 is set. Tests and local scripts default to Solana devnet / mock.");
  }
  if (isMainnetNetwork(network) && !allowMainnet && overrides.network === undefined && overrides.paymentMode === undefined) {
    throw new Error("Mainnet is disabled unless ALLOW_MAINNET=1 is set.");
  }
  const cfgNetwork = effectiveNetwork;
  return {
    port: Number(readEnv("PORT") ?? 8787),
    paymentMode: effectiveMode,
    payTo: readEnv("PAY_TO") ?? DEFAULT_PAY_TO,
    network: cfgNetwork,
    facilitatorUrl: readEnv("FACILITATOR_URL") ?? DEFAULT_FACILITATOR,
    priceLookupUsd: Number(readEnv("PRICE_LOOKUP_USD") ?? 0.01),
    dbPath: readEnv("DB_PATH") ?? "data/commons.sqlite",
    publicBaseUrl: readEnv("PUBLIC_BASE_URL") ?? "http://127.0.0.1:8787",
    ownerPayoutAddress: readEnv("OWNER_PAYOUT_ADDRESS") ?? OWNER_PAYOUT_ADDRESS,
    ...overrides,
    ...resolveAssets(overrides, cfgNetwork, readEnv("X402_ASSETS")),
  };
}

function resolveAssets(
  overrides: Partial<AppConfig>,
  network: string,
  enabled: string | undefined,
): { asset: string; assets: PaymentAsset[] } {
  if (overrides.assets && overrides.assets.length > 0) {
    return { asset: overrides.assets[0]!.mint, assets: overrides.assets };
  }
  const list = assetsForNetwork(network, enabled);
  if (overrides.asset && overrides.asset !== list[0]!.mint) {
    const custom: PaymentAsset = { ...list[0]!, mint: overrides.asset };
    return { asset: overrides.asset, assets: [custom] };
  }
  return { asset: list[0]!.mint, assets: list };
}

export type WorkerEnv = {
  DB: unknown;
  PAY_TO?: string;
  FACILITATOR_URL?: string;
  PUBLIC_BASE_URL?: string;
  PRICE_LOOKUP_USD?: string;
  OWNER_PAYOUT_ADDRESS?: string;
  X402_NETWORK?: string;
  PAYMENT_MODE?: string;
  /** Optional comma list of accepted asset symbols (USDC always on), e.g. "USDC,PYUSD". */
  X402_ASSETS?: string;
};

export function loadWorkerConfig(env: WorkerEnv): AppConfig {
  const network = env.X402_NETWORK ?? SOLANA_MAINNET_CAIP2;
  const paymentMode = (env.PAYMENT_MODE ?? "x402") as PaymentMode;
  if (paymentMode === "mock") {
    throw new Error("PAYMENT_MODE=mock is not allowed in the production Worker.");
  }
  return {
    port: 0,
    paymentMode: "x402",
    payTo: env.PAY_TO ?? MAINNET_PAY_TO,
    network,
    facilitatorUrl: env.FACILITATOR_URL ?? PRODUCTION_FACILITATOR,
    priceLookupUsd: Number(env.PRICE_LOOKUP_USD ?? 0.01),
    dbPath: "",
    publicBaseUrl: env.PUBLIC_BASE_URL ?? "https://llmdocs.dev",
    ...resolveAssets({}, network, env.X402_ASSETS),
    ownerPayoutAddress: env.OWNER_PAYOUT_ADDRESS ?? OWNER_PAYOUT_ADDRESS,
  };
}

/** Public, display-friendly list of accepted assets (default first). */
export function acceptedAssetsPublic(cfg: Pick<AppConfig, "assets" | "asset">): Array<{
  symbol: string;
  mint: string;
  decimals: number;
  tokenProgram: string;
  issuer: string;
  default: boolean;
}> {
  const list = cfg.assets?.length ? cfg.assets : [];
  return list.map((a, i) => ({
    symbol: a.symbol,
    mint: a.mint,
    decimals: a.decimals,
    tokenProgram: a.tokenProgram,
    issuer: a.issuer,
    default: i === 0,
  }));
}

/** "USDC, PYUSD, or USDT" from the configured list. */
export function acceptedAssetsSentence(cfg: Pick<AppConfig, "assets">): string {
  const syms = (cfg.assets ?? []).map((a) => a.symbol);
  if (syms.length <= 1) return syms[0] ?? "USDC";
  if (syms.length === 2) return `${syms[0]} or ${syms[1]}`;
  return `${syms.slice(0, -1).join(", ")}, or ${syms[syms.length - 1]}`;
}
