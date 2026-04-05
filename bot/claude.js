const { loadEnv, requireLLMEnv, resolveLLMProvider } = require("./env");

const DEFAULT_SYSTEM_PROMPT =
  "You are a Telegram group assistant. Use only the provided context. Give precise, factual answers. If asked to list items, return bullets. If context is insufficient, clearly say what is missing.";

class LLMApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "LLMApiError";
    this.statusCode = options.statusCode;
    this.provider = options.provider;
    this.isRateLimited = Boolean(options.isRateLimited);
    this.retryAfterMs = options.retryAfterMs || 0;
    this.userMessage = options.userMessage || "";
    this.raw = options.raw;
  }
}

function isDebugEnabled() {
  return String(process.env.BOT_DEBUG || "0") === "1";
}

function debugLog(message) {
  if (isDebugEnabled()) {
    console.log(`[llm] ${message}`);
  }
}

function parseDurationToMs(value) {
  if (!value) return 0;
  const text = String(value).trim();
  const match = text.match(/^(\d+(?:\.\d+)?)s$/i);
  if (!match) return 0;
  return Math.max(0, Math.ceil(Number.parseFloat(match[1]) * 1000));
}

function parseRetryAfterHeader(response) {
  const retryAfter = response?.headers?.get?.("retry-after");
  if (!retryAfter) return 0;
  const asInt = Number.parseInt(retryAfter, 10);
  if (!Number.isNaN(asInt)) return Math.max(0, asInt * 1000);

  const asDate = Date.parse(retryAfter);
  if (Number.isNaN(asDate)) return 0;
  return Math.max(0, asDate - Date.now());
}

function extractGeminiRetryDelayMs(data) {
  const details = data?.error?.details;
  if (!Array.isArray(details)) return 0;
  for (const item of details) {
    if (item && item["@type"] === "type.googleapis.com/google.rpc.RetryInfo") {
      return parseDurationToMs(item.retryDelay);
    }
  }
  return 0;
}

function getGeminiMaxRetries() {
  const raw = Number.parseInt(process.env.GEMINI_MAX_RETRIES || "2", 10);
  if (Number.isNaN(raw)) return 2;
  return Math.max(0, Math.min(raw, 6));
}

function getGeminiBaseRetryMs() {
  const raw = Number.parseInt(process.env.GEMINI_RETRY_BASE_MS || "1500", 10);
  if (Number.isNaN(raw)) return 1500;
  return Math.max(250, Math.min(raw, 10000));
}

function getAgentGeminiModel() {
  return process.env.AGENT_GEMINI_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

function buildGeminiUserMessage(retryAfterMs) {
  if (retryAfterMs > 0) {
    const waitSec = Math.ceil(retryAfterMs / 1000);
    return `I am rate-limited by Gemini right now. Please try again in about ${waitSec}s.`;
  }
  return "I am currently rate-limited by Gemini. Please try again shortly.";
}

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return fallback;
  }
}

