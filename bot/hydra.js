const { HydraDBClient } = require("@hydra_db/node");
const { loadEnv, requireEnv } = require("./env");

let client;

function isDebugEnabled() {
  return String(process.env.BOT_DEBUG || "0") === "1";
}

function debugLog(message) {
  if (isDebugEnabled()) {
    console.log(`[hydra] ${message}`);
  }
}

function getHydraApiKey() {
  return process.env.HYDRADB_API_KEY || process.env.HYDRA_DB_API_KEY || "";
}

function getGlobalSubTenantId() {
  const value = String(process.env.GLOBAL_SUB_TENANT_ID || "").trim();
  return value || "global-knowledge";
}

function getMaxRecallResults() {
  const raw = process.env.HYDRA_MAX_RECALL_RESULTS;
  if (!raw) return 25;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return 25;
  return Math.max(5, Math.min(parsed, 100));
}

function getRecallBreadthResults() {
  const raw = process.env.HYDRA_RECALL_BREADTH_RESULTS;
  if (!raw) return 40;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return 40;
  return Math.max(10, Math.min(parsed, 200));
}

function shouldUseMetadataFilters() {
  return String(process.env.HYDRA_USE_METADATA_FILTERS || "0") === "1";
}

function resolveWriteSubTenant(groupId) {
  const scope = String(process.env.HYDRA_WRITE_SCOPE || "group").trim().toLowerCase();
  if (scope === "global") {
    return getGlobalSubTenantId();
  }
  return String(groupId);
}

function shouldVerifyOnSeed() {
  return String(process.env.HYDRA_VERIFY_PROCESSING_ON_SEED || "1") === "1";
}

function getVerifyPollIntervalMs() {
  const raw = Number.parseInt(process.env.HYDRA_VERIFY_POLL_INTERVAL_MS || "3000", 10);
  if (Number.isNaN(raw)) return 3000;
  return Math.max(1000, Math.min(raw, 30000));
}

function getVerifyMaxWaitMs() {
  const raw = Number.parseInt(process.env.HYDRA_VERIFY_MAX_WAIT_MS || "300000", 10);
  if (Number.isNaN(raw)) return 300000;
  return Math.max(10000, Math.min(raw, 3600000));
}

function isReadyIndexStatus(status) {
  const s = String(status || "").toLowerCase();
  return s === "completed" || s === "success" || s === "graph_creation";
}

function isFailedIndexStatus(status) {
  const s = String(status || "").toLowerCase();
  return s === "errored";
}

function chunkArray(values, size) {
  const chunks = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

function resolveRecallSubTenants(groupId) {
  const scope = String(process.env.HYDRA_RECALL_SCOPE || "group").trim().toLowerCase();
  const groupSubTenant = String(groupId);
  const globalSubTenant = getGlobalSubTenantId();

  if (scope === "global") {
    return [globalSubTenant];
  }

  if (scope === "group_plus_global") {
    return [groupSubTenant, globalSubTenant];
  }

  return [groupSubTenant];
}

function getHydraClient() {
  if (client) return client;

  loadEnv();
  requireEnv(["HYDRA_TENANT_ID"]);
  const apiKey = getHydraApiKey();
  if (!apiKey) {
    throw new Error(
      "Missing Hydra API key. Set HYDRADB_API_KEY or HYDRA_DB_API_KEY in .env."
    );
  }

  client = new HydraDBClient({ token: apiKey });
  return client;
}

function unwrapHydraResponse(response) {
  if (response && typeof response === "object" && response.data && typeof response.data === "object") {
    return response.data;
  }
  return response || {};
}

async function withRetry(operation, attempts = 3) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const waitMs = 300 * attempt;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }

  throw lastError;
}

function buildMessageMetadata(groupId, author, options = {}) {
  const nowIso = options.timestamp ? String(options.timestamp) : new Date().toISOString();
  return {
    author: String(author || "unknown"),
    timestamp: nowIso,
    message_type: String(options.messageType || "chat"),
    topic: options.topic ? String(options.topic) : "",
    reply_to: options.replyTo ? String(options.replyTo) : "",
    group_id: String(groupId),
    group_name: options.groupName ? String(options.groupName) : "",
    telegram_message_id: options.messageId !== undefined ? String(options.messageId) : "",
    seeded: Boolean(options.seeded),
  };
}

