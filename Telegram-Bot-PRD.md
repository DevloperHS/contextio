# Telegram Group AI Bot — Product Requirements Document

> **Stack:** grammY · GramJS (MTProto) · HydraDB · SQLite · Next.js · Docker
> **Version:** 1.0 — April 4, 2026 · **Status:** Draft — Ready for Engineering · **Scope:** MVP

---

## Meta

| Field | Value |
|---|---|
| Project | Telegram Group AI Bot (MVP) |
| Version | 1.0 — April 4, 2026 |
| Status | Draft — Ready for Engineering |
| Bot Framework | grammY v1.41.1 |
| History Seeder | GramJS v2.26.22 (`telegram` npm pkg — MTProto, personal account) |
| Memory Layer | HydraDB (`@hydra_db/node`) |
| Local DB | SQLite via `better-sqlite3` |
| Frontend | Next.js 14 + Tailwind CSS |
| Deployment | Docker + Docker Compose |
| AI Model | Claude Sonnet (`claude-sonnet-4-20250514`) |

---

## 1. High-Level Goal

Build a self-hosted Telegram group bot that does three things cleanly:

- **Seeds** full chat history from your personal Telegram account using GramJS (MTProto) into HydraDB on first boot — unlimited history, no cap.
- **Listens** to all group messages in real time via a grammY bot and saves each one to HydraDB as it arrives.
- **Responds** to `@bot` mentions with a Claude-powered answer grounded in recalled group context from HydraDB.

An optional Next.js dashboard shows bot health, message stats, and recent activity. Everything runs in a single Docker Compose stack.

---

## 2. Architecture Overview

### Two-Process Design

The project runs two separate processes that share HydraDB as the common memory layer.

```
Process 1 — Seeder (runs once on first boot)
  GramJS client (your personal account, MTProto)
       │
       ├── getDialogs()    → find all groups you are in
       ├── iterMessages()  → stream full history (no cap)
       │
       ├──► HydraDB  memories.add()   per message
       ├──► SQLite   log each batch
       └──► write .seeded flag file when done

Process 2 — Live Bot (runs forever)
  grammY Bot (Bot API token from @BotFather)
       │
       ├── bot.on("message:text") → every group message
       │         │
       │         ├──► HydraDB  memories.add()    (save)
       │         └──► SQLite   logMessage()
       │
       └── @bot mention detected
                 │
                 ├──► HydraDB  recall.full_recall()   (retrieve context)
                 ├──► Claude API  askClaude(context, question)
                 └──► ctx.reply(answer)

Process 3 — Dashboard (optional, port 3000)
  Next.js 14 reads SQLite for stats and logs
```

### Folder Structure

```
telegram-hydra-bot/
├── bot/
│   ├── index.js          ← grammY bot entry point
│   ├── seed.js           ← GramJS MTProto seeder (run once)
│   ├── hydra.js          ← HydraDB save + recall helpers
│   ├── claude.js         ← Anthropic API helper
│   ├── db.js             ← SQLite logger
│   └── auth-session.js   ← generate GramJS string session (run once)
├── dashboard/
│   └── app/
│       ├── page.jsx
│       └── api/
│           ├── stats/route.js
│           └── logs/route.js
├── data/                 ← SQLite file (Docker volume)
├── session/              ← GramJS session string (Docker volume)
├── setup-hydra.js        ← run once to create HydraDB tenant
├── .env
├── Dockerfile
├── docker-compose.yml
└── package.json
```

---

## 3. Tech Stack & Docs

| Layer | Library / Tool | Official Docs |
|---|---|---|
| Bot framework | grammY v1.41.1 | https://grammy.dev |
| History seeder | GramJS v2.26.22 (`telegram` npm pkg) | https://gram.js.org |
| Memory layer | HydraDB `@hydra_db/node` | https://docs.hydradb.com |
| Local database | `better-sqlite3` | https://github.com/WiseLibs/better-sqlite3 |
| AI / LLM | Anthropic Claude Sonnet | https://docs.anthropic.com |
| Frontend | Next.js 14 + Tailwind CSS | https://nextjs.org/docs |
| Runtime | Node.js v18+ | https://nodejs.org |
| Container | Docker + Compose | https://docs.docker.com |
| Telegram API credentials | my.telegram.org | https://my.telegram.org |

---

## 4. Phase 1 — Manual Setup (Human Runs These)

> Run every command block below. Share full terminal output after each block before asking Codex to write any code.

---

### Step 1.1 — Verify Prerequisites

```bash
node -v                  # must be v18+
npm -v                   # must be v9+
docker -v                # must be v24+
docker compose version   # must be v2+
```

