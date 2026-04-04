const fs = require("fs");
const path = require("path");
const http = require("http");
const Database = require("better-sqlite3");
require("dotenv").config();

const port = Number(process.env.PORT || 3000);
const startedAt = Date.now();

function resolveDbPath() {
  const dbPath = process.env.SQLITE_DB_PATH || "./data/bot.db";
  return path.resolve(process.cwd(), dbPath);
}

function withDb(run) {
  const dbPath = resolveDbPath();
  if (!fs.existsSync(dbPath)) {
    return run(null, `Database not found at ${dbPath}. Start bot once to initialize it.`);
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    return run(db, null);
  } finally {
    db.close();
  }
}

function getStats() {
  return withDb((db, missingError) => {
    if (!db) {
      return {
        totalMessages: 0,
        totalGroups: 0,
        botReplies: 0,
        uptime: process.uptime(),
        error: missingError,
      };
    }

    const row = db.prepare(`
      SELECT
        COUNT(*) AS totalMessages,
        COUNT(DISTINCT group_id) AS totalGroups,
        SUM(CASE WHEN is_bot_reply = 1 THEN 1 ELSE 0 END) AS botReplies
      FROM messages
    `).get();

    return {
      totalMessages: Number(row?.totalMessages || 0),
      totalGroups: Number(row?.totalGroups || 0),
      botReplies: Number(row?.botReplies || 0),
      uptime: process.uptime(),
      error: null,
    };
  });
}

function getGroups() {
  return withDb((db, missingError) => {
    if (!db) {
      return {
        groups: [],
        error: missingError,
      };
    }

    const rows = db.prepare(`
      SELECT
        group_id,
        group_name,
        COUNT(*) AS message_count,
        MAX(created_at) AS latest_at
      FROM messages
      GROUP BY group_id, group_name
      ORDER BY latest_at DESC
    `).all();

    return {
      groups: rows.map((row) => ({
        group_id: String(row.group_id),
        group_name: String(row.group_name || "unknown"),
        message_count: Number(row.message_count || 0),
        latest_at: row.latest_at || null,
      })),
      error: null,
    };
  });
}