async function saveMessage(groupId, author, text, options = {}) {
  if (!text || !String(text).trim()) {
    return { skipped: true, reason: "empty_text" };
  }

  const hydra = getHydraClient();
  const tenantId = process.env.HYDRA_TENANT_ID;
  const subTenantId = resolveWriteSubTenant(groupId);
  const cleanAuthor = String(author || "unknown");
  const cleanText = String(text);
  const requestedSourceId = options?.sourceId ? String(options.sourceId) : undefined;
  const title = options?.title ? String(options.title) : undefined;
  const metadata = JSON.stringify(buildMessageMetadata(groupId, cleanAuthor, options));

  debugLog(
    `saveMessage(group=${groupId}, write_sub_tenant=${subTenantId}, author=${cleanAuthor}, text_len=${cleanText.length})`
  );

  const rawResult = await withRetry(() => hydra.upload.addMemory({
    memories: [
      {
        source_id: requestedSourceId,
        title,
        text: `${cleanAuthor}: ${cleanText}`,
        infer: false,
        document_metadata: metadata,
      },
    ],
    tenant_id: tenantId,
    sub_tenant_id: subTenantId,
    upsert: true,
  }));

  const result = unwrapHydraResponse(rawResult);
  const firstItem = Array.isArray(result?.results) ? result.results[0] : undefined;
  const queuedStatus = firstItem?.status || "unknown";
  const resultSourceId = firstItem?.source_id || "n/a";
  debugLog(
    `saveMessage success(write_sub_tenant=${subTenantId}, source_id=${resultSourceId}, status=${queuedStatus})`
  );
  return result;
}

async function saveConversationState(groupId, userName, userMessage, assistantMessage, options = {}) {
  const cleanUserMessage = String(userMessage || "").trim();
  const cleanAssistantMessage = String(assistantMessage || "").trim();
  if (!cleanUserMessage || !cleanAssistantMessage) {
    return { skipped: true, reason: "empty_conversation_pair" };
  }

  const hydra = getHydraClient();
  const tenantId = process.env.HYDRA_TENANT_ID;
  const subTenantId = resolveWriteSubTenant(groupId);
  const metadata = JSON.stringify(buildMessageMetadata(groupId, userName, {
    ...options,
    messageType: "user_assistant_pair",
  }));

  const rawResult = await withRetry(() => hydra.upload.addMemory({
    memories: [
      {
        title: options?.title ? String(options.title) : "Conversation state",
        user_name: String(userName || "user"),
        user_assistant_pairs: [
          {
            user: cleanUserMessage,
            assistant: cleanAssistantMessage,
          },
        ],
        infer: true,
        document_metadata: metadata,
      },
    ],
    tenant_id: tenantId,
    sub_tenant_id: subTenantId,
    upsert: true,
  }));

  const result = unwrapHydraResponse(rawResult);
  const firstItem = Array.isArray(result?.results) ? result.results[0] : undefined;
  debugLog(
    `saveConversationState success(sub_tenant=${subTenantId}, source_id=${firstItem?.source_id || "n/a"}, status=${firstItem?.status || "unknown"})`
  );

  return result;
}

function extractSourceIdsFromAddMemory(result) {
  if (!Array.isArray(result?.results)) return [];
  return result.results
    .map((item) => (item && typeof item.source_id === "string" ? item.source_id : ""))
    .filter(Boolean);
}

