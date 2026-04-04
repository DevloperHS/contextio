require("dotenv").config();
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");

const apiId = Number.parseInt(process.env.TELEGRAM_API_ID, 10);
const apiHash = process.env.TELEGRAM_API_HASH;

async function main() {
  if (!apiId || !apiHash) {
    throw new Error(
      "Missing TELEGRAM_API_ID or TELEGRAM_API_HASH in .env. Set both and rerun."
    );
  }

  const session = new StringSession("");
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 3,
  });

  await client.start({
    phoneNumber: async () => input.text("Your phone number (+countrycode): "),
    password: async () => input.text("2FA password (leave blank if none): "),
    phoneCode: async () => input.text("Code you received on Telegram: "),
    onError: (err) => console.error(err),
  });

  console.log("\n--- COPY THIS SESSION STRING ---");
  console.log(client.session.save());
  console.log("--- PASTE INTO .env as GRAMJS_SESSION ---\n");

  await client.disconnect();
}

main().catch((error) => {
  console.error("[auth-session] Failed:");
  console.error(error.message || error);
  process.exit(1);
});