function getLogs(limit = 50, groupId = "") {
  return withDb((db, missingError) => {
    if (!db) {
      return {
        logs: [],
        error: missingError,
      };
    }

    const hasGroupFilter = String(groupId || "").trim().length > 0;
    const rows = hasGroupFilter
      ? db.prepare(`
          SELECT id, group_id, group_name, author, body, is_bot_reply, created_at
          FROM messages
          WHERE group_id = ?
          ORDER BY id DESC
          LIMIT ?
        `).all(String(groupId), limit)
      : db.prepare(`
          SELECT id, group_id, group_name, author, body, is_bot_reply, created_at
          FROM messages
          ORDER BY id DESC
          LIMIT ?
        `).all(limit);

    return {
      logs: rows,
      error: null,
    };
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderDashboardPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Telegram Bot Dashboard</title>
    <style>
      :root {
        --bg: #0b1220;
        --panel: #111a2b;
        --panel-alt: #0e1627;
        --line: #24324a;
        --text: #e8edf7;
        --muted: #9bb0cf;
        --accent: #229ed9;
        --accent-soft: #194966;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Segoe UI", "Inter", system-ui, sans-serif;
        background: radial-gradient(1200px 500px at 15% -20%, #1f3c6b 0%, var(--bg) 60%);
        color: var(--text);
      }
      .wrap {
        max-width: 1120px;
        margin: 0 auto;
        padding: 24px 16px 28px;
      }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 18px;
      }
      .title {
        margin: 0;
        font-size: 1.5rem;
        font-weight: 700;
      }
      .muted {
        color: var(--muted);
        font-size: 0.92rem;
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
        margin-bottom: 18px;
      }
      .card {
        background: linear-gradient(180deg, rgba(34,158,217,0.12), rgba(34,158,217,0.02));
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 14px 14px 12px;
      }
      .card h3 {
        margin: 0 0 8px;
        font-size: 0.86rem;
        font-weight: 600;
        color: var(--muted);
        letter-spacing: 0.2px;
      }
      .value {
        font-size: 1.45rem;
        font-weight: 700;
        color: var(--text);
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 12px;
        overflow: hidden;
      }
      .panel-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 14px;
        border-bottom: 1px solid var(--line);
        background: var(--panel-alt);
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        text-align: left;
        vertical-align: top;
        padding: 10px 12px;
        border-bottom: 1px solid var(--line);
        font-size: 0.9rem;
      }
      th {
        color: var(--muted);
        font-weight: 600;
      }
      td.message {
        min-width: 320px;
        max-width: 520px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .pill {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 0.78rem;
        font-weight: 600;
        background: var(--accent-soft);
        color: #bfe9ff;
      }
      .error {
        margin-top: 12px;
        padding: 10px 12px;
        border: 1px solid #5f2f2f;
        background: #2a1212;
        color: #f7c6c6;
        border-radius: 8px;
        font-size: 0.9rem;
      }
      .tabs {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 12px;
        border-bottom: 1px solid var(--line);
        background: rgba(34,158,217,0.06);
      }
      .tabs-left {
        display: flex;
        flex-wrap: nowrap;
        gap: 8px;
        overflow-x: auto;
        min-width: 0;
      }
      .tabs-right {
        flex: 0 0 300px;
        display: flex;
        justify-content: flex-end;
      }
      .search-input {
        width: 100%;
        max-width: 300px;
        border: 1px solid var(--line);
        background: #0f1a2d;
        color: var(--text);
        border-radius: 8px;
        padding: 7px 10px;
        font-size: 0.85rem;
        outline: none;
      }
      .search-input::placeholder {
        color: var(--muted);
      }
      .tab-btn {
        border: 1px solid var(--line);
        background: #162136;
        color: var(--text);
        border-radius: 999px;
        padding: 6px 10px;
        font-size: 0.82rem;
        white-space: nowrap;
        cursor: pointer;
      }
      .tab-btn.active {
        border-color: var(--accent);
        background: rgba(34,158,217,0.2);
        color: #d9f2ff;
      }
      .tab-btn .count {
        color: var(--muted);
        margin-left: 4px;
      }
      .tabs-label {
        color: var(--muted);
        font-size: 0.8rem;
        margin-right: 8px;
      }
      @media (max-width: 920px) {
        .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      @media (max-width: 600px) {
        .stats { grid-template-columns: 1fr; }
        .tabs {
          flex-direction: column;
          align-items: stretch;
        }
        .tabs-right {
          flex: 1 1 auto;
        }
        .search-input {
          max-width: 100%;
        }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="header">
        <h1 class="title">Telegram Bot Dashboard</h1>
        <div class="muted" id="last-updated">Loading...</div>
      </div>

      <section class="stats">
        <article class="card"><h3>Total Messages</h3><div class="value" id="totalMessages">-</div></article>
        <article class="card"><h3>Groups</h3><div class="value" id="totalGroups">-</div></article>
        <article class="card"><h3>Bot Replies</h3><div class="value" id="botReplies">-</div></article>
        <article class="card"><h3>Uptime</h3><div class="value" id="uptime">-</div></article>
      </section>

      <section class="panel">
        <div class="panel-head">
          <strong id="logsTitle">Recent Message Logs (All Groups)</strong>
          <span class="muted">Auto-refresh every 10s</span>
        </div>
        <div id="groupTabs" class="tabs"></div>
        <div style="overflow:auto;">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Group</th>
                <th>Author</th>
                <th>Message</th>
                <th>Bot Reply?</th>
              </tr>
            </thead>
            <tbody id="logsBody"></tbody>
          </table>
        </div>
      </section>
      <div id="errorBox" class="error" style="display:none;"></div>
    </div>

    <script>
      let activeGroupId = "";
      let logSearchTerm = "";
      let latestRows = [];

      function fmtUptime(seconds) {
        const s = Math.max(0, Math.floor(seconds || 0));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        return \`\${h}h \${m}m \${sec}s\`;
      }

      async function fetchJson(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(\`Request failed: \${url}\`);
        return res.json();
      }

      function setError(message) {
        const box = document.getElementById("errorBox");
        if (!message) {
          box.style.display = "none";
          box.textContent = "";
          return;
        }
        box.style.display = "block";
        box.textContent = message;
      }

      function filterRows(rows) {
        const term = logSearchTerm.trim().toLowerCase();
        if (!term) return rows;
        return rows.filter((row) => {
          const blob = [
            row.group_name,
            row.author,
            row.body,
            row.created_at,
          ]
            .map((v) => String(v || "").toLowerCase())
            .join(" ");
          return blob.includes(term);
        });
      }

      function renderLogs(rows) {
        const filteredRows = filterRows(rows || []);
        const body = document.getElementById("logsBody");
        body.innerHTML = filteredRows.map((row) => {
          const time = row.created_at ? new Date(row.created_at).toLocaleString() : "-";
          const botReply = Number(row.is_bot_reply) === 1 ? '<span class="pill">Yes</span>' : "No";
          return \`
            <tr>
              <td>\${time}</td>
              <td>\${row.group_name ?? "-"}</td>
              <td>\${row.author ?? "-"}</td>
              <td class="message">\${row.body ?? ""}</td>
              <td>\${botReply}</td>
            </tr>
          \`;
        }).join("");
      }

      function escapeAttr(value) {
        return String(value || "")
          .replace(/&/g, "&amp;")
          .replace(/"/g, "&quot;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      }

      function renderTabs(groups) {
        const container = document.getElementById("groupTabs");
        const safeGroups = Array.isArray(groups) ? groups : [];
        const hasActive = safeGroups.some((g) => g.group_id === activeGroupId);
        if (!hasActive) activeGroupId = "";

        const items = [
          { group_id: "", group_name: "All Groups", message_count: null },
          ...safeGroups,
        ];

        const tabsHtml = items.map((item) => {
          const active = item.group_id === activeGroupId;
          const count = item.message_count === null ? "" : '<span class="count">(' + item.message_count + ')</span>';
          return '<button class="tab-btn ' + (active ? "active" : "") + '" data-group-id="' + item.group_id + '">' +
            item.group_name + count +
          "</button>";
        }).join("");

        container.innerHTML =
          '<div class="tabs-left">' + tabsHtml + "</div>" +
          '<div class="tabs-right">' +
          '<span class="tabs-label">Search</span>' +
          '<input id="logsSearch" class="search-input" type="search" placeholder="author / message / group" value="' + escapeAttr(logSearchTerm) + '" />' +
          "</div>";

        container.querySelectorAll(".tab-btn").forEach((btn) => {
          btn.addEventListener("click", () => {
            activeGroupId = btn.getAttribute("data-group-id") || "";
            refresh();
          });
        });

        const input = document.getElementById("logsSearch");
        if (input) {
          input.addEventListener("input", () => {
            logSearchTerm = input.value || "";
            renderLogs(latestRows);
          });
        }
      }

      function updateLogsTitle(groups) {
        const title = document.getElementById("logsTitle");
        if (!activeGroupId) {
          title.textContent = "Recent Message Logs (All Groups)";
          return;
        }
        const match = (groups || []).find((g) => g.group_id === activeGroupId);
        const name = match ? match.group_name : activeGroupId;
        title.textContent = "Recent Message Logs (" + name + ")";
      }

      async function refresh() {
        try {
          const [stats, groupsPayload] = await Promise.all([
            fetchJson("/api/stats"),
            fetchJson("/api/groups"),
          ]);
          renderTabs(groupsPayload.groups || []);
          updateLogsTitle(groupsPayload.groups || []);

          const logsUrl = activeGroupId
            ? "/api/logs?group_id=" + encodeURIComponent(activeGroupId)
            : "/api/logs";
          const logsPayload = await fetchJson(logsUrl);

          document.getElementById("totalMessages").textContent = stats.totalMessages ?? 0;
          document.getElementById("totalGroups").textContent = stats.totalGroups ?? 0;
          document.getElementById("botReplies").textContent = stats.botReplies ?? 0;
          document.getElementById("uptime").textContent = fmtUptime(stats.uptime);
          document.getElementById("last-updated").textContent = "Last updated: " + new Date().toLocaleTimeString();

          latestRows = Array.isArray(logsPayload.logs) ? logsPayload.logs : [];
          renderLogs(latestRows);

          const errors = [stats.error, groupsPayload.error, logsPayload.error].filter(Boolean).join(" | ");
          setError(errors);
        } catch (error) {
          setError(error.message || "Failed to load dashboard data.");
        }
      }

      refresh();
      const timer = setInterval(refresh, 10000);
      window.addEventListener("beforeunload", () => clearInterval(timer));
    </script>
  </body>
</html>`;
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/stats") {
    return writeJson(res, 200, getStats());
  }

  if (req.method === "GET" && url.pathname === "/api/logs") {
    const groupId = url.searchParams.get("group_id") || "";
    return writeJson(res, 200, getLogs(50, groupId));
  }

  if (req.method === "GET" && url.pathname === "/api/groups") {
    return writeJson(res, 200, getGroups());
  }

  if (req.method === "GET" && url.pathname === "/healthz") {
    return writeJson(res, 200, {
      status: "ok",
      uptime: Math.floor((Date.now() - startedAt) / 1000),
    });
  }

  if (req.method === "GET" && url.pathname === "/") {
    const html = renderDashboardPage();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  writeJson(res, 404, { error: "Not found" });
});

server.listen(port, () => {
  console.log(`[dashboard] Running on http://localhost:${port}`);
});