function normalizeRecallContext(result) {
  if (!result) return "";

  if (typeof result.context === "string") return result.context;

  if (Array.isArray(result.chunks)) {
    return result.chunks
      .map((chunk) => (chunk && typeof chunk.chunk_content === "string" ? chunk.chunk_content : ""))
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function extractChunkCount(result) {
  return Array.isArray(result?.chunks) ? result.chunks.length : 0;
}

function mergeUniqueContexts(contexts) {
  const seen = new Set();
  const merged = [];

  for (const block of contexts) {
    const lines = String(block || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      if (!seen.has(line)) {
        seen.add(line);
        merged.push(line);
      }
    }
  }

  return merged.join("\n");
}

function parseObjectMaybe(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function normalizeChunk(chunk, meta) {
  const documentMeta = parseObjectMaybe(chunk?.document_metadata);
  return {
    key: `${chunk?.chunk_uuid || ""}:${chunk?.source_id || ""}`,
    chunk_uuid: String(chunk?.chunk_uuid || ""),
    source_id: String(chunk?.source_id || ""),
    content: String(chunk?.chunk_content || "").trim(),
    score: Number(chunk?.relevancy_score || 0),
    source_title: String(chunk?.source_title || ""),
    source_upload_time: String(chunk?.source_upload_time || ""),
    source_last_updated_time: String(chunk?.source_last_updated_time || ""),
    source_type: String(chunk?.source_type || ""),
    document_metadata: documentMeta,
    recall_kind: meta.recallKind,
    recall_query: meta.query,
    sub_tenant_id: meta.subTenantId,
  };
}

async function runRecallWithFilterFallback(hydra, methodName, payload) {
  try {
    const response = await withRetry(() => hydra.recall[methodName](payload));
    return unwrapHydraResponse(response);
  } catch (error) {
    if (!payload.metadata_filters) {
      throw error;
    }
    debugLog(`${methodName} failed with metadata_filters, retrying without filters`);
    const safePayload = { ...payload };
    delete safePayload.metadata_filters;
    const response = await withRetry(() => hydra.recall[methodName](safePayload));
    return unwrapHydraResponse(response);
  }
}

function buildDefaultMetadataFilters(groupId, options = {}) {
  if (!shouldUseMetadataFilters()) return undefined;
  const custom = options?.metadataFilters;
  if (custom && typeof custom === "object") return custom;
  return { group_id: String(groupId) };
}

async function recallWithDiagnostics(groupId, question, options = {}) {
  const hydra = getHydraClient();
  const tenantId = process.env.HYDRA_TENANT_ID;
  const query = String(question || "").trim();
  const rewrittenQuery = String(options.rewrittenQuery || "").trim();
  const maxResults = options.maxResults || getRecallBreadthResults();
  const subTenants = resolveRecallSubTenants(groupId);
  const metadataFilters = buildDefaultMetadataFilters(groupId, options);
  const queries = Array.from(new Set([query, rewrittenQuery].filter(Boolean)));
  const rawContexts = [];
  const allChunks = [];

  debugLog(
    `recallWithDiagnostics(group=${groupId}, sub_tenants=${subTenants.join(",")}, queries=${queries.length}, max_results=${maxResults})`
  );

  for (const subTenantId of subTenants) {
    for (const q of queries) {
      const basePayload = {
        tenant_id: tenantId,
        sub_tenant_id: subTenantId,
        query: q,
        alpha: 0.7,
        recency_bias: 0.3,
        max_results: maxResults,
        mode: "thinking",
        additional_context: String(options.additionalContext || ""),
      };
      if (metadataFilters) {
        basePayload.metadata_filters = metadataFilters;
      }

      const sourceResult = await runRecallWithFilterFallback(hydra, "fullRecall", basePayload);
      rawContexts.push(normalizeRecallContext(sourceResult));
      const sourceChunks = Array.isArray(sourceResult?.chunks)
        ? sourceResult.chunks.map((chunk) => normalizeChunk(chunk, {
            recallKind: "fullRecall",
            query: q,
            subTenantId,
          }))
        : [];
      allChunks.push(...sourceChunks);
      debugLog(`fullRecall sub_tenant=${subTenantId}, query_len=${q.length}, chunks=${sourceChunks.length}`);

      const prefsResult = await runRecallWithFilterFallback(hydra, "recallPreferences", basePayload);
      rawContexts.push(normalizeRecallContext(prefsResult));
      const prefsChunks = Array.isArray(prefsResult?.chunks)
        ? prefsResult.chunks.map((chunk) => normalizeChunk(chunk, {
            recallKind: "recallPreferences",
            query: q,
            subTenantId,
          }))
        : [];
      allChunks.push(...prefsChunks);
      debugLog(`recallPreferences sub_tenant=${subTenantId}, query_len=${q.length}, chunks=${prefsChunks.length}`);
    }
  }

  const dedupMap = new Map();
  for (const chunk of allChunks) {
    if (!chunk.content) continue;
    const key = chunk.chunk_uuid || `${chunk.source_id}:${chunk.content}`;
    const existing = dedupMap.get(key);
    if (!existing || chunk.score > existing.score) {
      dedupMap.set(key, chunk);
    }
  }

  const dedupedChunks = Array.from(dedupMap.values()).sort((a, b) => b.score - a.score);
  const topCount = getMaxRecallResults();
  const topChunks = dedupedChunks.slice(0, topCount);
  const context = topChunks.map((chunk) => chunk.content).join("\n");
  const fallbackContext = mergeUniqueContexts(rawContexts);

  const evidences = topChunks.map((chunk, index) => ({
    rank: index + 1,
    source_id: chunk.source_id,
    source_title: chunk.source_title,
    score: chunk.score,
    sub_tenant_id: chunk.sub_tenant_id,
    recall_kind: chunk.recall_kind,
    recall_query: chunk.recall_query,
    snippet: chunk.content.slice(0, 280),
    author: String(chunk.document_metadata?.author || ""),
    timestamp: String(chunk.document_metadata?.timestamp || chunk.source_upload_time || ""),
  }));

  return {
    context: context || fallbackContext,
    evidences,
    chunks: dedupedChunks,
    total_chunks: dedupedChunks.length,
    metadata_filters_used: metadataFilters || null,
  };
}

async function recallContext(groupId, question) {
  const result = await recallWithDiagnostics(groupId, question);
  debugLog(`recallContext merged_context_len=${result.context.length}`);
  return result.context;
}

async function waitForProcessingReady(groupId, sourceIds) {
  if (!shouldVerifyOnSeed()) {
    debugLog("waitForProcessingReady skipped (HYDRA_VERIFY_PROCESSING_ON_SEED=0)");
    return {
      verified: false,
      skipped: true,
      total: 0,
      ready: 0,
      failed: [],
    };
  }

  const deduped = Array.from(new Set((sourceIds || []).filter(Boolean)));
  if (deduped.length === 0) {
    return {
      verified: true,
      skipped: false,
      total: 0,
      ready: 0,
      failed: [],
    };
  }

  const hydra = getHydraClient();
  const tenantId = process.env.HYDRA_TENANT_ID;
  const subTenantId = resolveWriteSubTenant(groupId);
  const pollMs = getVerifyPollIntervalMs();
  const maxWaitMs = getVerifyMaxWaitMs();
  const startedAt = Date.now();

  const pending = new Set(deduped);
  const failed = [];

  while (pending.size > 0) {
    const elapsed = Date.now() - startedAt;
    if (elapsed > maxWaitMs) {
      throw new Error(
        `Hydra verifyProcessing timeout after ${maxWaitMs}ms. pending=${pending.size}, failed=${failed.length}`
      );
    }

    const pendingList = Array.from(pending);
    const batches = chunkArray(pendingList, 100);

    for (const batch of batches) {
      const rawVerify = await withRetry(() => hydra.upload.verifyProcessing({
        tenant_id: tenantId,
        sub_tenant_id: subTenantId,
        file_ids: batch,
      }));
      const verify = unwrapHydraResponse(rawVerify);

      const statuses = Array.isArray(verify?.statuses) ? verify.statuses : [];
      for (const statusInfo of statuses) {
        const fileId = statusInfo?.file_id;
        const status = statusInfo?.indexing_status;
        if (!fileId) continue;

        if (isReadyIndexStatus(status)) {
          pending.delete(fileId);
        } else if (isFailedIndexStatus(status)) {
          pending.delete(fileId);
          failed.push(fileId);
        }
      }
    }

    debugLog(
      `verifyProcessing sub_tenant=${subTenantId}, total=${deduped.length}, ready=${deduped.length - pending.size - failed.length}, pending=${pending.size}, failed=${failed.length}`
    );

    if (pending.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  return {
    verified: true,
    skipped: false,
    total: deduped.length,
    ready: deduped.length - failed.length,
    failed,
  };
}

module.exports = {
  saveMessage,
  saveConversationState,
  recallContext,
  recallWithDiagnostics,
  extractSourceIdsFromAddMemory,
  waitForProcessingReady,
};
