import type { Db } from "./db.ts";

type D1Stmt = {
  bind: (...params: unknown[]) => D1Bound;
};

type D1Bound = {
  run: () => Promise<unknown>;
  first: <T = Record<string, unknown>>() => Promise<T | null>;
  all: <T = Record<string, unknown>>() => Promise<{ results: T[] }>;
};

export type D1Like = {
  exec: (sql: string) => Promise<unknown>;
  prepare: (sql: string) => D1Stmt;
};

export function wrapD1(d1: D1Like): Db {
  const bound = (sql: string, params: unknown[]): D1Bound => {
    const stmt = d1.prepare(sql);
    return params.length ? stmt.bind(...params) : stmt.bind();
  };
  return {
    async exec(sql: string) {
      await d1.exec(sql);
    },
    async run(sql: string, ...params: unknown[]) {
      await bound(sql, params).run();
    },
    async get(sql: string, ...params: unknown[]) {
      const row = await bound(sql, params).first();
      return row ?? undefined;
    },
    async all(sql: string, ...params: unknown[]) {
      const res = await bound(sql, params).all();
      return res.results as Record<string, unknown>[];
    },
  };
}
