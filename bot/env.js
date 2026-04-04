const path = require("path");
const dotenv = require("dotenv");

let loaded = false;

function loadEnv() {
  if (loaded) return;
  const envPath = path.resolve(process.cwd(), ".env");
  dotenv.config({ path: envPath });
  loaded = true;
}

function requireEnv(keys) {
  loadEnv();
  const missing = keys.filter((key) => {
    const value = process.env[key];
    return value === undefined || value === null || String(value).trim() === "";
  });

  if (missing.length > 0) {
    throw new Error(
      [
        "Missing required environment variables:",
        ...missing.map((k) => `- ${k}`),
        "",
        "Copy .env.example to .env and fill the missing values.",
      ].join("\n")
    );
  }
}

function resolveLLMProvider() {
  loadEnv();
  return String(process.env.LLM_PROVIDER || "anthropic").trim().toLowerCase();
}

function requireLLMEnv() {
  const provider = resolveLLMProvider();

  if (provider === "anthropic") {
    requireEnv(["ANTHROPIC_API_KEY"]);
    return provider;
  }

  if (provider === "openai") {
    requireEnv(["OPENAI_API_KEY"]);
    return provider;
  }

  if (provider === "gemini") {
    requireEnv(["GEMINI_API_KEY"]);
    return provider;
  }

  throw new Error(
    `Invalid LLM_PROVIDER: "${provider}". Use one of: anthropic, openai, gemini.`
  );
}

module.exports = {
  loadEnv,
  requireEnv,
  requireLLMEnv,
  resolveLLMProvider,
};
