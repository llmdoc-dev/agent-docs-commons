import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { migrate, type Db } from "./db.ts";

function bind(params: unknown[]): SQLInputValue[] {
  return params as SQLInputValue[];
}

export function wrapSqlite(raw: DatabaseSync): Db {
  return {
    async exec(sql: string) {
      raw.exec(sql);
    },
    async run(sql: string, ...params: unknown[]) {
      raw.prepare(sql).run(...bind(params));
    },
    async get(sql: string, ...params: unknown[]) {
      return raw.prepare(sql).get(...bind(params)) as Record<string, unknown> | undefined;
    },
    async all(sql: string, ...params: unknown[]) {
      return raw.prepare(sql).all(...bind(params)) as Record<string, unknown>[];
    },
  };
}

/** Open a local SQLite file (or :memory:) and run migrations. Node/tests/scripts only. */
export function openDb(dbPath: string): Db {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath) || ".", { recursive: true });
  }
  const raw = new DatabaseSync(dbPath);
  raw.exec("PRAGMA foreign_keys = ON;");
  if (dbPath !== ":memory:") {
    raw.exec("PRAGMA journal_mode = WAL;");
  }
  const db = wrapSqlite(raw);
  // migrate is async but sqlite ops are sync; kick it and expose a ready handle.
  // Callers should `await readyDb(dbPath)` when they need migrations finished.
  return db;
}

export async function openMigratedDb(dbPath: string): Promise<Db> {
  const db = openDb(dbPath);
  await migrate(db);
  return db;
}
