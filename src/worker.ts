import { createApp, type App } from "./app.ts";
import { wrapD1, type D1Like } from "./d1.ts";
import { loadWorkerConfig, type WorkerEnv } from "./config.ts";
import { paymentCorsHeaders } from "./payment.ts";

export interface Env extends WorkerEnv {
  DB: D1Like;
}

let cached: App | null = null;
let starting: Promise<App> | null = null;

async function getApp(env: Env): Promise<App> {
  if (cached) return cached;
  if (!starting) {
    starting = (async () => {
      const cfg = loadWorkerConfig(env);
      const db = wrapD1(env.DB);
      const app = await createApp(cfg, db);
      cached = app;
      return app;
    })().finally(() => {
      starting = null;
    });
  }
  return starting;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const host = new URL(request.url).hostname.toLowerCase();
    if (host === "www.llmdocs.dev") {
      const target = new URL(request.url);
      target.hostname = "llmdocs.dev";
      return new Response(null, {
        status: 301,
        headers: { Location: target.toString(), ...paymentCorsHeaders() },
      });
    }
    const app = await getApp(env);
    return app.handle(request);
  },
};
