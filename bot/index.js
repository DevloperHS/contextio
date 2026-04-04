const { Bot } = require("grammy");
const { loadEnv, requireEnv, requireLLMEnv } = require("./env");
const { initDB, logMessage } = require("./db");
const { saveMessage, recallContext } = require("./hydra");
const { askClaude, LLMApiError } = require("./claude");
const { seedHistory } = require("./seed");
const { buildCapabilitiesReply, isCapabilitiesQuestion } = require("./capabilities");

function isDebugEnabled() {
  return String(process.env.BOT_DEBUG || "0") === "1";
}

function debugLog(message) {
  if (isDebugEnabled()) {
    console.log(`[bot:debug] ${message}`);
  }
}

function isGroupMessage(ctx) {
  const chatType = ctx?.chat?.type;
  return chatType === "group" || chatType === "supergroup";
}

function extractMentions(text, entities) {
  if (!text || !Array.isArray(entities)) return [];

  return entities
    .filter((entity) => entity && entity.type === "mention")
    .map((entity) => {
      const start = entity.offset;
      const end = entity.offset + entity.length;
      return text.slice(start, end).toLowerCase();
    })
    .filter(Boolean);
}

function isBotMentioned(ctx, botUsername) {
  const text = String(ctx?.message?.text || "");
  const entities = ctx?.message?.entities || [];
  const lowered = text.toLowerCase();

  if (botUsername && lowered.includes(`@${botUsername.toLowerCase()}`)) {
    return true;
  }

  if (lowered.includes("@bot")) {
    return true;
  }

  const mentionEntities = extractMentions(text, entities);
  if (botUsername) {
    const expected = `@${botUsername.toLowerCase()}`;
    if (mentionEntities.includes(expected)) {
      return true;
    }
  }

  const textMentions = entities.filter((entity) => entity?.type === "text_mention");
  if (textMentions.some((entity) => entity?.user?.is_bot === true)) {
    return true;
  }

  return false;
}

function extractQuestion(text, botUsername) {
  let question = String(text || "");

  if (botUsername) {
    const usernamePattern = new RegExp(`@${botUsername}`, "gi");
    question = question.replace(usernamePattern, " ");
  }

  question = question.replace(/@bot/gi, " ");
  question = question.replace(/\s+/g, " ").trim();
  return question;
}

function isSlashCommand(text, command, botUsername) {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return false;
  const commandBase = `/${command}`;
  const withBot = botUsername ? `${commandBase}@${String(botUsername).toLowerCase()}` : "";
  return raw === commandBase || raw.startsWith(`${commandBase} `) || (withBot && (raw === withBot || raw.startsWith(`${withBot} `)));
}

async function startBot() {
  loadEnv();
  requireEnv([
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_API_ID",
    "TELEGRAM_API_HASH",
    "GRAMJS_SESSION",
    "HYDRA_TENANT_ID",
    "SQLITE_DB_PATH",
  ]);
  if (!process.env.HYDRADB_API_KEY && !process.env.HYDRA_DB_API_KEY) {
    throw new Error(
      "Missing Hydra API key. Set HYDRADB_API_KEY or HYDRA_DB_API_KEY in .env."
    );
  }
  requireLLMEnv();
  console.log(
    `[bot] Hydra scopes: write=${process.env.HYDRA_WRITE_SCOPE || "group"}, recall=${process.env.HYDRA_RECALL_SCOPE || "group"}, global=${process.env.GLOBAL_SUB_TENANT_ID || "global-knowledge"}`
  );

  await initDB();
  await seedHistory();

  const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
  const me = await bot.api.getMe();
  const botUsername = String(me.username || "").toLowerCase();

  console.log(`[bot] Starting long polling as @${botUsername || "unknown"}`);

  bot.on("message:text", async (ctx) => {
    if (!isGroupMessage(ctx)) return;

    const groupId = String(ctx.chat.id);
    const groupName = ctx.chat.title || "unknown";
    const author = ctx.from?.username || ctx.from?.first_name || "unknown";
    const text = String(ctx.message.text || "");
    debugLog(`incoming group=${groupId} group_name="${groupName}" author=${author} text_len=${text.length}`);

    await saveMessage(groupId, author, text);
    await logMessage(groupId, groupName, author, text, false);
    debugLog(`saved message for group=${groupId}`);

    if (isSlashCommand(text, "help", botUsername) || isSlashCommand(text, "examples", botUsername)) {
      const helpText = buildCapabilitiesReply();
      await ctx.reply(helpText);
      await logMessage(groupId, groupName, "BOT", helpText, true);
      debugLog(`slash_capabilities_reply_sent group=${groupId}`);
      return;
    }

    const mentioned = isBotMentioned(ctx, botUsername);
    debugLog(`mention_detected=${mentioned} bot_username=@${botUsername || "unknown"}`);
    if (!mentioned) return;

    const question = extractQuestion(text, botUsername);
    debugLog(`question="${question}"`);
    if (!question) {
      await ctx.reply("Ask me something after the mention.");
      return;
    }
    if (isCapabilitiesQuestion(question)) {
      const helpText = buildCapabilitiesReply();
      await ctx.reply(helpText);
      await logMessage(groupId, groupName, "BOT", helpText, true);
      debugLog(`capabilities_reply_sent group=${groupId}`);
      return;
    }

    try {
      const context = await recallContext(groupId, question);
      debugLog(`context_len_before_llm=${context.length}`);
      const answer = await askClaude(context, question);
      debugLog(`answer_len=${String(answer || "").length}`);

      await ctx.reply(answer);
      await logMessage(groupId, groupName, "BOT", answer, true);
      debugLog(`reply_sent group=${groupId}`);
    } catch (error) {
      if (error instanceof LLMApiError && error.isRateLimited) {
        const safeMessage =
          error.userMessage || "I am currently rate-limited. Please try again shortly.";
        await ctx.reply(safeMessage);
        await logMessage(groupId, groupName, "BOT", safeMessage, true);
        debugLog(`rate_limit_reply_sent group=${groupId} retry_after_ms=${error.retryAfterMs || 0}`);
        return;
      }
      throw error;
    }
  });

  bot.catch(async (err) => {
    console.error("[bot] Unhandled error:", err.error || err);
    try {
      await err.ctx.reply("Something went wrong, try again.");
    } catch (_replyError) {
      // Ignore reply failures in global error handler.
    }
  });

  await bot.start();
}

if (require.main === module) {
  startBot().catch((error) => {
    console.error("[bot] Startup failed:");
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = { startBot };
