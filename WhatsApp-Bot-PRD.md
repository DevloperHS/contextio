# WhatsApp Group AI Bot — Product Requirements Document

> **Stack:** Next.js · whatsapp-web.js · HydraDB · SQLite · Docker
> **Version:** 1.0 — April 4, 2026 · **Status:** Draft — Ready for Engineering

---

## Meta

| Field | Value |
|---|---|
| Project | WhatsApp Group AI Bot |
| Version | 1.0 — April 4, 2026 |
| Status | Draft — Ready for Engineering |
| Target AI | Claude Sonnet (`claude-sonnet-4-20250514`) |
| Memory Layer | HydraDB (`@hydra_db/node`) |
| Local DB | SQLite via `better-sqlite3` |
| Frontend | Next.js 14 + Tailwind CSS |
| Deployment | Docker + Docker Compose |

---

## 1. High-Level Goal

Build a self-hosted WhatsApp group bot that:

- Listens to one or more WhatsApp group chats via `whatsapp-web.js`
- Persists every message into HydraDB for intelligent, evolving memory
- Seeds historical chat messages (up to ~1,000 per group) into HydraDB on first boot
- Responds to `@bot` mentions with Claude-powered answers grounded in real chat context
- Exposes a lightweight Next.js dashboard to monitor bot health, memory, and chat activity
- Runs entirely in Docker — no external paid services beyond API keys

> The bot must feel like a group member that has read every message — not a generic chatbot. Memory compounds with each interaction via HydraDB's versioned context graph.

---

## 2. Tech Stack & Official Docs

| Layer | Technology | Docs |
|---|---|---|
| WhatsApp Bridge | whatsapp-web.js v1.34.6 | https://docs.wwebjs.dev |
| AI / LLM | Claude Sonnet via Anthropic API | https://docs.anthropic.com |
| Memory / Context | HydraDB (`@hydra_db/node`) | https://docs.hydradb.com |
| Local DB | SQLite (`better-sqlite3`) | https://github.com/WiseLibs/better-sqlite3 |
| Frontend | Next.js 14 + Tailwind CSS | https://nextjs.org/docs |
| Runtime | Node.js v18+ | https://nodejs.org |
| Container | Docker + Docker Compose | https://docs.docker.com |
| Browser Driver | Puppeteer (bundled with wwebjs) | https://pptr.dev |

---

## 3. System Architecture

### Data & Request Flow

```
WhatsApp Group
       │
whatsapp-web.js v1.34.6 (Puppeteer / Chromium)
       │
bot/index.js
 ├── [ALL messages]  ──────► HydraDB  memories.add()
 │                              (versioned context graph)
 └── [@bot mention]
         │
         ├── HydraDB  recall.full_recall(question)
         │        └── returns: relevant context string
         │
         ├── Claude API  (context + question → answer)
         │
         └── msg.reply(answer) → back to WhatsApp group

Next.js Dashboard (port 3000)
       └── reads SQLite for logs / stats
       └── health checks HydraDB + bot process
```

### Historical Message Seeding Flow

```
On first boot (ready event fires):
       │
       ├── check for .hydra_seeded flag file
       │       └── if exists → skip seeding entirely
       │
       └── if not seeded:
               ├── client.getChats() → filter isGroup
               ├── for each group: fetchMessages({ limit: 1000 })
               ├── for each message → saveMessage() → HydraDB
               └── write .hydra_seeded file when complete
```

> **Limit:** `fetchMessages()` caps at ~1,000 messages per group — this is a WhatsApp Web API constraint, not a code limitation.

### Folder Structure

```
whatsapp-hydra-bot/
├── bot/
│   ├── index.js          ← main bot entry point
│   ├── hydra.js          ← HydraDB save + recall helpers
│   ├── claude.js         ← Anthropic API helper
│   ├── seed.js           ← historical message seeder
│   └── db.js             ← SQLite logger
├── dashboard/            ← Next.js 14 app
│   └── app/
│       ├── page.jsx      ← main dashboard UI
│       └── api/
│           ├── stats/route.js
│           └── logs/route.js
├── data/                 ← SQLite file lives here (volume mounted)
├── .wwebjs_auth/         ← WhatsApp session (volume mounted)
├── .env                  ← secrets (never committed)
├── setup-hydra.js        ← run once to create HydraDB tenant
├── Dockerfile
├── docker-compose.yml
└── package.json
```

---

## 4. Phase 1 — Manual Setup (Human Runs These)

> Run each command block and share the full terminal output before asking Codex to write any code.

---

### Step 1.1 — Verify Prerequisites

```bash
node -v          # must be v18.0.0+
npm -v           # must be v9+
docker -v        # must be v24+
docker compose version   # must be v2+
```