**Share the output of all four commands.**

---

### Step 1.2 — Collect All Credentials

Get all five before writing any code:

| Credential | Where to get it |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Open Telegram → message `@BotFather` → `/newbot` → follow prompts |
| `TELEGRAM_API_ID` | https://my.telegram.org → Log in → API development tools → create app → copy `api_id` |
| `TELEGRAM_API_HASH` | Same page → copy `api_hash` |
| `HYDRADB_API_KEY` | Email `team@hydradb.com` or sign up at https://hydradb.com |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com/settings/keys |

> **Important:** Add the grammY bot to every group you want it to monitor and make it an **admin** so it receives all messages.

---

### Step 1.3 — Scaffold Project & Install Dependencies

**Block A — Create folders:**
```bash
mkdir telegram-hydra-bot && cd telegram-hydra-bot
npm init -y
mkdir bot dashboard data session
```

**Block B — Install bot dependencies:**
```bash
npm install grammy telegram @hydra_db/node \
  better-sqlite3 dotenv input
```

**Block C — Create Next.js dashboard:**
```bash
cd dashboard
npx create-next-app@latest . --tailwind --app --yes
cd ..
```

**Share output of Block B and Block C.**

---

### Step 1.4 — Create `.env` File

Create at project root — **never commit this file.**

```env
# Telegram Bot (grammY)
TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather

# Telegram MTProto (GramJS — your personal account)
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=abcdef1234567890abcdef1234567890

# Filled in after Step 1.5:
GRAMJS_SESSION=

# HydraDB
HYDRADB_API_KEY=your_hydradb_key
HYDRA_TENANT_ID=tg-group-bot

# Anthropic
ANTHROPIC_API_KEY=sk-ant-your-key

# Local
SQLITE_DB_PATH=./data/bot.db
```

```bash
echo ".env" >> .gitignore
echo "data/" >> .gitignore
echo "session/" >> .gitignore
echo ".seeded" >> .gitignore
```

---

### Step 1.5 — Generate GramJS String Session (Interactive)

GramJS needs to authenticate as your personal Telegram account once to get a persistent session string. This step sends an OTP to your phone.

Create `bot/auth-session.js`:

```js
require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');

const apiId   = parseInt(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

(async () => {
  const session = new StringSession('');
  const client  = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 3,
  });

  await client.start({
    phoneNumber: async () => await input.text('Your phone number (+countrycode): '),
    password:    async () => await input.text('2FA password (leave blank if none): '),
    phoneCode:   async () => await input.text('Code you received on Telegram: '),
    onError:     (err) => console.error(err),
  });

  console.log('\n--- COPY THIS SESSION STRING ---');
  console.log(client.session.save());
  console.log('--- PASTE INTO .env as GRAMJS_SESSION ---\n');
  await client.disconnect();
})();
```

```bash
node bot/auth-session.js
```

The script will prompt for your phone number and the OTP Telegram sends you. Copy the long session string it prints and paste it into `.env` as `GRAMJS_SESSION=`.

**Share the terminal output (but keep the session string private — treat it like a password).**

---

### Step 1.6 — Bootstrap HydraDB Tenant

Create `setup-hydra.js` at project root:

```js
require('dotenv').config();
const { HydraDBClient } = require('@hydra_db/node');

(async () => {
  const client = new HydraDBClient({ token: process.env.HYDRADB_API_KEY });
  const result = await client.tenant.create({
    tenant_id: process.env.HYDRA_TENANT_ID,
  });
  console.log('Tenant created:', JSON.stringify(result, null, 2));
})();
```

```bash
node setup-hydra.js
```

**Share the JSON response. "Already exists" is fine — proceed.**

---

### Step 1.7 — Smoke Test the Bot Token

```bash
curl https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getMe
# Should return JSON with your bot's name and username.
```

**Share the curl output.**

---

## 5. Phase 2 — Codex Implements the Code

> Give Codex one prompt at a time. Wait for the human to run the code and confirm before the next prompt.

---

### Codex Prompt A — Core Helpers

