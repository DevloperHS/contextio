const fs = require("fs");
const path = require("path");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { loadEnv, requireEnv } = require("./env");
const { initDB, logMessage } = require("./db");
const { saveMessage, extractSourceIdsFromAddMemory, waitForProcessingReady } = require("./hydra");
const { buildCapabilitiesSeedText, buildCapabilitiesSourceId } = require("./capabilities");

const SEEDED_FLAG_PATH = path.resolve(process.cwd(), ".seeded");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DIALOG_LIMIT = 200;

function isDryRun() {
  return String(process.env.SEED_DRY_RUN || "0") === "1";
}

function shouldForceSeed() {
  return String(process.env.SEED_FORCE || "0") === "1";
}

function hasSeededFlag() {
  return fs.existsSync(SEEDED_FLAG_PATH);
}

function parseMessageLimit() {
  const raw = process.env.SEED_MESSAGE_LIMIT;
  if (!raw) return 5000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed < 1 ? 5000 : parsed;
}

function parseTargetGroupId() {
  const raw = process.env.SEED_TARGET_GROUP_ID;
  if (!raw) return "";
  return String(raw).trim();
}

function parseTargetGroupName() {
  const raw = process.env.SEED_TARGET_GROUP_NAME;
  if (!raw) return "";
  return String(raw).trim().toLowerCase();
}

function getSessionString() {
  const raw = String(process.env.GRAMJS_SESSION || "");
  return raw.replace(/\s+/g, "").trim();
}

function extractMessageText(message) {
  if (!message) return "";
  const candidate = message.message || message.text || "";
  return String(candidate).trim();
}

function extractSenderName(message) {
  if (!message) return "unknown";

  if (typeof message.postAuthor === "string" && message.postAuthor.trim()) {
    return message.postAuthor.trim();
  }

  const sender = message.sender;
  if (sender && typeof sender === "object") {
    if (typeof sender.username === "string" && sender.username.trim()) return sender.username;
    const fullName = [sender.firstName, sender.lastName].filter(Boolean).join(" ").trim();
    if (fullName) return fullName;
  }

  const senderId = message.senderId;
  if (senderId && typeof senderId === "object") {
    const userId = senderId.userId || senderId.channelId || senderId.chatId;
    if (userId !== undefined && userId !== null) return String(userId);
  }

  return "unknown";
}

function extractGroupId(dialog) {
  if (dialog?.id !== undefined && dialog?.id !== null) {
    return String(dialog.id);
  }

  const entity = dialog?.entity || {};
  return String(entity.id || entity.channelId || entity.chatId || "unknown");
}

function extractGroupTitle(dialog) {
  return (
    dialog?.name ||
    dialog?.title ||
    dialog?.entity?.title ||
    "unknown-group"
  );
}

async function fetchDialogs(client, limit = DIALOG_LIMIT) {
  const dialogs = [];
  let count = 0;

  for await (const dialog of client.iterDialogs({ limit })) {
    dialogs.push(dialog);
    count += 1;
    if (count % 25 === 0) {
      console.log(`[seed] Dialog scan progress: ${count}/${limit}`);
    }
  }

  return dialogs;
}

async function withTimeout(promise, ms, stepName) {
  let timeoutId;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`${stepName} timed out after ${ms}ms`));
      }, ms);
    });
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function connectAndAuthorize(client) {
  console.log("[seed] Connecting Telegram client...");
  await withTimeout(client.connect(), 90000, "connect");
  console.log("[seed] Connected. Verifying session authorization...");
  const authorized = await withTimeout(client.checkAuthorization(), 15000, "checkAuthorization");
  if (!authorized) {
    throw new Error(
      "GramJS session is not authorized. Re-run `node bot/auth-session.js` and update GRAMJS_SESSION."
    );
  }
  console.log("[seed] Session authorization verified.");
}