**Share the output of all four commands.**

---

### Step 1.2 — Collect API Keys

Get both keys before writing any code:

| Key | Where |
|---|---|
| `ANTHROPIC_API_KEY` | https://console.anthropic.com/settings/keys |
| `HYDRADB_API_KEY` | Email `team@hydradb.com` or sign up at https://hydradb.com |

---

### Step 1.3 — Scaffold Project & Install Dependencies

**Block A — Create project:**
```bash
mkdir whatsapp-hydra-bot && cd whatsapp-hydra-bot
npm init -y
mkdir bot dashboard data
```

**Block B — Install bot dependencies:**
```bash
npm install whatsapp-web.js@1.34.6 qrcode-terminal @hydra_db/node \
  better-sqlite3 dotenv
```

**Block C — Create Next.js dashboard:**
```bash
cd dashboard
npx create-next-app@latest . --tailwind --app --yes
cd ..
```

**Block D — Linux only (skip on Mac/Windows):**
```bash
sudo apt-get install -y libgbm-dev libxkbcommon-x11-0 \
  libx11-xcb1 libxcb-dri3-0 libxss1 libasound2
```

**Share output of Block B and Block C.**

---

### Step 1.4 — Create `.env` File

Create at project root — **never commit this file.**

```env
# Anthropic
ANTHROPIC_API_KEY=sk-ant-your-key-here

# HydraDB
HYDRADB_API_KEY=your-hydradb-key-here
HYDRA_TENANT_ID=wa-group-bot

# Local
SQLITE_DB_PATH=./data/bot.db
NODE_ENV=development
```

```bash
echo ".env" >> .gitignore
echo ".wwebjs_auth/" >> .gitignore
echo "data/" >> .gitignore
echo ".hydra_seeded" >> .gitignore
```

---

### Step 1.5 — Bootstrap HydraDB Tenant

Create `setup-hydra.js` at the project root:

```js
require('dotenv').config();
const { HydraDBClient } = require('@hydra_db/node');

async function setup() {
  const client = new HydraDBClient({ token: process.env.HYDRADB_API_KEY });
  const result = await client.tenant.create({
    tenant_id: process.env.HYDRA_TENANT_ID
  });
  console.log('Tenant created:', JSON.stringify(result, null, 2));
}

setup().catch(console.error);
```

```bash
node setup-hydra.js
```

**Share the JSON response. "Already exists" is fine — proceed.**

---

### Step 1.6 — First QR Scan

```bash
node bot/index.js

# A QR code will print in terminal.
# On your phone: WhatsApp → Settings → Linked Devices → Link a Device → Scan
# You should see:
#   ✅ Authenticated — session saved locally
#   🤖 Bot is live!
# Session is saved to .wwebjs_auth/ — no re-scan needed on restarts.
```

**Share the full terminal output from this step.**

---

## 5. Phase 2 — Codex Implements the Code

> Give Codex one prompt at a time. Wait for the human to run the code and confirm it works before the next prompt.

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
       tenant_id, sub_tenant_id: groupId,
       memory: author + ": " + text,
       metadata: { author, timestamp: ISO string }
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
  System: "You are a WhatsApp group assistant. Answer in 2-3 sentences
           using the provided group chat context."
  User: "Context:\n" + context + "\n\nQuestion: " + question
  Return the text content string.

Print all 3 files in full with inline comments.
```

---

### Codex Prompt B — Historical Seeder

```
Implement bot/seed.js using whatsapp-web.js v1.34.6.

Requirements:
- Guard with .hydra_seeded flag file — skip entirely if file exists
- Accept the already-initialized `client` as a parameter
- Call client.getChats() and filter for isGroup === true
- For each group: fetchMessages({ limit: 1000 })
- For each message with a body: call saveMessage() from hydra.js
  and logMessage() from db.js
- Log progress per group: console.log(`[seed] ${group.name}: ${i}/${total}`)
- After all groups done: fs.writeFileSync('.hydra_seeded', new Date().toISOString())
- Export: async function seedHistory(client)

Do not run yet. Print the file in full.
```

---

### Codex Prompt C — Main Bot Entry

```
Implement bot/index.js using whatsapp-web.js v1.34.6.

Import: Client, LocalAuth from whatsapp-web.js
        qrcode from qrcode-terminal
        initDB, logMessage from ./db.js
        saveMessage, recallContext from ./hydra.js
        askClaude from ./claude.js
        seedHistory from ./seed.js

Startup sequence:
1. initDB()
2. new Client({ authStrategy: new LocalAuth({ clientId: 'group-bot' }),
                puppeteer: { headless: true,
                             args: ['--no-sandbox','--disable-setuid-sandbox',
                                    '--disable-dev-shm-usage'] } })
