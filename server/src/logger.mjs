import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LOG_DIR } from "./config.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, "..");

const logsDir = LOG_DIR || path.join(rootDir, "logs");
fs.mkdirSync(logsDir, { recursive: true });
const logFilePath = path.join(logsDir, "discord-verifier.log");
export const LOG_FILE_PATH = logFilePath;

export function logEvent(type, message, extra = {}) {
  const timestamp = new Date().toISOString();
  const payload = { timestamp, type, message, ...extra };
  console.log(`[${timestamp}] [${type}] ${message}`, extra);
  fs.appendFile(logFilePath, `${JSON.stringify(payload)}\n`, (err) => {
    if (err) {
      console.error("Failed to write log line:", err);
    }
  });
}