async function seedHistory() {
  loadEnv();
  requireEnv(["TELEGRAM_API_ID", "TELEGRAM_API_HASH", "GRAMJS_SESSION"]);

  const dryRun = isDryRun();
  const forcedSeed = shouldForceSeed();
  const messageLimit = parseMessageLimit();
  const targetGroupId = parseTargetGroupId();
  const targetGroupName = parseTargetGroupName();

  if (hasSeededFlag() && !forcedSeed) {
    console.log(`[seed] .seeded exists at ${SEEDED_FLAG_PATH}. Skipping seeding.`);
    console.log("[seed] Set SEED_FORCE=1 to run seeding again.");
    return;
  }

  if (!dryRun) {
    // Ensures SQLite path is valid before processing any messages.
    await initDB();
  }

  const apiId = Number.parseInt(process.env.TELEGRAM_API_ID, 10);
  const apiHash = process.env.TELEGRAM_API_HASH;
  const cleanSession = getSessionString();
  if (!cleanSession) {
    throw new Error("GRAMJS_SESSION is empty after trimming.");
  }
  const session = new StringSession(cleanSession);
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  const summary = {
    groups: 0,
    scannedMessages: 0,
    savedMessages: 0,
    skippedMessages: 0,
  };

  try {
    console.log(`[seed] Starting ${dryRun ? "dry-run " : ""}history seeding.`);
    console.log(`[seed] Message limit per group: ${messageLimit}`);

    await connectAndAuthorize(client);
    console.log("[seed] Fetching dialogs...");
    const dialogs = await withTimeout(fetchDialogs(client, DIALOG_LIMIT), 60000, "fetchDialogs");
    console.log(`[seed] Dialog fetch complete: ${dialogs.length} dialogs.`);
    const groupDialogs = dialogs
      .filter((dialog) => dialog?.isGroup === true || dialog?.entity?.megagroup === true)
      .filter((dialog) => {
        const groupId = extractGroupId(dialog);
        const groupTitle = extractGroupTitle(dialog).toLowerCase();

        if (targetGroupId && groupId !== targetGroupId) return false;
        if (targetGroupName && groupTitle !== targetGroupName) return false;
        return true;
      });

    summary.groups = groupDialogs.length;
    if (targetGroupId || targetGroupName) {
      console.log(
        `[seed] Filter active. target_id="${targetGroupId || "-"}", target_name="${targetGroupName || "-"}"`
      );
    }
    console.log(`[seed] Found ${summary.groups} matching groups/supergroups.`);

    if (summary.groups === 0) {
      console.log("[seed] No matching groups found. Nothing to seed.");
      return;
    }

    for (const dialog of groupDialogs) {
      const groupId = extractGroupId(dialog);
      const groupTitle = extractGroupTitle(dialog);
      let count = 0;
      const ingestedSourceIds = [];

      console.log(`[seed] Seeding group "${groupTitle}" (${groupId})`);
      if (!dryRun) {
        const capabilitySeedResult = await saveMessage(
          groupId,
          "SYSTEM",
          buildCapabilitiesSeedText(groupTitle),
          {
            sourceId: buildCapabilitiesSourceId(groupId),
            title: `Bot Capabilities - ${groupTitle}`,
            seeded: true,
          }
        );
        const capabilitySourceIds = extractSourceIdsFromAddMemory(capabilitySeedResult);
        if (capabilitySourceIds.length > 0) {
          ingestedSourceIds.push(...capabilitySourceIds);
        }
      }

      for await (const message of client.iterMessages(dialog.entity, { limit: messageLimit })) {
        count += 1;
        summary.scannedMessages += 1;

        const text = extractMessageText(message);
        if (!text) {
          summary.skippedMessages += 1;
          continue;
        }

        const senderName = extractSenderName(message);

        if (!dryRun) {
          const addResult = await saveMessage(groupId, senderName, text);
          const sourceIds = extractSourceIdsFromAddMemory(addResult);
          if (sourceIds.length > 0) {
            ingestedSourceIds.push(...sourceIds);
          }
          await logMessage(groupId, groupTitle, senderName, text, false);
        }

        summary.savedMessages += 1;

        if (count % 100 === 0) {
          console.log(`[seed] "${groupTitle}": msg ${count}`);
        }

        if (count % 1000 === 0) {
          await sleep(1000);
        }
      }

      console.log(`[seed] Completed "${groupTitle}" total scanned: ${count}`);

      if (!dryRun) {
        console.log(
          `[seed] Verifying Hydra processing for "${groupTitle}" with ${ingestedSourceIds.length} source IDs...`
        );
        const verifyResult = await waitForProcessingReady(groupId, ingestedSourceIds);
        console.log(
          `[seed] Hydra verify complete for "${groupTitle}": verified=${verifyResult.verified}, ready=${verifyResult.ready}/${verifyResult.total}, failed=${verifyResult.failed.length}`
        );
      }
    }

    if (!dryRun) {
      fs.writeFileSync(SEEDED_FLAG_PATH, new Date().toISOString(), "utf-8");
      console.log(`[seed] Wrote seeded flag: ${SEEDED_FLAG_PATH}`);
    } else {
      console.log("[seed] Dry-run mode enabled. .seeded flag not written.");
    }

    console.log(
      `[seed] Done. groups=${summary.groups}, scanned=${summary.scannedMessages}, saved=${summary.savedMessages}, skipped=${summary.skippedMessages}`
    );
  } finally {
    try {
      await client.destroy();
    } catch (_error) {
      // Ignore disconnect errors during reconnect churn.
    }
  }
}

if (require.main === module) {
  seedHistory().catch((error) => {
    console.error("[seed] Failed to start:");
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = { seedHistory, sleep };
