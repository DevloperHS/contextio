const { Bot, session } = require("grammy");
const { loadEnv, requireEnv, requireLLMEnv, resolveLLMProvider } = require("./env");
const { initDB, logMessage } = require("./db");
const {
  saveMessage,
  saveConversationState,
  recallContext,
  recallWithDiagnostics,
} = require("./hydra");
const {
  askClaude,
  askLLMAdvanced,
  classifyIntent,
  rewriteRetrievalQuery,
  rerankAndExtract,
  chooseActionByFunctionCall,
  LLMApiError,
} = require("./claude");
const { seedHistory } = require("./seed");
const { buildCapabilitiesReply, isCapabilitiesQuestion } = require("./capabilities");

function isDebugEnabled() {
  return String(process.env.BOT_DEBUG || "0") === "1";
}

function isAgentPipelineEnabled() {
  return String(process.env.AGENT_PIPELINE_ENABLED || "1") === "1";
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

function parseCommandArg(text, command, botUsername) {
  const escapedCommand = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedUsername = (botUsername || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^/${escapedCommand}(?:@${escapedUsername})?(?:\\s+([\\s\\S]+))?$`,
    "i"
  );
  const match = String(text || "").trim().match(pattern);
  if (!match) return null;
  return String(match[1] || "").trim();
}

function isSlashCommand(text, command, botUsername) {
  return parseCommandArg(text, command, botUsername) !== null;
}

function buildAgentSession() {
  return {
    lastQuestion: "",
    lastAnswer: "",
    lastStructured: {
      issues: [],
      action_items: [],
      entities: [],
      dates: [],
    },
    lastEvidences: [],
    pendingAction: null,
    lastBotReplyMessageId: null,
  };
}

function formatList(title, items) {
  if (!Array.isArray(items) || items.length === 0) {
    return `${title}: none`;
  }
  return [title, ...items.map((item) => `- ${item}`)].join("\n");
}

function formatEvidenceFooter(evidences) {
  const rows = Array.isArray(evidences) ? evidences.slice(0, 5) : [];
  if (rows.length === 0) return "";

  const timestamps = rows
    .map((row) => Date.parse(String(row.timestamp || "")))
    .filter((ts) => !Number.isNaN(ts))
    .sort((a, b) => a - b);

  const timeRange = timestamps.length > 0
    ? ` between ${new Date(timestamps[0]).toISOString()} and ${new Date(timestamps[timestamps.length - 1]).toISOString()}`
    : "";

  const bullets = rows.map((row, idx) => {
    const source = row.source_title || row.source_id || "unknown-source";
    const score = Number(row.score || 0).toFixed(3);
    return `- [${idx + 1}] ${source} (score=${score}, sub_tenant=${row.sub_tenant_id || "n/a"})`;
  });

  return [``, `Evidence (from ${rows.length} retrieved chunks${timeRange}):`, ...bullets].join("\n");
}

function normalizeBotOutput(text) {
  const raw = String(text || "");
  if (!raw.trim()) return "";

  const withoutFences = raw
    .replace(/```(?:\w+)?\n?/g, "")
    .replace(/\n?```/g, "");

  const strippedInline = withoutFences
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1");

  const normalizedLines = strippedInline
    .split("\n")
    .map((line) => line.replace(/^\s*#+\s+/, ""))
    .map((line) => line.replace(/^\s*\*\s+/, "- "))
    .map((line) => line.replace(/^\s*-\s{2,}/, "- "))
    .map((line) => line.replace(/\s{3,}/g, " ").trimEnd());

  return normalizedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function coerceIntent(intentResult) {
  const intent = String(intentResult?.intent || "question").toLowerCase();
  if (intent === "action" || intent === "help") return intent;
  return "question";
}

async function runAgentPipeline(groupId, question, state) {
  const intentResult = await classifyIntent(question);
  const intent = coerceIntent(intentResult);

  if (intent === "help") {
    return {
      type: "help",
      answer: buildCapabilitiesReply(),
      structured: state.lastStructured,
      evidences: [],
      pendingAction: null,
    };
  }

  const rewrite = await rewriteRetrievalQuery(question, state.lastQuestion || "");
  const recall = await recallWithDiagnostics(groupId, question, {
    rewrittenQuery: rewrite.query,
  });

  const extract = await rerankAndExtract(question, recall.chunks);
  const selectedByModel = Array.isArray(extract.selected_indices)
    ? extract.selected_indices
        .map((idx) => recall.chunks[idx])
        .filter(Boolean)
    : [];
  const selectedChunks = selectedByModel.length > 0 ? selectedByModel : recall.chunks.slice(0, 8);

  const selectedContext = selectedChunks.map((item) => item.content).join("\n");
  const evidences = selectedChunks.slice(0, 8).map((chunk, index) => ({
    rank: index + 1,
    source_id: chunk.source_id,
    source_title: chunk.source_title,
    score: chunk.score,
    sub_tenant_id: chunk.sub_tenant_id,
    timestamp: chunk.document_metadata?.timestamp || chunk.source_upload_time || "",
  }));

  let pendingAction = null;
  if (intent === "action") {
    const actionCall = await chooseActionByFunctionCall(question).catch(() => null);
    if (actionCall?.name) {
      pendingAction = {
        name: actionCall.name,
        args: actionCall.args || {},
        requested_at: new Date().toISOString(),
      };
    }
  }

  const answer = await askLLMAdvanced({
    context: selectedContext || recall.context,
    question,
    extraInstructions:
      "Answer concisely and include only facts grounded in the context. If uncertain, state uncertainty.",
  });

  return {
    type: "answer",
    answer,
    rewrite,
    intent: intentResult,
    structured: {
      issues: extract.issues || [],
      action_items: extract.action_items || [],
      entities: extract.entities || [],
      dates: extract.dates || [],
    },
    evidences,
    pendingAction,
  };
}

async function executeAllowedAction(ctx, action, botUserId) {
  if (!action || !action.name) {
    return "No pending action found.";
  }

  if (action.name === "summarize_thread") {
    const summary = String(ctx.session?.lastAnswer || "").trim();
    if (!summary) {
      return "No recent summary is available. Ask me a question first.";
    }
    const reply = await ctx.reply(summary);
    ctx.session.lastBotReplyMessageId = reply?.message_id || null;
    return "Posted thread summary.";
  }

  if (action.name === "pin_summary") {
    const messageId = ctx.session?.lastBotReplyMessageId;
    if (!messageId) {
      return "No bot summary message available to pin yet.";
    }

    try {
      await ctx.api.pinChatMessage(ctx.chat.id, messageId, { disable_notification: true });
      return `Pinned message ${messageId}.`;
    } catch (error) {
      return `Could not pin message ${messageId}. Ensure bot has pin permissions.`;
    }
  }

  if (action.name === "schedule_reminder") {
    const whenText = String(action.args?.when_text || "").trim() || "unspecified time";
    const reminderText = String(action.args?.reminder_text || "").trim() || "follow up";
    return `Reminder request captured: "${reminderText}" at "${whenText}". No scheduler is configured yet, so this is a preview only.`;
  }

  if (action.name === "moderation_action") {
    const operation = String(action.args?.action || "").trim() || "none";
    const target = String(action.args?.target || "").trim() || "unknown";
    const reason = String(action.args?.reason || "").trim() || "no reason provided";
    const isSafe = ["warn", "mute", "ban"].includes(operation.toLowerCase());
    if (!isSafe) {
      return `Rejected moderation action: unsupported operation "${operation}".`;
    }

    if (!botUserId) {
      return "Cannot verify bot permissions for moderation action.";
    }

    return `Moderation action preview: ${operation} ${target} (reason: ${reason}). Execution is intentionally disabled in safe mode.`;
  }

  return `Action "${action.name}" is not in the allowlist.`;
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
  console.log(`[bot] Agent pipeline enabled: ${isAgentPipelineEnabled() ? "yes" : "no"}`);

  await initDB();
  await seedHistory();

  const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
  bot.use(session({
    initial: buildAgentSession,
  }));

  const me = await bot.api.getMe();
  const botUsername = String(me.username || "").toLowerCase();
  const botUserId = me.id;

  console.log(`[bot] Starting long polling as @${botUsername || "unknown"}`);

  bot.on("message:text", async (ctx) => {
    if (!isGroupMessage(ctx)) return;

    const groupId = String(ctx.chat.id);
    const groupName = ctx.chat.title || "unknown";
    const author = ctx.from?.username || ctx.from?.first_name || "unknown";
    const text = String(ctx.message.text || "");
    const replyTo = ctx.message?.reply_to_message?.message_id;

    debugLog(`incoming group=${groupId} group_name="${groupName}" author=${author} text_len=${text.length}`);

    await saveMessage(groupId, author, text, {
      groupName,
      messageId: ctx.message?.message_id,
      replyTo,
      messageType: text.startsWith("/") ? "command" : "chat",
    });
    await logMessage(groupId, groupName, author, text, false);
    debugLog(`saved message for group=${groupId}`);

    if (isSlashCommand(text, "help", botUsername) || isSlashCommand(text, "examples", botUsername)) {
      const helpText = buildCapabilitiesReply();
      const reply = await ctx.reply(helpText);
      ctx.session.lastBotReplyMessageId = reply?.message_id || null;
      await logMessage(groupId, groupName, "BOT", helpText, true);
      debugLog(`slash_capabilities_reply_sent group=${groupId}`);
      return;
    }

    if (isSlashCommand(text, "issues", botUsername)) {
      const message = formatList("Issues", ctx.session?.lastStructured?.issues || []);
      const reply = await ctx.reply(message);
      ctx.session.lastBotReplyMessageId = reply?.message_id || null;
      await logMessage(groupId, groupName, "BOT", message, true);
      return;
    }

    if (isSlashCommand(text, "actions", botUsername)) {
      const message = formatList("Action items", ctx.session?.lastStructured?.action_items || []);
      const reply = await ctx.reply(message);
      ctx.session.lastBotReplyMessageId = reply?.message_id || null;
      await logMessage(groupId, groupName, "BOT", message, true);
      return;
    }

    if (isSlashCommand(text, "status", botUsername)) {
      const pending = ctx.session?.pendingAction?.name || "none";
      const message = [
        `Provider: ${resolveLLMProvider()}`,
        `Pipeline: ${isAgentPipelineEnabled() ? "enabled" : "disabled"}`,
        `Recall scope: ${process.env.HYDRA_RECALL_SCOPE || "group"}`,
        `Write scope: ${process.env.HYDRA_WRITE_SCOPE || "group"}`,
        `Pending action: ${pending}`,
      ].join("\n");
      const reply = await ctx.reply(message);
      ctx.session.lastBotReplyMessageId = reply?.message_id || null;
      await logMessage(groupId, groupName, "BOT", message, true);
      return;
    }

    const followupArg = parseCommandArg(text, "followup", botUsername);
    if (followupArg !== null) {
      if (!followupArg) {
        await ctx.reply("Usage: /followup <question>");
        return;
      }

      const followupQuestion = followupArg;
      try {
        const pipeline = isAgentPipelineEnabled();
        if (!pipeline) {
          const context = await recallContext(groupId, followupQuestion);
          const answer = await askClaude(context, followupQuestion);
          const cleanAnswer = normalizeBotOutput(answer);
          const reply = await ctx.reply(cleanAnswer);
          ctx.session.lastBotReplyMessageId = reply?.message_id || null;
          ctx.session.lastQuestion = followupQuestion;
          ctx.session.lastAnswer = cleanAnswer;
          await logMessage(groupId, groupName, "BOT", cleanAnswer, true);
          return;
        }

        const result = await runAgentPipeline(groupId, followupQuestion, ctx.session);
        let finalText = result.answer;

        if (result.pendingAction) {
          ctx.session.pendingAction = result.pendingAction;
          finalText = `${finalText}\n\nProposed action: ${result.pendingAction.name}. Reply with /confirm yes to execute.`;
        }

        finalText = normalizeBotOutput(finalText + formatEvidenceFooter(result.evidences));

        const reply = await ctx.reply(finalText);
        ctx.session.lastBotReplyMessageId = reply?.message_id || null;
        ctx.session.lastQuestion = followupQuestion;
        ctx.session.lastAnswer = finalText;
        ctx.session.lastStructured = result.structured;
        ctx.session.lastEvidences = result.evidences;

        await saveConversationState(groupId, author, followupQuestion, finalText, { groupName }).catch(() => {});
        await logMessage(groupId, groupName, "BOT", finalText, true);
      } catch (error) {
        if (error instanceof LLMApiError && error.isRateLimited) {
          const safeMessage = error.userMessage || "I am currently rate-limited. Please try again shortly.";
          await ctx.reply(safeMessage);
          await logMessage(groupId, groupName, "BOT", safeMessage, true);
          return;
        }
        throw error;
      }
      return;
    }

    const confirmArg = parseCommandArg(text, "confirm", botUsername);
    if (confirmArg !== null) {
      if (String(confirmArg).toLowerCase() !== "yes") {
        await ctx.reply("Use /confirm yes to execute the pending action.");
        return;
      }

      const pending = ctx.session?.pendingAction;
      if (!pending) {
        await ctx.reply("No pending action to confirm.");
        return;
      }

      const actionResult = await executeAllowedAction(ctx, pending, botUserId);
      ctx.session.pendingAction = null;
      const reply = await ctx.reply(actionResult);
      ctx.session.lastBotReplyMessageId = reply?.message_id || null;
      await logMessage(groupId, groupName, "BOT", actionResult, true);
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
      const reply = await ctx.reply(helpText);
      ctx.session.lastBotReplyMessageId = reply?.message_id || null;
      await logMessage(groupId, groupName, "BOT", helpText, true);
      debugLog(`capabilities_reply_sent group=${groupId}`);
      return;
    }

    try {
      let answer = "";
      let structured = ctx.session.lastStructured;
      let evidences = [];
      let pendingAction = null;

      if (isAgentPipelineEnabled()) {
        const result = await runAgentPipeline(groupId, question, ctx.session);
        answer = result.answer;
        structured = result.structured;
        evidences = result.evidences;
        pendingAction = result.pendingAction;

        if (pendingAction) {
          ctx.session.pendingAction = pendingAction;
          answer = `${answer}\n\nProposed action: ${pendingAction.name}. Reply with /confirm yes to execute.`;
        }

        answer = normalizeBotOutput(answer + formatEvidenceFooter(evidences));
      } else {
        const context = await recallContext(groupId, question);
        debugLog(`context_len_before_llm=${context.length}`);
        answer = await askClaude(context, question);
      }

      const reply = await ctx.reply(answer);
      ctx.session.lastBotReplyMessageId = reply?.message_id || null;
      ctx.session.lastQuestion = question;
      ctx.session.lastAnswer = answer;
      ctx.session.lastStructured = structured;
      ctx.session.lastEvidences = evidences;

      await saveConversationState(groupId, author, question, answer, { groupName }).catch((error) => {
        debugLog(`saveConversationState failed: ${error?.message || error}`);
      });

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

      // Preserve existing functionality by falling back to single-pass flow.
      try {
        const fallbackContext = await recallContext(groupId, question);
        const fallbackAnswer = await askClaude(fallbackContext, question);
        const cleanFallbackAnswer = normalizeBotOutput(fallbackAnswer);
        const reply = await ctx.reply(cleanFallbackAnswer);
        ctx.session.lastBotReplyMessageId = reply?.message_id || null;
        ctx.session.lastQuestion = question;
        ctx.session.lastAnswer = cleanFallbackAnswer;
        await logMessage(groupId, groupName, "BOT", cleanFallbackAnswer, true);
        debugLog(`pipeline_fallback_reply_sent group=${groupId}`);
        return;
      } catch (fallbackError) {
        throw fallbackError;
      }
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



