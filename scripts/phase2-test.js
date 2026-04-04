const { loadEnv, requireLLMEnv, resolveLLMProvider } = require("../bot/env");
const { askLLM } = require("../bot/claude");

async function main() {
  loadEnv();
  const provider = requireLLMEnv();

  const context =
    process.env.PHASE2_CONTEXT ||
    "Alice: We deploy on Friday at 5 PM.\nBob: QA signoff is still pending.";
  const question =
    process.env.PHASE2_QUESTION || "When is deployment and what is blocked?";

  console.log(`[phase2] Provider: ${provider || resolveLLMProvider()}`);
  const answer = await askLLM(context, question);

  console.log("[phase2] Model response:");
  console.log(answer);
}

main().catch((error) => {
  console.error("[phase2] Failed:");
  console.error(error.message);
  process.exit(1);
});
