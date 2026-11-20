export const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const DEFAULT_FACILITATOR = "https://x402.org/facilitator";
/** Throwaway devnet address generated for this prototype. No secret is in the repo. Not a user wallet. */
export const DEFAULT_PAY_TO = "Gm3Ae1UTwJsLj5NKHhznJccYiGLMMdfJiZUJ39hLAsoH";
/**
 * Public address of the llmdocs.dev site treasury (Solana mainnet).
 * Candidate only: loadConfig does not use this value, PAYMENT_MODE stays mock,
 * and a mainnet X402_NETWORK is still rejected. Secret key is not in this repo.
 */
export const MAINNET_PAY_TO_CANDIDATE = "EAJiExxSG5K3G4nnqeCZd1DmWMaK6CmisXi53yYa5SJJ";
export const OWNER_PAYOUT_ADDRESS = "7vUCMQL5U5RtyLskFrrW7L5i7YV4pTtqg72qG87BoxSB"; // owner Phantom, receives owner share
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
};

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const paymentMode = (process.env.PAYMENT_MODE ?? "mock") as PaymentMode;
  if (paymentMode !== "mock" && paymentMode !== "x402") {
    throw new Error("PAYMENT_MODE must be mock or x402");
  }
  const network = process.env.X402_NETWORK ?? SOLANA_DEVNET_CAIP2;
  if (network.includes("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") || network.includes("mainnet")) {
    throw new Error("Mainnet is disabled in this prototype. Use Solana devnet only.");
  }
  return {
    port: Number(process.env.PORT ?? 8787),
    paymentMode,
    payTo: process.env.PAY_TO ?? DEFAULT_PAY_TO,
    network,
    facilitatorUrl: process.env.FACILITATOR_URL ?? DEFAULT_FACILITATOR,
    priceLookupUsd: Number(process.env.PRICE_LOOKUP_USD ?? 0.01),
    dbPath: process.env.DB_PATH ?? "data/commons.sqlite",
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://127.0.0.1:8787",
    ...overrides,
  };
}
