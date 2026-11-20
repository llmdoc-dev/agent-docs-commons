import { createServer } from "node:http";
import { loadConfig } from "./config.ts";
import { openMigratedDb } from "./sqlite.ts";
import { createApp } from "./app.ts";

const cfg = loadConfig();
const db = await openMigratedDb(cfg.dbPath);
const app = await createApp(cfg, db);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c as Buffer));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(", "));
    }
    const request = new Request(url, { method: req.method, headers, body: body.length ? body : undefined });
    void app.handle(request).then(async (response) => {
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });
      const buf = Buffer.from(await response.arrayBuffer());
      res.end(buf);
    });
  });
});

server.listen(cfg.port, "127.0.0.1", () => {
  console.log(`Agent Docs Commons listening on http://127.0.0.1:${cfg.port}`);
  console.log(`paymentMode=${cfg.paymentMode} network=${cfg.network} payTo=${cfg.payTo}`);
  console.log("Discovery: /llms.txt /openapi.json /.well-known/x402  MCP: POST /mcp or npm run mcp");
});
