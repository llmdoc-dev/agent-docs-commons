/** Injectable fetch used by probes and registry lookups so tests can stay offline. */

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

let checkFetchImpl: FetchLike = fetch;

export function getCheckFetch(): FetchLike {
  return checkFetchImpl;
}

export function setCheckFetch(fn: FetchLike): void {
  checkFetchImpl = fn;
}

export function resetCheckFetch(): void {
  checkFetchImpl = fetch;
}
