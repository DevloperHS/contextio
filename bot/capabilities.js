const CAPABILITY_SOURCE_PREFIX = "bot-capabilities-v1";

const PROMPT_TEMPLATES = [
  "@bot summarize last {n} points about {topic}",
  "@bot list issues mentioned by {user|all}",
  "@bot extract action items from recent context",
  "@bot what changed about {topic} this week",
  "@bot give a bullet summary of recent discussion on {topic}",
];

function buildCapabilitiesReply() {
  return [
    "I can help with context-aware group assistance:",
    "- Summarize recent chat context for a topic.",
    "- List discussed issues, concerns, and action items.",
    "- Compare what changed over recent discussion.",
    "- Extract key facts mentioned by participants.",
    "",
    "Prompt examples:",
    ...PROMPT_TEMPLATES.map((item) => `- ${item}`),
  ].join("\n");
}

function buildCapabilitiesSeedText(groupName) {
  const label = groupName || "this group";
  return [
    `SYSTEM: Bot capability guide for ${label}.`,
    "The bot can recall context from seeded and live messages, summarize discussions, list issues, extract action items, and answer targeted questions.",
    "Prompt templates:",
    ...PROMPT_TEMPLATES.map((item) => `- ${item}`),
  ].join("\n");
}

function isCapabilitiesQuestion(question) {
  const text = String(question || "").toLowerCase();
  if (!text) return false;
  return [
    "what can you do",
    "help",
    "how to use",
    "how can i use",
    "example prompt",
    "examples",
    "capabilities",
  ].some((needle) => text.includes(needle));
}

function buildCapabilitiesSourceId(groupId) {
  return `${CAPABILITY_SOURCE_PREFIX}-${String(groupId)}`;
}

module.exports = {
  PROMPT_TEMPLATES,
  buildCapabilitiesReply,
  buildCapabilitiesSeedText,
  isCapabilitiesQuestion,
  buildCapabilitiesSourceId,
};

