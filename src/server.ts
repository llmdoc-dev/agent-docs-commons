import { createServer } from "node:http";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const app = createApp(cfg, db);

const server = createServer((req, res) => {
  void app.handle(req, res);
});

server.listen(cfg.port, "127.0.0.1", () => {
  console.log(`Agent Docs Commons listening on http://127.0.0.1:${cfg.port}`);
  console.log(`paymentMode=${cfg.paymentMode} network=${cfg.network} payTo=${cfg.payTo}`);
  console.log("Discovery: /llms.txt /openapi.json  MCP: npm run mcp");
});
