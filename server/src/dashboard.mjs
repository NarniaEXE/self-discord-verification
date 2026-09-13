import fs from "node:fs";

import { DASHBOARD_PASSWORD } from "./config.mjs";
import { LOG_FILE_PATH } from "./logger.mjs";

function requireDashboardAuth(req, res, next) {
  if (!DASHBOARD_PASSWORD) {
    return res
      .status(404)
      .send("Dashboard is not configured. Set DASHBOARD_PASSWORD to enable it.");
  }

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="Verification Dashboard"');
    return res.status(401).send("Authentication required.");
  }

  const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
  const separatorIndex = decoded.indexOf(":");
  const password = separatorIndex === -1 ? "" : decoded.slice(separatorIndex + 1);

  if (password !== DASHBOARD_PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="Verification Dashboard"');
    return res.status(401).send("Invalid credentials.");
  }

  next();
}

function readLogEntries(limit = 500) {
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
  "verification.role_assigned",
  "verification.dm_failed",
  "verification.failure_dm_failed",
  "verification.log_channel_error",
  "discord.ready",
  "discord.commands_registered",
]);

export function registerDashboardRoutes(app) {
  app.get("/api/dashboard-data", requireDashboardAuth, (_req, res) => {
    const entries = readLogEntries(500);

    const succeeded = entries.filter(
      (e) => e.type === "verification.succeeded",
    ).length;
    const failed = entries.filter((e) => e.type === "verification.failed").length;
    const started = entries.filter(
      (e) => e.type === "verification.started",
    ).length;

    const feed = entries
      .filter((e) => RELEVANT_EVENT_TYPES.has(e.type))
      .slice(-100)
      .reverse();

    res.json({
      stats: { started, succeeded, failed },
      feed,
    });
  });

  app.get("/dashboard", requireDashboardAuth, (_req, res) => {
    res.set("Content-Type", "text/html").send(DASHBOARD_HTML);
  });
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Verification Dashboard</title>
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
    margin-bottom: 24px;
    flex-wrap: wrap;
  }
  .stat-card {
    background: #171a21;
    border: 1px solid #262a33;
    border-radius: 10px;
    padding: 16px 20px;
    min-width: 140px;
  }
  .stat-card .label { font-size: 12px; color: #9aa0aa; text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-card .value { font-size: 28px; font-weight: 700; margin-top: 4px; }
  .stat-card.success .value { color: #3ecf8e; }
  .stat-card.fail .value { color: #f2545b; }
  .stat-card.pending .value { color: #f2c14e; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #21242c; }
  th { color: #9aa0aa; font-weight: 500; text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; }
  tr:hover { background: #171a21; }
  .badge { padding: 2px 8px; border-radius: 6px; font-size: 12px; font-weight: 600; }
  .badge.succeeded { background: rgba(62,207,142,0.15); color: #3ecf8e; }
  .badge.failed { background: rgba(242,84,91,0.15); color: #f2545b; }
  .badge.started { background: rgba(242,193,78,0.15); color: #f2c14e; }
  .badge.info { background: rgba(120,140,255,0.15); color: #8fa2ff; }
  .muted { color: #6b7180; }
  #updated { font-size: 12px; color: #6b7180; margin-bottom: 16px; }
</style>
</head>
<body>
  <h1>Verification Dashboard</h1>
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
  </div>
  <table>
    <thead>
      <tr><th>Time</th><th>Event</th><th>Discord User ID</th><th>Details</th></tr>
    </thead>
    <tbody id="feed-body">
      <tr><td colspan="4" class="muted">Loading...</td></tr>
    </tbody>
  </table>

  <script>
    function badgeClass(type) {
      if (type === "verification.succeeded" || type === "verification.role_assigned") return "succeeded";
      if (type.includes("failed") || type.includes("error")) return "failed";
      if (type === "verification.started") return "started";
      return "info";
    }

    function formatTime(iso) {
      const d = new Date(iso);
      return d.toLocaleString();
    }

    async function refresh() {
      try {
        const res = await fetch("/api/dashboard-data", { credentials: "same-origin" });
        if (!res.ok) return;
        const data = await res.json();

        document.getElementById("stat-started").textContent = data.stats.started;
        document.getElementById("stat-succeeded").textContent = data.stats.succeeded;
        document.getElementById("stat-failed").textContent = data.stats.failed;

        const tbody = document.getElementById("feed-body");
        tbody.innerHTML = "";

        if (data.feed.length === 0) {
          tbody.innerHTML = '<tr><td colspan="4" class="muted">No events yet.</td></tr>';
        }

        for (const entry of data.feed) {
          const tr = document.createElement("tr");
          const cls = badgeClass(entry.type);
          tr.innerHTML =
            '<td>' + formatTime(entry.timestamp) + '</td>' +
            '<td><span class="badge ' + cls + '">' + entry.type + '</span></td>' +
            '<td>' + (entry.discordUserId || '-') + '</td>' +
            '<td class="muted">' + (entry.message || '') + '</td>';
          tbody.appendChild(tr);
        }

        document.getElementById("updated").textContent =
          "Last updated: " + new Date().toLocaleTimeString();
      } catch (err) {
        console.error("Failed to refresh dashboard", err);
      }
    }

    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>
`;
