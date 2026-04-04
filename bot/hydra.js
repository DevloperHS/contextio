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
  const metadata = JSON.stringify({
    author: cleanAuthor,
    timestamp: new Date().toISOString(),
    seeded: Boolean(options?.seeded),
  });

  debugLog(
    `saveMessage(group=${groupId}, write_sub_tenant=${subTenantId}, author=${cleanAuthor}, text_len=${cleanText.length})`
  );

  const result = await withRetry(() => hydra.upload.addMemory({
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

  const firstItem = Array.isArray(result?.results) ? result.results[0] : undefined;
  const queuedStatus = firstItem?.status || "unknown";
  const resultSourceId = firstItem?.source_id || "n/a";
  debugLog(
    `saveMessage success(write_sub_tenant=${subTenantId}, source_id=${resultSourceId}, status=${queuedStatus})`
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

async function recallContext(groupId, question) {
  const hydra = getHydraClient();
  const tenantId = process.env.HYDRA_TENANT_ID;
  const query = String(question || "");
  const maxResults = getMaxRecallResults();
  const subTenants = resolveRecallSubTenants(groupId);
  const contexts = [];
  debugLog(
    `recallContext(group=${groupId}, recall_sub_tenants=${subTenants.join(",")}, query_len=${query.length}, max_results=${maxResults})`
  );

  for (const subTenantId of subTenants) {
    const result = await withRetry(() => hydra.recall.fullRecall({
      tenant_id: tenantId,
      sub_tenant_id: subTenantId,
      query,
      alpha: 0.7,
      recency_bias: 0.3,
      max_results: maxResults,
    }));

    const primaryContext = normalizeRecallContext(result);
    const chunkCount = extractChunkCount(result);
    debugLog(
      `recallContext sub_tenant=${subTenantId}, chunks=${chunkCount}, context_len=${primaryContext.length}`
    );
    if (primaryContext) {
      contexts.push(primaryContext);
    }

    const memoryResult = await withRetry(() => hydra.recall.recallPreferences({
      tenant_id: tenantId,
      sub_tenant_id: subTenantId,
      query,
      alpha: 0.7,
      recency_bias: 0.3,
      max_results: maxResults,
    }));
    const memoryContext = normalizeRecallContext(memoryResult);
    const memoryChunkCount = extractChunkCount(memoryResult);
    debugLog(
      `recallPreferences sub_tenant=${subTenantId}, chunks=${memoryChunkCount}, context_len=${memoryContext.length}`
    );
    if (memoryContext) {
      contexts.push(memoryContext);
    }
  }

  const merged = mergeUniqueContexts(contexts);
  debugLog(`recallContext merged_context_len=${merged.length}`);
  return merged;
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
      const verify = await withRetry(() => hydra.upload.verifyProcessing({
        tenant_id: tenantId,
        sub_tenant_id: subTenantId,
        file_ids: batch,
      }));

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
  recallContext,
  extractSourceIdsFromAddMemory,
  waitForProcessingReady,
};
