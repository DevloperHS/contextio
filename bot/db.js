const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { loadEnv, requireEnv } = require("./env");

let db;

function resolveDbPath() {
  loadEnv();
  requireEnv(["SQLITE_DB_PATH"]);
  return path.resolve(process.cwd(), process.env.SQLITE_DB_PATH);
}

async function initDB() {
  if (db) return db;

  const dbPath = resolveDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      group_name TEXT NOT NULL,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      is_bot_reply INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_group_id ON messages(group_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  `);

  return db;
}

async function logMessage(groupId, groupName, author, body, isBotReply) {
  const connection = await initDB();

  const stmt = connection.prepare(`
    INSERT INTO messages (group_id, group_name, author, body, is_bot_reply)
    VALUES (?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    String(groupId || "unknown"),
    String(groupName || "unknown"),
    String(author || "unknown"),
    String(body || ""),
    isBotReply ? 1 : 0
  );

  return {
    id: result.lastInsertRowid,
    changes: result.changes,
  };
}

async function getStats() {
  const connection = await initDB();

  const row = connection.prepare(`
    SELECT
      COUNT(*) AS totalMessages,
      COUNT(DISTINCT group_id) AS totalGroups,
      SUM(CASE WHEN is_bot_reply = 1 THEN 1 ELSE 0 END) AS botReplies
    FROM messages
  `).get();

  return {
    totalMessages: Number(row.totalMessages || 0),
    totalGroups: Number(row.totalGroups || 0),
    botReplies: Number(row.botReplies || 0),
  };
}

async function getRecentLogs(limit = 50) {
  const connection = await initDB();
  const safeLimit = Number.isInteger(limit) ? limit : Number.parseInt(limit, 10);
  const finalLimit = Math.max(1, Math.min(Number.isNaN(safeLimit) ? 50 : safeLimit, 500));

  return connection.prepare(`
    SELECT id, group_id, group_name, author, body, is_bot_reply, created_at
    FROM messages
    ORDER BY id DESC
    LIMIT ?
  `).all(finalLimit);
}

module.exports = {
  initDB,
  logMessage,
  getStats,
  getRecentLogs,
};
