import fs from "node:fs";

import { DASHBOARD_PASSWORD } from "./config.mjs";
import { LOG_FILE_PATH } from "./logger.mjs";
import { getDiscordClient } from "./discordBot.mjs";

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
  "verification.role_assigned",
  "verification.dm_failed",
  "verification.failure_dm_failed",
  "verification.log_channel_error",
  "discord.ready",
  "discord.commands_registered",
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
  app.get("/api/dashboard-data", requireDashboardAuth, async (_req, res) => {
    const entries = readLogEntries(1000);

    const succeededEntries = entries.filter(
      (e) => e.type === "verification.succeeded",
    );
    const failedEntries = entries.filter((e) => e.type === "verification.failed");
    const started = entries.filter(
      (e) => e.type === "verification.started",
    ).length;

    const succeeded = succeededEntries.length;
    const failed = failedEntries.length;
    const successRate =
      succeeded + failed > 0
        ? Math.round((succeeded / (succeeded + failed)) * 1000) / 10
        : null;

    let underage = 0;
    let ofac = 0;
    let otherFailure = 0;
    for (const e of failedEntries) {
      if (e.isMinimumAgeValid === false) underage += 1;
      else if (e.isOfacValid === true) ofac += 1;
      else otherFailure += 1;
    }

    const daily = buildDailyStats(entries, 14);

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
      stats: { started, succeeded, failed, successRate },
      failureBreakdown: { underage, ofac, other: otherFailure },
      daily,
      feed: enrichedFeed,
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
    grid-template-columns: 2fr 1fr;
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
  </div>

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
        const userLabel = entry.username
          ? entry.username + " (" + entry.discordUserId + ")"
          : (entry.discordUserId || "-");
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

        document.getElementById("breakdown-underage").textContent = data.failureBreakdown.underage;
        document.getElementById("breakdown-ofac").textContent = data.failureBreakdown.ofac;
        document.getElementById("breakdown-other").textContent = data.failureBreakdown.other;

        latestFeed = data.feed;
        renderFeed(document.getElementById("search").value);
        renderChart(data.daily);

        document.getElementById("updated").textContent =
          "Last updated: " + new Date().toLocaleTimeString();
      } catch (err) {
        console.error("Failed to refresh dashboard", err);
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
