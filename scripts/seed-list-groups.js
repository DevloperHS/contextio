const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { loadEnv, requireEnv } = require("../bot/env");

function extractGroupId(dialog) {
  if (dialog?.id !== undefined && dialog?.id !== null) return String(dialog.id);
  const entity = dialog?.entity || {};
  return String(entity.id || entity.channelId || entity.chatId || "unknown");
}

function extractGroupTitle(dialog) {
  return dialog?.name || dialog?.title || dialog?.entity?.title || "unknown-group";
}

function getSessionString() {
  const raw = String(process.env.GRAMJS_SESSION || "");
  return raw.replace(/\s+/g, "").trim();
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

async function main() {
  loadEnv();
  requireEnv(["TELEGRAM_API_ID", "TELEGRAM_API_HASH", "GRAMJS_SESSION"]);

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

  try {
    console.log("[seed:list-groups] Connecting Telegram client...");
    await withTimeout(client.connect(), 90000, "connect");
    console.log("[seed:list-groups] Connected. Verifying authorization...");
    const authorized = await withTimeout(client.checkAuthorization(), 15000, "checkAuthorization");
    if (!authorized) {
      throw new Error(
        "GramJS session is not authorized. Re-run `node bot/auth-session.js` and update GRAMJS_SESSION."
      );
    }
    console.log("[seed:list-groups] Session authorization verified.");
    console.log("[seed:list-groups] Fetching dialogs...");

    const dialogs = [];
    let count = 0;
    for await (const dialog of client.iterDialogs({ limit: 200 })) {
      dialogs.push(dialog);
      count += 1;
      if (count % 25 === 0) {
        console.log(`[seed:list-groups] Dialog scan progress: ${count}/200`);
      }
    }

    const groups = dialogs.filter(
      (dialog) => dialog?.isGroup === true || dialog?.entity?.megagroup === true
    );

    console.log(`[seed:list-groups] Found ${groups.length} groups/supergroups`);
    for (const dialog of groups) {
      const title = extractGroupTitle(dialog);
      const id = extractGroupId(dialog);
      console.log(`- ${title} | ${id}`);
    }
  } finally {
    try {
      await client.destroy();
    } catch (_error) {
      // Ignore disconnect errors during reconnect churn.
    }
  }
}

main().catch((error) => {
  console.error("[seed:list-groups] Failed:");
  console.error(error.stack || error.message);
  process.exit(1);
});