```
Implement these 3 files in the bot/ folder.
Use require() (CommonJS). Use dotenv. All functions async.

--- bot/db.js ---
Init SQLite at SQLITE_DB_PATH. Create table:
  messages(id, group_id, group_name, author, body, is_bot_reply, created_at)
Export: initDB(), logMessage(groupId, groupName, author, body, isBotReply)
Export: getStats() -> { totalMessages, totalGroups, botReplies }
Export: getRecentLogs(limit=50) -> array of rows

--- bot/hydra.js ---
Import HydraDBClient from @hydra_db/node.
saveMessage(groupId, author, text):
  -> client.memories.add({
       tenant_id,
       sub_tenant_id: groupId,
       memory: author + ": " + text,
       metadata: { author, timestamp: new Date().toISOString() }
     })
recallContext(groupId, question):
  -> client.recall.full_recall({
       tenant_id, sub_tenant_id: groupId,
       query: question, alpha: 0.7, recency_bias: 0.3
     })
  -> return result.context or empty string

--- bot/claude.js ---
askClaude(context, question):
  POST to https://api.anthropic.com/v1/messages
  model: claude-sonnet-4-20250514, max_tokens: 500
  System: "You are a Telegram group assistant. Answer in 2-3 sentences
           using the provided group chat context."
  User: "Context:\n" + context + "\n\nQuestion: " + question
  Return the text content string.

Print all 3 files in full with inline comments.
```

---

### Codex Prompt B — GramJS History Seeder

```
Implement bot/seed.js using the "telegram" npm package (GramJS v2.26.22).

Requirements:
- Guard with .seeded flag file — skip entirely if file exists
- Load StringSession from process.env.GRAMJS_SESSION
- Connect using TELEGRAM_API_ID and TELEGRAM_API_HASH
- Call client.getDialogs({ limit: 200 }) to list all chats
- Filter for groups and supergroups:
    dialog.isGroup === true OR dialog.entity?.megagroup === true
- For each group, use client.iterMessages(dialog.entity, { limit: 5000 })
  to stream full message history
- For each message: if message.text exists and is non-empty:
    call saveMessage(groupId, senderName, message.text) from hydra.js
    call logMessage(groupId, groupTitle, senderName, message.text, false) from db.js
- Telegram rate-limits GetHistory: add await sleep(1000) every 1000 messages
- Log progress: console.log(`[seed] "${groupTitle}": msg ${count}`)
- After all groups done: fs.writeFileSync('.seeded', new Date().toISOString())
- Helper: const sleep = ms => new Promise(r => setTimeout(r, ms))
- Export: async function seedHistory()

Do not run it yet. Print the file in full.
```

---

### Codex Prompt C — grammY Bot Entry

```
Implement bot/index.js using grammY v1.41.1.

Import: Bot from grammy
        initDB, logMessage from ./db.js
        saveMessage, recallContext from ./hydra.js
        askClaude from ./claude.js
        seedHistory from ./seed.js

Startup sequence:
1. await initDB()
2. await seedHistory()   ← runs if no .seeded file, skips if already done
3. const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN)

Message handler (bot.on("message:text")):
- Only process group and supergroup messages:
    if ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup' return
- groupId   = String(ctx.chat.id)
- groupName = ctx.chat.title || 'unknown'
- author    = ctx.from.username || ctx.from.first_name || 'unknown'
- text      = ctx.message.text

- Always:
    await saveMessage(groupId, author, text)
    await logMessage(groupId, groupName, author, text, false)

- If text.toLowerCase().includes('@bot'):
    question = text.replace(/@bot/gi, '').trim()
    if question is empty:
      ctx.reply('Ask me something after @bot')
    else:
      context = await recallContext(groupId, question)
      answer  = await askClaude(context, question)
      await ctx.reply(answer)
      await logMessage(groupId, groupName, 'BOT', answer, true)

- bot.catch(): log error, reply 'Something went wrong, try again'
- bot.start() at end (long polling)

Run: node bot/index.js
Share full console output including seeder progress logs.
```

---

### Codex Prompt D — Next.js Dashboard

```
Implement the Next.js dashboard in dashboard/app/.

--- dashboard/app/api/stats/route.js ---
GET handler. Open SQLite at SQLITE_DB_PATH env var.
Return JSON: { totalMessages, totalGroups, botReplies, uptime: process.uptime() }

--- dashboard/app/api/logs/route.js ---
GET handler. Return last 50 rows from messages table as JSON array.

--- dashboard/app/page.jsx ---
'use client'. Tailwind styled. Telegram blue color scheme (#229ED9).
Show 4 stat cards: Total Messages | Groups | Bot Replies | Uptime
Show message log table: Time | Group | Author | Message | Bot Reply?
Auto-refresh every 10 seconds via setInterval + clearInterval on unmount.

Run: cd dashboard && npm run dev
Open http://localhost:3000 and share a screenshot or describe what you see.
Share any errors.
```

---

### Codex Prompt E — Docker

