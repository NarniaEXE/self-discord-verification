import fs from "node:fs";
import crypto from "node:crypto";
import express from "express";

import { DASHBOARD_PASSWORD, DASHBOARD_USERS, DISCORD_GUILD_ID } from "./config.mjs";
import { LOG_FILE_PATH, logEvent } from "./logger.mjs";
import { getDiscordClient, getPendingVerifications } from "./discordBot.mjs";
import { IDENTITIES_FILE_PATH } from "./identityTracker.mjs";

const ROLE_RANK = { moderator: 1, admin: 2, owner: 3 };
const SESSION_COOKIE_NAME = "dashboard_session";
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const sessions = new Map(); // token -> { user, role, expiresAt }

function parseDashboardUsers() {
  if (!DASHBOARD_USERS) return null;
  const map = {};
  for (const pair of DASHBOARD_USERS.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(":").map((p) => p.trim());
    const [name, pass, role] = parts;
    if (name && pass) {
      const normalizedRole = ROLE_RANK[role] ? role : "moderator";
      map[name] = { password: pass, role: normalizedRole };
    }
  }
  return Object.keys(map).length > 0 ? map : null;
}

const dashboardUsers = parseDashboardUsers();

function checkCredentials(username, password) {
  if (dashboardUsers && dashboardUsers[username] && dashboardUsers[username].password === password) {
    return { user: username, role: dashboardUsers[username].role };
  }
  if (DASHBOARD_PASSWORD && password === DASHBOARD_PASSWORD) {
    return { user: username || "shared", role: "owner" };
  }
  return null;
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const result = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    result[key] = decodeURIComponent(value);
  }
  return result;
}

