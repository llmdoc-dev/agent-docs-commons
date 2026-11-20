/** USDC-style micro units: 1 USD = 1_000_000 micros. */
export const MICROS = 1_000_000;

export function usdToMicros(usd: number): number {
  return Math.round(usd * MICROS);
}

export function microsToUsd(micros: number): number {
  return Math.round(micros) / MICROS;
}

export function formatUsd(micros: number): string {
  return microsToUsd(micros).toFixed(6);
}