function extractGeminiText(data) {
  if (!Array.isArray(data?.candidates)) return "";
  return data.candidates
    .flatMap((candidate) => (candidate?.content?.parts ? candidate.content.parts : []))
    .filter((part) => part && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function extractGeminiFunctionCall(data) {
  if (!Array.isArray(data?.candidates)) return null;
  const parts = data.candidates.flatMap((candidate) =>
    candidate?.content?.parts ? candidate.content.parts : []
  );

  for (const part of parts) {
    const fc = part?.functionCall || part?.function_call;
    if (!fc || !fc.name) continue;
    const args = fc.args && typeof fc.args === "object" ? fc.args : {};
    return {
      name: String(fc.name),
      args,
    };
  }

  return null;
}

function buildGeminiRateLimitError(response, data, attempt) {
  const baseRetryMs = getGeminiBaseRetryMs();
  const retryAfterMs = Math.max(
    parseRetryAfterHeader(response),
    extractGeminiRetryDelayMs(data),
    baseRetryMs * Math.pow(2, attempt)
  );
  const jitterMs = Math.floor(Math.random() * 250);
  const finalWaitMs = retryAfterMs + jitterMs;

  return new LLMApiError(
    `Gemini API rate limit (429): ${JSON.stringify(data)}`,
    {
      statusCode: 429,
      provider: "gemini",
      isRateLimited: true,
      retryAfterMs: finalWaitMs,
      userMessage: buildGeminiUserMessage(finalWaitMs),
      raw: data,
    }
  );
}

async function callGeminiWithRetries(model, body) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const maxRetries = getGeminiMaxRetries();
  let lastRateLimit;
  let data = {};

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify(body),
    });

    data = await response.json().catch(() => ({}));
    if (response.ok) {
      return data;
    }

    if (response.status === 429) {
      const rateError = buildGeminiRateLimitError(response, data, attempt);
      lastRateLimit = rateError;
      if (attempt < maxRetries) {
        debugLog(`gemini 429 retry attempt=${attempt + 1}/${maxRetries} wait_ms=${rateError.retryAfterMs}`);
        await new Promise((resolve) => setTimeout(resolve, rateError.retryAfterMs));
        continue;
      }
      throw rateError;
    }

    throw new LLMApiError(`Gemini API error (${response.status}): ${JSON.stringify(data)}`, {
      statusCode: response.status,
      provider: "gemini",
      raw: data,
    });
  }

  if (lastRateLimit) {
    throw lastRateLimit;
  }

  throw new LLMApiError(`Gemini API error: ${JSON.stringify(data)}`, {
    provider: "gemini",
    raw: data,
  });
}

async function askAnthropic(systemPrompt, userPrompt) {
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
  debugLog(`provider=anthropic model=${model} prompt_len=${userPrompt.length}`);
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 700,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Anthropic API error (${response.status}): ${JSON.stringify(data)}`);
  }

  const text = Array.isArray(data.content)
    ? data.content
        .filter((item) => item && item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n")
    : "";

  if (!text) throw new Error("Anthropic API returned empty text content.");
  return text.trim();
}

async function askOpenAI(systemPrompt, userPrompt) {
  const model = process.env.OPENAI_MODEL || "gpt-5.4-mini";
  debugLog(`provider=openai model=${model} prompt_len=${userPrompt.length}`);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      max_output_tokens: 700,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemPrompt }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: userPrompt }],
        },
      ],
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`OpenAI API error (${response.status}): ${JSON.stringify(data)}`);
  }

  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const text = Array.isArray(data.output)
    ? data.output
        .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
        .filter((part) => part && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
    : "";

  if (!text) throw new Error("OpenAI API returned empty text content.");
  return text.trim();
}

async function askGemini(systemPrompt, userPrompt) {
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  debugLog(`provider=gemini model=${model} prompt_len=${userPrompt.length}`);

  const data = await callGeminiWithRetries(model, {
    system_instruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: userPrompt }],
      },
    ],
    generationConfig: {
      maxOutputTokens: 700,
    },
  });

  const text = extractGeminiText(data);
  if (!text) throw new Error("Gemini API returned empty text content.");
  return text;
}

function buildUserPrompt(context, question, extraInstructions = "") {
  return [
    `Context:\n${context || "No relevant context."}`,
    `Question: ${question}`,
    extraInstructions ? `Instructions: ${extraInstructions}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function askLLMAdvanced(options = {}) {
  loadEnv();
  const provider = options.provider || requireLLMEnv();

  const safeContext = String(options.context || "").trim();
  const safeQuestion = String(options.question || "").trim();
  const safeSystemPrompt = String(options.systemPrompt || DEFAULT_SYSTEM_PROMPT);
  const safeExtraInstructions = String(options.extraInstructions || "").trim();

  if (!safeQuestion) {
    throw new Error("Question is required for askLLMAdvanced().");
  }

  const userPrompt = buildUserPrompt(safeContext, safeQuestion, safeExtraInstructions);
  debugLog(`askLLMAdvanced provider=${provider} context_len=${safeContext.length} question_len=${safeQuestion.length}`);

  if (provider === "anthropic") {
    return askAnthropic(safeSystemPrompt, userPrompt);
  }

  if (provider === "openai") {
    return askOpenAI(safeSystemPrompt, userPrompt);
  }

  if (provider === "gemini") {
    return askGemini(safeSystemPrompt, userPrompt);
  }

  throw new Error(`Unsupported LLM provider: ${resolveLLMProvider()}`);
}

async function askLLM(context, question) {
  return askLLMAdvanced({ context, question });
}

async function askGeminiStructured(systemPrompt, userPrompt, responseSchema) {
  loadEnv();
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is required for structured Gemini calls.");
  }

  const model = getAgentGeminiModel();
  const data = await callGeminiWithRetries(model, {
    system_instruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: userPrompt }],
      },
    ],
    generationConfig: {
      maxOutputTokens: 900,
      responseMimeType: "application/json",
      responseSchema,
    },
  });

  const text = extractGeminiText(data);
  const parsed = safeJsonParse(text, null);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Gemini structured response was not valid JSON.");
  }
  return parsed;
}

