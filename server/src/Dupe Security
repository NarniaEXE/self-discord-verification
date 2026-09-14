import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LOG_DIR } from "./config.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, "..");

const dataDir = LOG_DIR || path.join(rootDir, "logs");
fs.mkdirSync(dataDir, { recursive: true });
const identitiesFilePath = path.join(dataDir, "verified-identities.json");

function readIdentities() {
  if (!fs.existsSync(identitiesFilePath)) return {};
  try {
    const raw = fs.readFileSync(identitiesFilePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeIdentities(map) {
  fs.writeFileSync(identitiesFilePath, JSON.stringify(map, null, 2));
}

/**
 * Checks whether a nullifier (a unique fingerprint derived from the ID
 * document, revealing nothing about its actual contents) has already been
 * used by a different Discord account. Records it if it's new.
 *
 * Returns { isDuplicate: boolean, existingUserId?: string }
 */
export function checkAndRecordNullifier(nullifier, discordUserId) {
  if (!nullifier || !discordUserId) {
    return { isDuplicate: false };
  }

  const identities = readIdentities();
  const existingUserId = identities[nullifier];

  if (!existingUserId) {
    identities[nullifier] = discordUserId;
    writeIdentities(identities);
    return { isDuplicate: false };
  }

  if (existingUserId === discordUserId) {
    return { isDuplicate: false };
  }

  return { isDuplicate: true, existingUserId };
}
