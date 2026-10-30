import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { createElenaServer } from "./server.ts";

const cfg = loadConfig(process.env, path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media"));
createElenaServer(cfg).listen(cfg.port, () => console.log(`elena-service v1 on :${cfg.port} (keys: ${cfg.apiKeys.size}, voice: ${cfg.ttsUrl ? "on" : "off"})`));