async function classifyIntent(question) {
  const q = String(question || "").trim();
  if (!q) {
    return { intent: "question", confidence: 0.5, action_name: "", reason: "empty question" };
  }

  if (!process.env.GEMINI_API_KEY) {
    const lowered = q.toLowerCase();
    if (lowered.includes("pin") || lowered.includes("schedule") || lowered.includes("remind") || lowered.includes("mute") || lowered.includes("ban")) {
      return { intent: "action", confidence: 0.6, action_name: "", reason: "heuristic action keywords" };
    }
    if (lowered.includes("help") || lowered.includes("what can you do") || lowered.includes("examples")) {
      return { intent: "help", confidence: 0.8, action_name: "", reason: "heuristic help keywords" };
    }
    return { intent: "question", confidence: 0.6, action_name: "", reason: "heuristic default" };
  }

  const schema = {
    type: "object",
    properties: {
      intent: { type: "string", enum: ["question", "action", "help"] },
      confidence: { type: "number" },
      action_name: { type: "string" },
      reason: { type: "string" },
    },
    required: ["intent", "confidence", "action_name", "reason"],
  };

  const result = await askGeminiStructured(
    "Classify user intent for a Telegram group assistant.",
    `Question: ${q}`,
    schema
  );

  return {
    intent: String(result.intent || "question"),
    confidence: Number(result.confidence || 0),
    action_name: String(result.action_name || ""),
    reason: String(result.reason || ""),
  };
}

async function rewriteRetrievalQuery(question, contextHint = "") {
  const q = String(question || "").trim();
  const hint = String(contextHint || "").trim();
  if (!q) {
    return { query: "", keywords: [] };
  }

  if (!process.env.GEMINI_API_KEY) {
    return { query: q, keywords: [] };
  }

  const schema = {
    type: "object",
    properties: {
      query: { type: "string" },
      keywords: { type: "array", items: { type: "string" } },
    },
    required: ["query", "keywords"],
  };

  const result = await askGeminiStructured(
    "Rewrite vague user requests into concise retrieval queries optimized for semantic recall.",
    `User question: ${q}\nContext hint: ${hint || "none"}`,
    schema
  );

  return {
    query: String(result.query || q).trim() || q,
    keywords: Array.isArray(result.keywords)
      ? result.keywords.map((k) => String(k || "").trim()).filter(Boolean)
      : [],
  };
}

