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

function buildGeminiUserMessage(retryAfterMs) {
  if (retryAfterMs > 0) {
    const waitSec = Math.ceil(retryAfterMs / 1000);
    return `I am rate-limited by Gemini right now. Please try again in about ${waitSec}s.`;
  }
  return "I am currently rate-limited by Gemini. Please try again shortly.";
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
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const maxRetries = getGeminiMaxRetries();
  const baseRetryMs = getGeminiBaseRetryMs();
  let lastRateLimit;
  let data = {};

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
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
      }),
    });

    data = await response.json().catch(() => ({}));
    if (response.ok) {
      const text = Array.isArray(data.candidates)
        ? data.candidates
            .flatMap((candidate) => (candidate?.content?.parts ? candidate.content.parts : []))
            .filter((part) => part && typeof part.text === "string")
            .map((part) => part.text)
            .join("\n")
        : "";

      if (!text) throw new Error("Gemini API returned empty text content.");
      return text.trim();
    }

    if (response.status === 429) {
      const retryAfterMs = Math.max(
        parseRetryAfterHeader(response),
        extractGeminiRetryDelayMs(data),
        baseRetryMs * Math.pow(2, attempt)
      );
      const jitterMs = Math.floor(Math.random() * 250);
      const finalWaitMs = retryAfterMs + jitterMs;

      lastRateLimit = new LLMApiError(
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

      if (attempt < maxRetries) {
        debugLog(`gemini 429 retry attempt=${attempt + 1}/${maxRetries} wait_ms=${finalWaitMs}`);
        await new Promise((resolve) => setTimeout(resolve, finalWaitMs));
        continue;
      }
      throw lastRateLimit;
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

async function askLLM(context, question) {
  loadEnv();
  const provider = requireLLMEnv();

  const safeContext = String(context || "").trim();
  const safeQuestion = String(question || "").trim();

  if (!safeQuestion) {
    throw new Error("Question is required for askLLM().");
  }

  const systemPrompt = DEFAULT_SYSTEM_PROMPT;
  const userPrompt = `Context:\n${safeContext || "No relevant context."}\n\nQuestion: ${safeQuestion}`;
  debugLog(`askLLM context_len=${safeContext.length} question_len=${safeQuestion.length}`);

  if (provider === "anthropic") {
    return askAnthropic(systemPrompt, userPrompt);
  }

  if (provider === "openai") {
    return askOpenAI(systemPrompt, userPrompt);
  }

  if (provider === "gemini") {
    return askGemini(systemPrompt, userPrompt);
  }

  throw new Error(`Unsupported LLM provider: ${resolveLLMProvider()}`);
}

// Backward compatibility with the PRD naming.
const askClaude = askLLM;

module.exports = {
  askLLM,
  askClaude,
  LLMApiError,
};