```
Write Dockerfile and docker-compose.yml.

Dockerfile:
- FROM node:18-slim
- NO Chromium needed (grammY + GramJS are pure Node.js, no browser)
- WORKDIR /app
- Copy package.json, run npm install --production
- Copy bot/ and setup-hydra.js
- Copy dashboard/, run: cd dashboard && npm install && npm run build
- Create start.sh:
    #!/bin/sh
    node bot/index.js &
    cd dashboard && node server.js
- RUN chmod +x /app/start.sh
- EXPOSE 3000
- CMD ["/app/start.sh"]

docker-compose.yml:
- service: app
- env_file: .env
- ports: "3000:3000"
- volumes:
    ./data:/app/data
    ./session:/app/session
- restart: unless-stopped

Run:
  docker compose build
  docker compose up
Share build logs and any runtime errors.
```

---

## 6. Key Differences vs WhatsApp Version

| Concern | WhatsApp Version | This Telegram Version |
|---|---|---|
| History seeder | `fetchMessages()` — ~1,000 msg cap | `iterMessages()` via MTProto — unlimited |
| Bot auth | QR code scan (Puppeteer) | Bot token from `@BotFather` |
| History auth | Same session (no separation) | Personal account + GramJS string session |
| Browser needed | Yes — Chromium via Puppeteer | No — pure Node.js |
| Docker image size | ~1.2GB (Chromium) | ~200MB |
| Ban risk | Medium (unofficial library) | Zero (official APIs) |
| `@bot` trigger | `@bot` in message body | Same |
| ToS compliance | Against WhatsApp ToS | Fully compliant |

---

## 7. MVP Feature Checklist

| ID | Feature | Done When... |
|---|---|---|
| F-01 | Bot token auth | `getMe` returns bot info without error |
| F-02 | GramJS MTProto auth | String session generated and saved to `.env` |
| F-03 | HydraDB tenant | Tenant creation returns 200 |
| F-04 | History seeding | `.seeded` file written; HydraDB has group messages |
| F-05 | Real-time save | Every group message saved to HydraDB + SQLite |
| F-06 | `@bot` trigger | Bot replies only on `@bot` mention in group |
| F-07 | Context recall | Recalled context comes from actual group history |
| F-08 | Claude answer | 2–3 sentences, grounded in context |
| F-09 | Dashboard | Stats page loads at `localhost:3000` |
| F-10 | Docker deploy | `docker compose up` brings everything up |

---

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| MTProto rate limits | GramJS handles most limits automatically. Add 1s sleep per 1,000 messages in seeder. |
| Very large groups (100k+ msgs) | Seeder will take time. Bot can start answering `@bot` queries in parallel while seeding continues. |
| HydraDB API key | Must request from `team@hydradb.com` — not self-serve yet. Get this before starting. |
| GramJS session expiry | String sessions are long-lived. If expired, re-run `auth-session.js` and update `.env`. |
| Bot not admin in group | grammY bot must be added to each group and made admin to receive all messages in supergroups. |

---

## 9. All Reference Links

### Telegram Bot (grammY)
- grammY Docs — https://grammy.dev
- grammY Getting Started — https://grammy.dev/guide/getting-started
- grammY npm (v1.41.1) — https://www.npmjs.com/package/grammy
- grammY GitHub — https://github.com/grammyjs/grammY
- Telegram Bot API Docs — https://core.telegram.org/bots/api
- Create your bot — https://t.me/BotFather

### GramJS (MTProto — History Seeder)
- GramJS Docs — https://gram.js.org
- GramJS GitHub — https://github.com/gram-js/gramjs
- `telegram` npm package (v2.26.22) — https://www.npmjs.com/package/telegram
- Telegram API credentials — https://my.telegram.org
- iterMessages docs — https://gram.js.org/classes/client.TelegramClient.html#iterMessages
- StringSession docs — https://gram.js.org/classes/sessions.StringSession.html

### HydraDB
- Quickstart — https://docs.hydradb.com/quickstart
- Node SDK — https://docs.hydradb.com/api-reference/sdks
- Recall Endpoints — https://docs.hydradb.com/essentials/recall
- Memories — https://docs.hydradb.com/essentials/memories

### Anthropic / Claude
- API Docs — https://docs.anthropic.com
- Messages API — https://docs.anthropic.com/en/api/messages
- Models List — https://docs.anthropic.com/en/docs/about-claude/models

### Frontend & Database
- Next.js 14 Docs — https://nextjs.org/docs
- Tailwind CSS — https://tailwindcss.com/docs
- better-sqlite3 API — https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md

### Docker
- Docker Compose Docs — https://docs.docker.com/compose
- node:18-slim image — https://hub.docker.com/_/node

---

*End of PRD*