async function rerankAndExtract(question, candidateChunks) {
  const chunks = Array.isArray(candidateChunks) ? candidateChunks : [];
  if (chunks.length === 0) {
    return {
      selected_indices: [],
      answer_focus: "",
      issues: [],
      action_items: [],
      entities: [],
      dates: [],
    };
  }

  if (!process.env.GEMINI_API_KEY) {
    return {
      selected_indices: chunks.slice(0, 8).map((_item, i) => i),
      answer_focus: "heuristic top chunks",
      issues: [],
      action_items: [],
      entities: [],
      dates: [],
    };
  }

  const capped = chunks.slice(0, 40).map((chunk, idx) => ({
    idx,
    source_id: chunk.source_id,
    title: chunk.source_title,
    score: chunk.score,
    text: String(chunk.content || "").slice(0, 400),
    author: chunk.document_metadata?.author || "",
    timestamp: chunk.document_metadata?.timestamp || chunk.source_upload_time || "",
  }));

  const schema = {
    type: "object",
    properties: {
      selected_indices: { type: "array", items: { type: "integer" } },
      answer_focus: { type: "string" },
      issues: { type: "array", items: { type: "string" } },
      action_items: { type: "array", items: { type: "string" } },
      entities: { type: "array", items: { type: "string" } },
      dates: { type: "array", items: { type: "string" } },
    },
    required: ["selected_indices", "answer_focus", "issues", "action_items", "entities", "dates"],
  };

  const result = await askGeminiStructured(
    "Rerank recall chunks by relevance and extract structured facts.",
    `Question: ${question}\nChunks:\n${JSON.stringify(capped)}`,
    schema
  );

  const validSet = new Set(capped.map((item) => item.idx));
  const selected = Array.isArray(result.selected_indices)
    ? result.selected_indices
        .map((n) => Number.parseInt(String(n), 10))
        .filter((n) => Number.isInteger(n) && validSet.has(n))
    : [];

  return {
    selected_indices: selected,
    answer_focus: String(result.answer_focus || ""),
    issues: Array.isArray(result.issues) ? result.issues.map((x) => String(x || "")).filter(Boolean) : [],
    action_items: Array.isArray(result.action_items) ? result.action_items.map((x) => String(x || "")).filter(Boolean) : [],
    entities: Array.isArray(result.entities) ? result.entities.map((x) => String(x || "")).filter(Boolean) : [],
    dates: Array.isArray(result.dates) ? result.dates.map((x) => String(x || "")).filter(Boolean) : [],
  };
}

async function chooseActionByFunctionCall(question) {
  const q = String(question || "").trim();
  if (!q || !process.env.GEMINI_API_KEY) {
    return null;
  }

  const model = getAgentGeminiModel();
  const tools = [
    {
      functionDeclarations: [
        {
          name: "summarize_thread",
          description: "Summarize current discussion thread in concise bullets.",
          parameters: {
            type: "object",
            properties: {
              focus_topic: { type: "string" },
            },
            required: [],
          },
        },
        {
          name: "pin_summary",
          description: "Pin the most recent bot summary in the chat.",
          parameters: {
            type: "object",
            properties: {
              reason: { type: "string" },
            },
            required: [],
          },
        },
        {
          name: "schedule_reminder",
          description: "Schedule a follow-up reminder suggestion.",
          parameters: {
            type: "object",
            properties: {
              reminder_text: { type: "string" },
              when_text: { type: "string" },
            },
            required: ["reminder_text", "when_text"],
          },
        },
        {
          name: "moderation_action",
          description: "Moderation operation proposal (mute/warn/ban) with reason.",
          parameters: {
            type: "object",
            properties: {
              action: { type: "string" },
              target: { type: "string" },
              reason: { type: "string" },
            },
            required: ["action", "target", "reason"],
          },
        },
      ],
    },
  ];

  const payload = {
    systemInstruction: {
      parts: [
        {
          text: "Decide if the user request maps to one function call. If no action is requested, do not call a function.",
        },
      ],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: q }],
      },
    ],
    tools,
    toolConfig: {
      functionCallingConfig: {
        mode: "AUTO",
      },
    },
  };

  let data;
  try {
    data = await callGeminiWithRetries(model, payload);
  } catch (error) {
    // Fallback to snake_case REST shape if server expects it.
    data = await callGeminiWithRetries(model, {
      system_instruction: payload.systemInstruction,
      contents: payload.contents,
      tools,
      tool_config: {
        function_calling_config: {
          mode: "AUTO",
        },
      },
    });
  }

  return extractGeminiFunctionCall(data);
}

// Backward compatibility with the PRD naming.
const askClaude = askLLM;

module.exports = {
  askLLM,
  askLLMAdvanced,
  askClaude,
  classifyIntent,
  rewriteRetrievalQuery,
  rerankAndExtract,
  chooseActionByFunctionCall,
  LLMApiError,
};
