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
export const IDENTITIES_FILE_PATH = identitiesFilePath;

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

/**
 * Removes any recorded nullifier -> Discord account mappings for the given
 * Discord user, so they can verify fresh (e.g. after being manually
 * unverified by staff). Returns the number of entries removed.
 */
export function removeIdentityByDiscordUserId(discordUserId) {
  if (!discordUserId) return 0;

  const identities = readIdentities();
  let removed = 0;

  for (const [nullifier, mappedUserId] of Object.entries(identities)) {
    if (mappedUserId === discordUserId) {
      delete identities[nullifier];
      removed += 1;
    }
  }

  if (removed > 0) {
    writeIdentities(identities);
  }

  return removed;
}

const backupsDir = path.join(dataDir, "backups");
const MAX_BACKUPS_KEPT = 7;

function runBackup() {
  if (!fs.existsSync(identitiesFilePath)) return;

  fs.mkdirSync(backupsDir, { recursive: true });

  const dateLabel = new Date().toISOString().slice(0, 10);
  const backupPath = path.join(backupsDir, `verified-identities-${dateLabel}.json`);

  try {
    fs.copyFileSync(identitiesFilePath, backupPath);
  } catch {
    // best-effort only, don't crash the bot over a failed backup
    return;
  }

  // Keep only the most recent MAX_BACKUPS_KEPT backups
  try {
    const files = fs
      .readdirSync(backupsDir)
      .filter((f) => f.startsWith("verified-identities-"))
      .sort();
    const excess = files.length - MAX_BACKUPS_KEPT;
    if (excess > 0) {
      for (const file of files.slice(0, excess)) {
        fs.unlinkSync(path.join(backupsDir, file));
      }
    }
  } catch {
    // cleanup is best-effort
  }
}

/**
 * Starts a daily automatic backup of the identity database, keeping the
 * last MAX_BACKUPS_KEPT copies. Call this once at startup.
 */
export function scheduleAutoBackup() {
  runBackup(); // one immediately on startup
  setInterval(runBackup, 24 * 60 * 60 * 1000); // then every 24 hours
}
