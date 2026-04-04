const { loadEnv, requireEnv } = require("../bot/env");
const { initDB, logMessage, getStats, getRecentLogs } = require("../bot/db");
const { saveMessage, recallContext } = require("../bot/hydra");

async function runDbChecks() {
  await initDB();

  await logMessage("test-group-1", "Test Group", "alice", "hello world", false);
  await logMessage("test-group-1", "Test Group", "BOT", "sample reply", true);

  const stats = await getStats();
  const logs = await getRecentLogs(5);

  console.log("[phase1] SQLite stats:", stats);
  console.log("[phase1] SQLite recent logs count:", logs.length);

  if (stats.totalMessages < 2) {
    throw new Error("SQLite check failed: expected at least 2 messages.");
  }
}

async function runHydraChecks() {
  const runHydraTest = process.env.PHASE1_HYDRA_TEST === "1";
  if (!runHydraTest) {
    console.log("[phase1] Hydra check skipped. Set PHASE1_HYDRA_TEST=1 to enable.");
    return;
  }

  requireEnv(["HYDRA_TENANT_ID"]);
  if (!process.env.HYDRADB_API_KEY && !process.env.HYDRA_DB_API_KEY) {
    throw new Error("Set HYDRADB_API_KEY or HYDRA_DB_API_KEY before PHASE1_HYDRA_TEST=1.");
  }

  const groupId = process.env.PHASE1_GROUP_ID || "phase1-test-group";
  const question = process.env.PHASE1_QUESTION || "What did Alice say?";

  await saveMessage(groupId, "alice", "I will post the sprint summary tomorrow.");
  const context = await recallContext(groupId, question);

  console.log("[phase1] Hydra context length:", context.length);
  if (!context) {
    console.log("[phase1] Hydra returned empty context. This may happen on a fresh tenant.");
  }
}

async function main() {
  loadEnv();
  requireEnv(["SQLITE_DB_PATH"]);

  await runDbChecks();
  await runHydraChecks();

  console.log("[phase1] Checks completed.");
}

main().catch((error) => {
  console.error("[phase1] Failed:");
  console.error(error.message);
  process.exit(1);
});