function createSession(user, role) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { user, role, expiresAt: Date.now() + SESSION_DURATION_MS });
  return token;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function setSessionCookie(res, token) {
  const maxAgeSeconds = Math.floor(SESSION_DURATION_MS / 1000);
  res.set(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax`,
  );
}

function clearSessionCookie(res) {
  res.set("Set-Cookie", `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

// For JSON/API routes: accepts a session cookie OR Basic Auth (handy for
// scripts/curl), always responds with JSON on failure.
function requireDashboardAuth(req, res, next) {
  if (!DASHBOARD_PASSWORD && !dashboardUsers) {
    return res
      .status(404)
      .send("Dashboard is not configured. Set DASHBOARD_PASSWORD to enable it.");
  }

  const session = getSession(req);
  if (session) {
    req.dashboardUser = session.user;
    req.dashboardRole = session.role;
    return next();
  }

  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");
    const username = separatorIndex === -1 ? decoded : decoded.slice(0, separatorIndex);
    const password = separatorIndex === -1 ? "" : decoded.slice(separatorIndex + 1);
    const result = checkCredentials(username, password);
    if (result) {
      req.dashboardUser = result.user;
      req.dashboardRole = result.role;
      return next();
    }
  }

  return res.status(401).json({ error: "Not authenticated." });
}

// For HTML page routes: redirects to the login page instead of a JSON 401.
function requirePageAuth(req, res, next) {
  if (!DASHBOARD_PASSWORD && !dashboardUsers) {
    return res
      .status(404)
      .send("Dashboard is not configured. Set DASHBOARD_PASSWORD to enable it.");
  }

  const session = getSession(req);
  if (session) {
    req.dashboardUser = session.user;
    req.dashboardRole = session.role;
    return next();
  }

  res.redirect("/login?next=" + encodeURIComponent(req.originalUrl));
}

function requireRole(minRole) {
  const minRank = ROLE_RANK[minRole] || 1;
  return (req, res, next) => {
    const rank = ROLE_RANK[req.dashboardRole] || 0;
    if (rank < minRank) {
      return res.status(403).send("You don't have permission to access this.");
    }
    next();
  };
}

function readLogEntries(limit = 1000) {
  if (!fs.existsSync(LOG_FILE_PATH)) return [];

  const raw = fs.readFileSync(LOG_FILE_PATH, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const entries = [];

  for (const line of lines.slice(-limit)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }

  return entries;
}

const RELEVANT_EVENT_TYPES = new Set([
  "verification.started",
  "verification.succeeded",
  "verification.failed",
  "verification.error",
  "verification.role_assigned",
  "verification.dm_failed",
  "verification.failure_dm_failed",
  "verification.log_channel_error",
  "verification.duplicate_identity",
  "discord.ready",
  "discord.commands_registered",
]);

const AUDIT_EVENT_TYPES = new Set([
  "discord.say_command_used",
  "discord.setup_verify_button_used",
  "dashboard.message_sent",
  "verification.duplicate_identity",
]);

const usernameCache = new Map();

async function resolveUsername(discordUserId) {
  if (!discordUserId) return null;
  if (usernameCache.has(discordUserId)) return usernameCache.get(discordUserId);

  const client = getDiscordClient();
  if (!client) return discordUserId;

  try {
    const user = await client.users.fetch(discordUserId);
    const name = user.globalName || user.username || discordUserId;
    usernameCache.set(discordUserId, name);
    return name;
  } catch {
    usernameCache.set(discordUserId, discordUserId);
    return discordUserId;
  }
}

function buildDailyStats(entries, days = 14) {
  const dayMap = new Map();
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    dayMap.set(key, { date: key, succeeded: 0, failed: 0 });
  }

  for (const e of entries) {
    if (e.type !== "verification.succeeded" && e.type !== "verification.failed") {
      continue;
    }
    const key = (e.timestamp || "").slice(0, 10);
    if (!dayMap.has(key)) continue;
    const bucket = dayMap.get(key);
    if (e.type === "verification.succeeded") bucket.succeeded += 1;
    else bucket.failed += 1;
  }

  return Array.from(dayMap.values());
}

export function registerDashboardRoutes(app) {
  app.get("/login", (req, res) => {
    if (!DASHBOARD_PASSWORD && !dashboardUsers) {
      return res
        .status(404)
        .send("Dashboard is not configured. Set DASHBOARD_PASSWORD to enable it.");
    }

    const existingSession = getSession(req);
    if (existingSession) {
      return res.redirect("/dashboard");
    }

    const error = req.query.error === "1";
    const next = typeof req.query.next === "string" ? req.query.next : "/dashboard";
    res.set("Content-Type", "text/html").send(buildLoginHtml({ error, next }));
  });

  app.post(
    "/login",
    express.urlencoded({ extended: false }),
    (req, res) => {
      if (!DASHBOARD_PASSWORD && !dashboardUsers) {
        return res.status(404).send("Dashboard is not configured.");
      }

      const { username, password } = req.body || {};
      const nextPath =
        typeof req.body?.next === "string" && req.body.next.startsWith("/")
          ? req.body.next
          : "/dashboard";

      const result = checkCredentials(username, password);
      if (!result) {
        return res.redirect(
          "/login?error=1&next=" + encodeURIComponent(nextPath),
        );
      }

      const token = createSession(result.user, result.role);
      setSessionCookie(res, token);
      logEvent("dashboard.login", "Staff logged into the dashboard", {
        user: result.user,
        role: result.role,
      });
      res.redirect(nextPath);
    },
  );

  app.get("/logout", (req, res) => {
    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE_NAME];
    if (token) sessions.delete(token);
    clearSessionCookie(res);
    res.redirect("/login");
  });

  app.get("/api/whoami", requireDashboardAuth, (req, res) => {
    res.json({ user: req.dashboardUser, role: req.dashboardRole });
  });

  app.get("/api/dashboard-data", requireDashboardAuth, async (_req, res) => {
    const entries = readLogEntries(1000);

    const succeededEntries = entries.filter(
      (e) => e.type === "verification.succeeded",
    );
    const failedEntries = entries.filter((e) => e.type === "verification.failed");
    const errorEntries = entries.filter((e) => e.type === "verification.error");
    const started = entries.filter(
      (e) => e.type === "verification.started",
    ).length;

    const succeeded = succeededEntries.length;
    const failed = failedEntries.length;
    const errors = errorEntries.length;
    const successRate =
      succeeded + failed > 0
        ? Math.round((succeeded / (succeeded + failed)) * 1000) / 10
        : null;

    const duplicates = entries.filter(
      (e) => e.type === "verification.duplicate_identity",
    ).length;

    let underage = 0;
    let ofac = 0;
    let otherFailure = 0;
    for (const e of failedEntries) {
      if (e.isMinimumAgeValid === false) underage += 1;
      else if (e.isOfacValid === true) ofac += 1;
      else otherFailure += 1;
    }

    const daily = buildDailyStats(entries, 14);

    const now = Date.now();
    const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
    const thisWeekStart = now - oneWeekMs;
    const lastWeekStart = now - 2 * oneWeekMs;

    function countInWindow(type, from, to) {
      return entries.filter((e) => {
        if (e.type !== type) return false;
        const t = new Date(e.timestamp).getTime();
        return t >= from && t < to;
      }).length;
    }

    const weekComparison = {
      thisWeek: {
        succeeded: countInWindow("verification.succeeded", thisWeekStart, now),
        failed: countInWindow("verification.failed", thisWeekStart, now),
      },
      lastWeek: {
        succeeded: countInWindow("verification.succeeded", lastWeekStart, thisWeekStart),
        failed: countInWindow("verification.failed", lastWeekStart, thisWeekStart),
      },
    };

    const pendingSessions = getPendingVerifications();
    const pendingNow = pendingSessions.length;
    const oldestPendingMinutes =
      pendingNow > 0
        ? Math.round(
            (Date.now() - Math.min(...pendingSessions.map((s) => s.createdAt))) / 60000,
          )
        : null;

    const droppedOff = Math.max(0, started - succeeded - failed - errors - duplicates);
    const dropOffRate =
      started > 0 ? Math.round((droppedOff / started) * 1000) / 10 : null;

    const feed = entries
      .filter((e) => RELEVANT_EVENT_TYPES.has(e.type))
      .slice(-150)
      .reverse();

    const uniqueIds = [...new Set(feed.map((e) => e.discordUserId).filter(Boolean))];
    const usernames = {};
    await Promise.all(
      uniqueIds.map(async (id) => {
        usernames[id] = await resolveUsername(id);
      }),
    );

    const enrichedFeed = feed.map((e) => ({
      ...e,
      username: e.discordUserId ? usernames[e.discordUserId] || null : null,
    }));

    res.json({
      stats: {
        started,
        succeeded,
        failed,
        errors,
        duplicates,
        successRate,
        pendingNow,
        oldestPendingMinutes,
        droppedOff,
        dropOffRate,
      },
      failureBreakdown: { underage, ofac, other: otherFailure },
      weekComparison,
      daily,
      feed: enrichedFeed,
    });
  });

  app.get("/api/export-csv", requireDashboardAuth, requireRole("admin"), async (_req, res) => {
    const entries = readLogEntries(5000).filter((e) =>
      RELEVANT_EVENT_TYPES.has(e.type),
    );

    const uniqueIds = [
      ...new Set(entries.map((e) => e.discordUserId).filter(Boolean)),
    ];
    const usernames = {};
    await Promise.all(
      uniqueIds.map(async (id) => {
        usernames[id] = await resolveUsername(id);
      }),
    );

    const header = [
      "timestamp",
      "type",
      "discord_user_id",
      "username",
      "message",
      "is_minimum_age_valid",
      "is_ofac_valid",
    ];

    const csvEscape = (value) => {
      if (value === null || value === undefined) return "";
      const str = String(value);
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const rows = entries.map((e) =>
      [
        e.timestamp,
        e.type,
        e.discordUserId || "",
        e.discordUserId ? usernames[e.discordUserId] || "" : "",
        e.message || "",
        e.isMinimumAgeValid === undefined ? "" : e.isMinimumAgeValid,
        e.isOfacValid === undefined ? "" : e.isOfacValid,
      ]
        .map(csvEscape)
        .join(","),
    );

    const csv = [header.join(","), ...rows].join("\n");

    res.set("Content-Type", "text/csv");
    res.set(
      "Content-Disposition",
      `attachment; filename="verification-log-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(csv);
  });

  app.get("/dashboard", requirePageAuth, (_req, res) => {
    res.set("Content-Type", "text/html").send(DASHBOARD_HTML);
  });

  app.get("/api/channels", requireDashboardAuth, async (_req, res) => {
    const client = getDiscordClient();
    if (!client) {
      return res.status(503).json({ error: "Bot is not connected yet." });
    }

    try {
      const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
      const channels = await guild.channels.fetch();

      const textChannels = [...channels.values()]
        .filter((c) => c && c.isTextBased && c.isTextBased() && !c.isThread())
        .map((c) => ({ id: c.id, name: c.name, position: c.position || 0 }))
        .sort((a, b) => a.position - b.position);

      res.json({ channels: textChannels });
    } catch (error) {
      logEvent("dashboard.channels_fetch_error", "Failed to fetch channel list", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Failed to fetch channels." });
    }
  });

  app.post("/api/send-message", requireDashboardAuth, async (req, res) => {
    const { channelId, message, senderName } = req.body || {};

    if (!channelId || !message || !message.trim()) {
      return res.status(400).json({ error: "channelId and message are required." });
    }

    const effectiveSenderName =
      req.dashboardUser && req.dashboardUser !== "shared"
        ? req.dashboardUser
        : senderName && senderName.trim();

    if (!effectiveSenderName) {
      return res.status(400).json({ error: "Please enter your name for the audit log." });
    }

    const client = getDiscordClient();
    if (!client) {
      return res.status(503).json({ error: "Bot is not connected yet." });
    }

    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        return res.status(400).json({ error: "That channel can't receive messages." });
      }

      await channel.send(message);

      logEvent("dashboard.message_sent", "Message sent via dashboard compose", {
        channelId,
        channelName: channel.name,
        senderName: effectiveSenderName,
        message,
      });

      res.json({ success: true });
    } catch (error) {
      logEvent("dashboard.send_message_error", "Failed to send message via dashboard", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Failed to send message. Check bot permissions in that channel." });
    }
  });

  app.get("/compose", requirePageAuth, (_req, res) => {
    res.set("Content-Type", "text/html").send(COMPOSE_HTML);
  });

  app.get("/api/audit-data", requireDashboardAuth, requireRole("admin"), async (_req, res) => {
    const entries = readLogEntries(1000);

    const feed = entries
      .filter((e) => AUDIT_EVENT_TYPES.has(e.type))
      .slice(-200)
      .reverse();

    const uniqueIds = [
      ...new Set(
        feed
          .map((e) => e.staffUserId || e.discordUserId)
          .filter(Boolean),
      ),
    ];
    const usernames = {};
    await Promise.all(
      uniqueIds.map(async (id) => {
        usernames[id] = await resolveUsername(id);
      }),
    );

    const enrichedFeed = feed.map((e) => {
      const actorId = e.staffUserId || e.discordUserId;
      return {
        ...e,
        actorId,
        actorName:
          e.senderName ||
          e.staffUsername ||
          (actorId ? usernames[actorId] : null) ||
          actorId ||
          "unknown",
      };
    });

    res.json({ feed: enrichedFeed });
  });

  app.get("/audit-log", requirePageAuth, requireRole("admin"), (_req, res) => {
    res.set("Content-Type", "text/html").send(AUDIT_HTML);
  });

  app.get("/api/backup/logs", requireDashboardAuth, requireRole("owner"), (_req, res) => {
    if (!fs.existsSync(LOG_FILE_PATH)) {
      return res.status(404).send("No log file found yet.");
    }

    logEvent("dashboard.backup_downloaded", "Staff downloaded a log backup", {
      file: "logs",
    });

    res.download(
      LOG_FILE_PATH,
      `verification-logs-${new Date().toISOString().slice(0, 10)}.log`,
    );
  });

  app.get("/api/backup/identities", requireDashboardAuth, requireRole("owner"), (_req, res) => {
    if (!fs.existsSync(IDENTITIES_FILE_PATH)) {
      return res.status(404).send("No identity database found yet.");
    }

    logEvent("dashboard.backup_downloaded", "Staff downloaded an identity DB backup", {
      file: "identities",
    });

    res.download(
      IDENTITIES_FILE_PATH,
      `verified-identities-${new Date().toISOString().slice(0, 10)}.json`,
    );
  });
}

const AUDIT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Audit Log</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0f1115;
    color: #e6e8eb;
    padding: 24px;
  }
  h1 { font-size: 20px; margin: 0 0 8px; color: #fff; }
  .nav { font-size: 13px; margin-bottom: 20px; }
  .nav a { color: #8fa2ff; text-decoration: none; margin-right: 16px; }
  #search {
    width: 100%;
    padding: 8px 12px;
    margin-bottom: 12px;
    background: #171a21;
    border: 1px solid #262a33;
    border-radius: 8px;
    color: #e6e8eb;
    font-size: 13px;
  }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #21242c; vertical-align: top; }
  th { color: #9aa0aa; font-weight: 500; text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; }
  tr:hover { background: #1c1f27; }
  .badge { padding: 2px 8px; border-radius: 6px; font-size: 12px; font-weight: 600; white-space: nowrap; }
  .badge.say { background: rgba(143,162,255,0.15); color: #8fa2ff; }
  .badge.compose { background: rgba(62,207,142,0.15); color: #3ecf8e; }
  .badge.setup { background: rgba(242,193,78,0.15); color: #f2c14e; }
  .badge.duplicate { background: rgba(242,84,91,0.15); color: #f2545b; }
  .muted { color: #6b7180; }
  #updated { font-size: 12px; color: #6b7180; margin-bottom: 16px; }
</style>
</head>
<body>
  <h1>Audit Log</h1>
  <div class="nav"><a href="/dashboard">&larr; Dashboard</a><a href="/compose">Send a message &rarr;</a><a href="/logout" style="color: #f2545b; margin-left: 16px;">Log out</a></div>
  <div id="updated">Loading...</div>

  <input id="search" type="text" placeholder="Search by name, channel, or message..." />

  <table>
    <thead>
      <tr><th>Time</th><th>Action</th><th>Who</th><th>Where</th><th>Content</th></tr>
    </thead>
    <tbody id="feed-body">
      <tr><td colspan="5" class="muted">Loading...</td></tr>
    </tbody>
  </table>

  <script>
    let latestFeed = [];

    function badgeInfo(type) {
      if (type === "discord.say_command_used") return { cls: "say", label: "/say" };
      if (type === "dashboard.message_sent") return { cls: "compose", label: "Compose" };
      if (type === "discord.setup_verify_button_used") return { cls: "setup", label: "Setup Button" };
      if (type === "verification.duplicate_identity") return { cls: "duplicate", label: "Duplicate ID" };
      return { cls: "", label: type };
    }

    function formatTime(iso) {
      return new Date(iso).toLocaleString();
    }

    function renderFeed(filterText) {
      const tbody = document.getElementById("feed-body");
      tbody.innerHTML = "";

      const term = (filterText || "").trim().toLowerCase();
      const filtered = !term
        ? latestFeed
        : latestFeed.filter((e) => {
            const haystack = [
              e.actorName,
              e.channelName,
              e.message,
              e.existingUserId,
            ]
              .filter(Boolean)
              .join(" ")
              .toLowerCase();
            return haystack.includes(term);
          });

      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="muted">No matching entries.</td></tr>';
        return;
      }

      for (const entry of filtered) {
        const tr = document.createElement("tr");
        const info = badgeInfo(entry.type);
        const where = entry.channelName ? "#" + entry.channelName : (entry.existingUserId ? "vs <@" + entry.existingUserId + ">" : "-");
        const content = entry.message || entry.reason || entry.message === "" ? (entry.message || "") : "-";
        const actorCell = entry.actorId
          ? '<a href="https://discord.com/users/' + entry.actorId + '" target="_blank" style="color: #8fa2ff; text-decoration: none;">' + (entry.actorName || entry.actorId) + "</a>"
          : (entry.actorName || "-");
        tr.innerHTML =
          "<td>" + formatTime(entry.timestamp) + "</td>" +
          '<td><span class="badge ' + info.cls + '">' + info.label + "</span></td>" +
          "<td>" + actorCell + "</td>" +
          "<td>" + where + "</td>" +
          '<td class="muted">' + content + "</td>";
        tbody.appendChild(tr);
      }
    }

    async function refresh() {
      try {
        const res = await fetch("/api/audit-data", { credentials: "same-origin" });
        if (!res.ok) return;
        const data = await res.json();
        latestFeed = data.feed;
        renderFeed(document.getElementById("search").value);
        document.getElementById("updated").textContent =
          "Last updated: " + new Date().toLocaleTimeString();
      } catch (err) {
        console.error("Failed to refresh audit log", err);
      }
    }

    document.getElementById("search").addEventListener("input", (e) => {
      renderFeed(e.target.value);
    });

    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>
`;

const COMPOSE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Send Message</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0f1115;
    color: #e6e8eb;
    padding: 24px;
    max-width: 560px;
  }
  h1 { font-size: 20px; margin: 0 0 8px; color: #fff; }
  .nav { font-size: 13px; margin-bottom: 20px; }
  .nav a { color: #8fa2ff; text-decoration: none; }
  label { display: block; font-size: 12px; color: #9aa0aa; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; margin-top: 16px; }
  select, textarea {
    width: 100%;
    padding: 10px 12px;
    background: #171a21;
    border: 1px solid #262a33;
    border-radius: 8px;
    color: #e6e8eb;
    font-size: 14px;
    font-family: inherit;
  }
  textarea { min-height: 120px; resize: vertical; }
  button {
    margin-top: 18px;
    padding: 10px 20px;
    background: #3ecf8e;
    color: #0f1115;
    border: none;
    border-radius: 8px;
    font-weight: 700;
    font-size: 14px;
    cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  #status { margin-top: 14px; font-size: 13px; }
  #status.success { color: #3ecf8e; }
  #status.error { color: #f2545b; }
  #char-count { font-size: 11px; color: #6b7180; margin-top: 4px; text-align: right; }
</style>
</head>
<body>
  <h1>Send Message</h1>
  <div class="nav"><a href="/dashboard">&larr; Back to dashboard</a> <a href="/audit-log" style="margin-left: 16px;">Audit log &rarr;</a> <a href="/logout" style="margin-left: 16px; color: #f2545b;">Log out</a></div>

  <label for="sender-name">Your Name (for the audit log)</label>
  <input id="sender-name" type="text" placeholder="e.g. Jay" style="width: 100%; padding: 10px 12px; background: #171a21; border: 1px solid #262a33; border-radius: 8px; color: #e6e8eb; font-size: 14px;" />

  <label for="channel-select">Channel</label>
  <select id="channel-select">
    <option value="">Loading channels...</option>
  </select>

  <label for="message-text">Message</label>
  <textarea id="message-text" placeholder="Type your message..." maxlength="2000"></textarea>
  <div id="char-count">0 / 2000</div>

  <button id="send-btn">Send</button>
  <div id="status"></div>

  <script>
    const senderNameInput = document.getElementById("sender-name");
    senderNameInput.value = localStorage.getItem("dashboardSenderName") || "";
    senderNameInput.addEventListener("input", () => {
      localStorage.setItem("dashboardSenderName", senderNameInput.value);
    });

    async function loadChannels() {
      const select = document.getElementById("channel-select");
      try {
        const res = await fetch("/api/channels", { credentials: "same-origin" });
        const data = await res.json();
        select.innerHTML = "";
        if (!data.channels || data.channels.length === 0) {
          select.innerHTML = '<option value="">No channels found</option>';
          return;
        }
        for (const ch of data.channels) {
          const opt = document.createElement("option");
          opt.value = ch.id;
          opt.textContent = "#" + ch.name;
          select.appendChild(opt);
        }
      } catch (err) {
        select.innerHTML = '<option value="">Failed to load channels</option>';
      }
    }

    const textarea = document.getElementById("message-text");
    const charCount = document.getElementById("char-count");
    textarea.addEventListener("input", () => {
      charCount.textContent = textarea.value.length + " / 2000";
    });

    document.getElementById("send-btn").addEventListener("click", async () => {
      const channelId = document.getElementById("channel-select").value;
      const message = textarea.value;
      const senderName = senderNameInput.value;
      const statusEl = document.getElementById("status");
      const btn = document.getElementById("send-btn");

      if (!senderName.trim()) {
        statusEl.textContent = "Please enter your name first.";
        statusEl.className = "error";
        return;
      }

      if (!channelId || !message.trim()) {
        statusEl.textContent = "Pick a channel and write a message first.";
        statusEl.className = "error";
        return;
      }

      btn.disabled = true;
      statusEl.textContent = "Sending...";
      statusEl.className = "";

      try {
        const res = await fetch("/api/send-message", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channelId, message, senderName }),
        });
        const data = await res.json();

        if (res.ok && data.success) {
          statusEl.textContent = "Message sent!";
          statusEl.className = "success";
          textarea.value = "";
          charCount.textContent = "0 / 2000";
        } else {
          statusEl.textContent = data.error || "Failed to send message.";
          statusEl.className = "error";
        }
      } catch (err) {
        statusEl.textContent = "Failed to send message.";
        statusEl.className = "error";
      } finally {
        btn.disabled = false;
      }
    });

    loadChannels();
  </script>
</body>
</html>
`;

function buildLoginHtml({ error, next }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sign in - Verification Dashboard</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: radial-gradient(circle at top, #171a21 0%, #0f1115 60%);
    color: #e6e8eb;
    padding: 24px;
  }
  .card {
    width: 100%;
    max-width: 360px;
    background: #171a21;
    border: 1px solid #262a33;
    border-radius: 14px;
    padding: 32px 28px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.4);
  }
  .card h1 {
    font-size: 18px;
    margin: 0 0 4px;
    color: #fff;
    text-align: center;
  }
  .card p.subtitle {
    font-size: 13px;
    color: #6b7180;
    text-align: center;
    margin: 0 0 24px;
  }
  label {
    display: block;
    font-size: 11px;
    color: #9aa0aa;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 6px;
  }
  input[type="text"], input[type="password"] {
    width: 100%;
    padding: 11px 12px;
    margin-bottom: 18px;
    background: #0f1115;
    border: 1px solid #262a33;
    border-radius: 8px;
    color: #e6e8eb;
    font-size: 14px;
  }
  input[type="text"]:focus, input[type="password"]:focus {
    outline: none;
    border-color: #8fa2ff;
  }
  button {
    width: 100%;
    padding: 12px;
    background: #3ecf8e;
    color: #0f1115;
    border: none;
    border-radius: 8px;
    font-weight: 700;
    font-size: 14px;
    cursor: pointer;
  }
  button:hover { background: #34b87d; }
  .error {
    background: rgba(242,84,91,0.12);
    color: #f2545b;
    font-size: 13px;
    padding: 10px 12px;
    border-radius: 8px;
    margin-bottom: 18px;
    text-align: center;
  }
</style>
</head>
<body>
  <div class="card">
    <h1>🔐 Verification Dashboard</h1>
    <p class="subtitle">Sign in with your staff credentials</p>
    ${error ? '<div class="error">Invalid username or password.</div>' : ""}
    <form method="POST" action="/login">
      <input type="hidden" name="next" value="${next}">
      <label for="username">Username</label>
      <input type="text" id="username" name="username" autocomplete="username" required autofocus>
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required>
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>
`;
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Verification Dashboard</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.4/chart.umd.min.js"></script>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0f1115;
    color: #e6e8eb;
    padding: 24px;
  }
  h1 { font-size: 20px; margin: 0 0 20px; color: #fff; }
  .stats {
    display: flex;
    gap: 16px;
    margin-bottom: 20px;
    flex-wrap: wrap;
  }
  .stat-card {
    background: #171a21;
    border: 1px solid #262a33;
    border-radius: 10px;
    padding: 16px 20px;
    min-width: 130px;
  }
  .stat-card .label { font-size: 11px; color: #9aa0aa; text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-card .value { font-size: 26px; font-weight: 700; margin-top: 4px; }
  .stat-card.success .value { color: #3ecf8e; }
  .stat-card.fail .value { color: #f2545b; }
  .stat-card.pending .value { color: #f2c14e; }
  .stat-card.rate .value { color: #8fa2ff; }
  .panels {
    display: grid;
    grid-template-columns: 2fr 1fr 1fr;
    gap: 16px;
    margin-bottom: 20px;
  }
  @media (max-width: 800px) {
    .panels { grid-template-columns: 1fr; }
  }
  .panel {
    background: #171a21;
    border: 1px solid #262a33;
    border-radius: 10px;
    padding: 16px 20px;
  }
  .panel h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: #9aa0aa; margin: 0 0 12px; }
  .breakdown-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #21242c; font-size: 13px; }
  .breakdown-row:last-child { border-bottom: none; }
  #search {
    width: 100%;
    padding: 8px 12px;
    margin-bottom: 12px;
    background: #0f1115;
    border: 1px solid #262a33;
    border-radius: 8px;
    color: #e6e8eb;
    font-size: 13px;
  }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #21242c; }
  th { color: #9aa0aa; font-weight: 500; text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; }
  tr:hover { background: #1c1f27; }
  .badge { padding: 2px 8px; border-radius: 6px; font-size: 12px; font-weight: 600; }
  .badge.succeeded { background: rgba(62,207,142,0.15); color: #3ecf8e; }
  .badge.failed { background: rgba(242,84,91,0.15); color: #f2545b; }
  .badge.started { background: rgba(242,193,78,0.15); color: #f2c14e; }
  .badge.info { background: rgba(120,140,255,0.15); color: #8fa2ff; }
  .muted { color: #6b7180; }
  #updated { font-size: 12px; color: #6b7180; margin-bottom: 16px; }
  canvas { max-height: 220px; }
</style>
</head>
<body>
  <h1>Verification Dashboard</h1>
  <div style="margin-bottom: 16px; font-size: 13px;"><a href="/compose" style="color: #8fa2ff; text-decoration: none; margin-right: 16px;">Send a message &rarr;</a><a id="nav-audit-log" href="/audit-log" style="color: #8fa2ff; text-decoration: none; margin-right: 16px; display: none;">Audit log &rarr;</a><a id="nav-export-csv" href="/api/export-csv" style="color: #8fa2ff; text-decoration: none; margin-right: 16px; display: none;">Export CSV &darr;</a><a id="nav-backup-logs" href="/api/backup/logs" style="color: #8fa2ff; text-decoration: none; margin-right: 16px; display: none;">Backup logs &darr;</a><a id="nav-backup-identities" href="/api/backup/identities" style="color: #8fa2ff; text-decoration: none; display: none;">Backup ID DB &darr;</a></div>
  <div id="role-label" style="font-size: 12px; color: #6b7180; margin-bottom: 16px;"></div>
  <div style="margin-bottom: 16px;"><a href="/logout" style="color: #f2545b; text-decoration: none; font-size: 12px;">Log out</a></div>
  <div id="updated">Loading...</div>

  <div class="stats">
    <div class="stat-card pending">
      <div class="label">Started</div>
      <div class="value" id="stat-started">-</div>
    </div>
    <div class="stat-card success">
      <div class="label">Succeeded</div>
      <div class="value" id="stat-succeeded">-</div>
    </div>
    <div class="stat-card fail">
      <div class="label">Failed</div>
      <div class="value" id="stat-failed">-</div>
    </div>
    <div class="stat-card rate">
      <div class="label">Success Rate</div>
      <div class="value" id="stat-rate">-</div>
    </div>
    <div class="stat-card pending">
      <div class="label">Pending Now</div>
      <div class="value" id="stat-pending-now">-</div>
    </div>
    <div class="stat-card fail">
      <div class="label">Never Finished</div>
      <div class="value" id="stat-dropoff">-</div>
    </div>
  </div>
  <div id="pending-note" class="muted" style="font-size: 12px; margin-top: -12px; margin-bottom: 20px;"></div>

  <div class="panels">
    <div class="panel">
      <h2>Verifications (last 14 days)</h2>
      <canvas id="daily-chart"></canvas>
    </div>
    <div class="panel">
      <h2>Failure Reasons</h2>
      <div class="breakdown-row"><span>Under 18</span><span id="breakdown-underage">-</span></div>
      <div class="breakdown-row"><span>OFAC match</span><span id="breakdown-ofac">-</span></div>
      <div class="breakdown-row"><span>Other</span><span id="breakdown-other">-</span></div>
    </div>
    <div class="panel">
      <h2>This Week vs Last Week</h2>
      <div class="breakdown-row"><span>Succeeded (this week)</span><span id="week-succeeded-this">-</span></div>
      <div class="breakdown-row"><span>Succeeded (last week)</span><span id="week-succeeded-last">-</span></div>
      <div class="breakdown-row"><span>Failed (this week)</span><span id="week-failed-this">-</span></div>
      <div class="breakdown-row"><span>Failed (last week)</span><span id="week-failed-last">-</span></div>
    </div>
  </div>

  <input id="search" type="text" placeholder="Search by username or Discord ID..." />

  <table>
    <thead>
      <tr><th>Time</th><th>Event</th><th>User</th><th>Details</th></tr>
    </thead>
    <tbody id="feed-body">
      <tr><td colspan="4" class="muted">Loading...</td></tr>
    </tbody>
  </table>

  <script>
    let latestFeed = [];
    let chart = null;

    function badgeClass(type) {
      if (type === "verification.succeeded" || type === "verification.role_assigned") return "succeeded";
      if (type.includes("failed") || type.includes("error")) return "failed";
      if (type === "verification.started") return "started";
      return "info";
    }

    function formatTime(iso) {
      return new Date(iso).toLocaleString();
    }

    function renderFeed(filterText) {
      const tbody = document.getElementById("feed-body");
      tbody.innerHTML = "";

      const term = (filterText || "").trim().toLowerCase();
      const filtered = !term
        ? latestFeed
        : latestFeed.filter((e) => {
            const username = (e.username || "").toLowerCase();
            const id = (e.discordUserId || "").toLowerCase();
            return username.includes(term) || id.includes(term);
          });

      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="muted">No matching events.</td></tr>';
        return;
      }

      for (const entry of filtered) {
        const tr = document.createElement("tr");
        const cls = badgeClass(entry.type);
        const userLabel = entry.discordUserId
          ? '<a href="https://discord.com/users/' + entry.discordUserId + '" target="_blank" style="color: #8fa2ff; text-decoration: none;">' +
            (entry.username ? entry.username + " (" + entry.discordUserId + ")" : entry.discordUserId) +
            "</a>"
          : "-";
        tr.innerHTML =
          "<td>" + formatTime(entry.timestamp) + "</td>" +
          '<td><span class="badge ' + cls + '">' + entry.type + "</span></td>" +
          "<td>" + userLabel + "</td>" +
          '<td class="muted">' + (entry.message || "") + "</td>";
        tbody.appendChild(tr);
      }
    }

    function renderChart(daily) {
      const ctx = document.getElementById("daily-chart").getContext("2d");
      const labels = daily.map((d) => d.date.slice(5));
      const succeededData = daily.map((d) => d.succeeded);
      const failedData = daily.map((d) => d.failed);

      if (chart) {
        chart.data.labels = labels;
        chart.data.datasets[0].data = succeededData;
        chart.data.datasets[1].data = failedData;
        chart.update();
        return;
      }

      chart = new Chart(ctx, {
        type: "bar",
        data: {
          labels,
          datasets: [
            { label: "Succeeded", data: succeededData, backgroundColor: "#3ecf8e" },
            { label: "Failed", data: failedData, backgroundColor: "#f2545b" },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { stacked: true, ticks: { color: "#9aa0aa" }, grid: { color: "#21242c" } },
            y: { stacked: true, beginAtZero: true, ticks: { color: "#9aa0aa" }, grid: { color: "#21242c" } },
          },
          plugins: {
            legend: { labels: { color: "#e6e8eb" } },
          },
        },
      });
    }

    async function refresh() {
      try {
        const res = await fetch("/api/dashboard-data", { credentials: "same-origin" });
        if (!res.ok) return;
        const data = await res.json();

        document.getElementById("stat-started").textContent = data.stats.started;
        document.getElementById("stat-succeeded").textContent = data.stats.succeeded;
        document.getElementById("stat-failed").textContent = data.stats.failed;
        document.getElementById("stat-rate").textContent =
          data.stats.successRate === null ? "-" : data.stats.successRate + "%";

        document.getElementById("stat-pending-now").textContent = data.stats.pendingNow;
        document.getElementById("stat-dropoff").textContent =
          data.stats.droppedOff +
          (data.stats.dropOffRate !== null ? " (" + data.stats.dropOffRate + "%)" : "");

        const pendingNoteEl = document.getElementById("pending-note");
        if (data.stats.pendingNow > 0 && data.stats.oldestPendingMinutes !== null) {
          pendingNoteEl.textContent =
            "Oldest pending session started " + data.stats.oldestPendingMinutes + " min ago.";
        } else {
          pendingNoteEl.textContent = "";
        }

        document.getElementById("breakdown-underage").textContent = data.failureBreakdown.underage;
        document.getElementById("breakdown-ofac").textContent = data.failureBreakdown.ofac;
        document.getElementById("breakdown-other").textContent = data.failureBreakdown.other;

        if (data.weekComparison) {
          document.getElementById("week-succeeded-this").textContent = data.weekComparison.thisWeek.succeeded;
          document.getElementById("week-succeeded-last").textContent = data.weekComparison.lastWeek.succeeded;
          document.getElementById("week-failed-this").textContent = data.weekComparison.thisWeek.failed;
          document.getElementById("week-failed-last").textContent = data.weekComparison.lastWeek.failed;
        }

        latestFeed = data.feed;
        renderFeed(document.getElementById("search").value);
        renderChart(data.daily);

        document.getElementById("updated").textContent =
          "Last updated: " + new Date().toLocaleTimeString();
      } catch (err) {
        console.error("Failed to refresh dashboard", err);
      }
    }

    async function applyRole() {
      try {
        const res = await fetch("/api/whoami", { credentials: "same-origin" });
        if (!res.ok) return;
        const data = await res.json();

        document.getElementById("role-label").textContent =
          "Logged in as " + data.user + " (" + data.role + ")";

        const rank = { moderator: 1, admin: 2, owner: 3 };
        const myRank = rank[data.role] || 0;

        if (myRank >= rank.admin) {
          document.getElementById("nav-audit-log").style.display = "inline";
          document.getElementById("nav-export-csv").style.display = "inline";
        }
        if (myRank >= rank.owner) {
          document.getElementById("nav-backup-logs").style.display = "inline";
          document.getElementById("nav-backup-identities").style.display = "inline";
        }
      } catch (err) {
        console.error("Failed to load role info", err);
      }
    }

    document.getElementById("search").addEventListener("input", (e) => {
      renderFeed(e.target.value);
    });

    applyRole();
    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>
`;