3. client.on('qr') -> qrcode.generate(qr, { small: true })
4. client.on('authenticated') -> console.log
5. client.on('ready') -> await seedHistory(client), then console.log bot live
6. client.on('message') ->
     if !chat.isGroup return
     always: saveMessage() + logMessage()
     if @bot in body (case insensitive):
       question = body.replace(/@bot/gi,'').trim()
       if empty: msg.reply('Ask me something after @bot')
       else:
         context = await recallContext(groupId, question)
         answer = await askClaude(context, question)
         msg.reply(answer)
         logMessage(... isBotReply: true)
7. client.on('disconnected') -> log, setTimeout reconnect 5s
8. client.initialize()

Run: node bot/index.js
Share full console output including seeder progress.
```

---

### Codex Prompt D — Next.js Dashboard

```
Implement the Next.js dashboard in dashboard/app/.

--- dashboard/app/api/stats/route.js ---
GET handler. Open SQLite at SQLITE_DB_PATH.
Return JSON: { totalMessages, totalGroups, botReplies, uptime: process.uptime() }

--- dashboard/app/api/logs/route.js ---
GET handler. Return last 50 rows from messages table as JSON array.

--- dashboard/app/page.jsx ---
'use client'. Tailwind styled. WhatsApp green color scheme (#25D366).
4 stat cards: Total Messages / Groups / Bot Replies / Uptime
Message log table: Time | Group | Author | Message | Bot?
Auto-refresh every 10 seconds via setInterval.

Run: cd dashboard && npm run dev
Share any errors.
```

---

### Codex Prompt E — Docker

```
Write Dockerfile and docker-compose.yml.

Dockerfile:
- FROM node:18-slim
- Install Chromium apt deps (needed by Puppeteer):
    libgbm-dev libxkbcommon-x11-0 libx11-xcb1 libxcb-dri3-0 libxss1 libasound2
- WORKDIR /app
- Copy package.json, run npm install --production
- Copy bot/ and dashboard/
- Build Next.js: cd dashboard && npm install && npm run build
- Create start.sh that runs:
    node bot/index.js &
    cd dashboard && node server.js
- EXPOSE 3000, CMD ["/app/start.sh"]

docker-compose.yml:
- service: app
- env_file: .env
- ports: "3000:3000"
- volumes:
    ./data:/app/data
    ./.wwebjs_auth:/app/.wwebjs_auth
- restart: unless-stopped

Run:
  docker compose build
  docker compose up
Share build logs and any errors.
```

---

## 6. Feature Requirements

| ID | Feature | Acceptance Criteria |
|---|---|---|
| F-01 | QR Auth + Persist | Scan once; session survives restarts via LocalAuth |
| F-02 | Historical Seeding | On first boot, fetches up to 1,000 msgs per group into HydraDB |
| F-03 | Real-time Memory | Every group message saved to HydraDB within 500ms |
| F-04 | @bot Trigger | Only responds when `@bot` is present in message body |
| F-05 | Context Recall | HydraDB `full_recall` returns relevant prior context |
| F-06 | Claude Response | Answer in 2–3 sentences, grounded in recalled context |
| F-07 | SQLite Logging | All messages + bot replies stored with metadata |
| F-08 | Dashboard | Next.js page shows stats + last 50 messages |
| F-09 | Multi-group | Bot operates across all groups the linked number is in |
| F-10 | Docker deploy | `docker compose up` brings everything up cleanly |

---

## 7. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| WhatsApp ToS | Unofficial library — use a dedicated phone number, not your primary account. Fine for personal/internal use. |
| History cap (~1,000 msgs) | `fetchMessages()` limit is a WhatsApp Web API constraint. Older history is inaccessible via this method. |
| HydraDB API key | Must request from `team@hydradb.com`. Not self-serve yet. Get this first. |
| Docker memory | Chromium needs ≥1GB RAM. Set Docker Desktop memory to 2GB minimum. |
| Session expiry | If `.wwebjs_auth` is deleted or session expires, re-scan the QR code. |

---

## 8. All Reference Links

### WhatsApp Bridge
- whatsapp-web.js Docs — https://docs.wwebjs.dev
- whatsapp-web.js GitHub — https://github.com/pedroslopez/whatsapp-web.js
- Authentication Strategies — https://wwebjs.dev/guide/creating-your-bot/authentication
- npm package (v1.34.6) — https://www.npmjs.com/package/whatsapp-web.js

### HydraDB
- Quickstart — https://docs.hydradb.com/quickstart
- Node SDK Reference — https://docs.hydradb.com/api-reference/sdks
- Recall Endpoints — https://docs.hydradb.com/essentials/recall
- Memory Concepts — https://docs.hydradb.com/essentials/memories

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
