# contextio

Telegram group context assistant using grammY + GramJS + HydraDB + LLM (Anthropic/OpenAI/Gemini).

## What it does

Input:
- Telegram group history and live messages
- Mention queries like `@your_bot summarize this thread`

Output:
- Bot replies in the group
- Persistent logs in SQLite (`messages` table)
- Optional dashboard view of logs and stats

## Core architecture

### Baseline flow (backward compatible)
1. Seeder ingests old group messages to HydraDB
2. Bot stores new group messages in HydraDB + SQLite
3. On mention, bot recalls context from HydraDB
4. Bot sends context + question to configured LLM and replies

### Agent pipeline (new)
1. Intent classifier (`question` / `action` / `help`)
2. Query rewriter (Gemini structured output)
3. Hydra multi-query retrieval (`fullRecall` + `recallPreferences`)
4. Rerank + extraction (issues/action items/entities/dates)
5. Final response with evidence lines
6. Optional safe action proposal + `/confirm yes`

If agent stages fail, bot falls back to single-pass retrieve + answer.

## New functionality added

- Stateful chat memory via grammY session per chat/user
- Richer Hydra metadata at ingest (`author`, `timestamp`, `message_type`, `group_id`, `reply_to`, etc.)
- Conversation-state memory ingest using `user_assistant_pairs` + `infer=true`
- Multi-query retrieval diagnostics with broader recall
- Structured extraction fields:
  - issues
  - action_items
  - entities
  - dates
- Action proposal via Gemini function-calling + allowlist execution
- Output sanitizer to remove markdown formatting markers before Telegram reply

## Prerequisites

- Node.js 18+
- npm
- Telegram bot token (BotFather)
- Telegram API ID/HASH (my.telegram.org)
- GramJS session string (personal account session)
- HydraDB API key + tenant id
- One LLM API key

## Setup

```bash
npm install
cp .env.example .env
```

Fill `.env`.

## Environment variables

Required:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`
- `GRAMJS_SESSION`
- `HYDRA_TENANT_ID`
- `SQLITE_DB_PATH`
- `HYDRADB_API_KEY` (or `HYDRA_DB_API_KEY`)
- `LLM_PROVIDER` (`anthropic`, `openai`, `gemini`)
- Provider key for chosen LLM

Important optional:
- `BOT_DEBUG=1` verbose runtime logs
- `AGENT_PIPELINE_ENABLED=1` enable 2-stage agent path
- `SEED_MESSAGE_LIMIT=5000` per group seed cap
- `SEED_TARGET_GROUP_ID=` seed only one group id
- `SEED_TARGET_GROUP_NAME=` seed only one exact group title (lowercase compare)
- `HYDRA_WRITE_SCOPE=group|global`
- `HYDRA_RECALL_SCOPE=group|global|group_plus_global`
- `GLOBAL_SUB_TENANT_ID=global-knowledge`
- `HYDRA_MAX_RECALL_RESULTS=25`
- `HYDRA_RECALL_BREADTH_RESULTS=40`
- `HYDRA_USE_METADATA_FILTERS=0`
- `HYDRA_VERIFY_PROCESSING_ON_SEED=1`
- `HYDRA_VERIFY_POLL_INTERVAL_MS=3000`
- `HYDRA_VERIFY_MAX_WAIT_MS=300000`
- `AGENT_GEMINI_MODEL=gemini-2.5-flash`
- `PORT=3000`

## Scope strategy (important)

Isolated per-group memory:
```env
HYDRA_WRITE_SCOPE=group
HYDRA_RECALL_SCOPE=group
```

Global shared memory across groups:
```env
HYDRA_WRITE_SCOPE=global
HYDRA_RECALL_SCOPE=global
GLOBAL_SUB_TENANT_ID=global-knowledge
```

Best balance (group-first + global fallback):
```env
HYDRA_WRITE_SCOPE=group
HYDRA_RECALL_SCOPE=group_plus_global
GLOBAL_SUB_TENANT_ID=global-knowledge
```

## How to retrieve each API key/token

### 1) Telegram bot token (`TELEGRAM_BOT_TOKEN`)
1. Open Telegram -> `@BotFather`
2. Run `/newbot`
3. Create bot and copy token
4. Put token in `.env`

Recommended for group bots:
- BotFather -> `/setprivacy` -> select bot -> **Disable**

### 2) Telegram API ID/HASH (`TELEGRAM_API_ID`, `TELEGRAM_API_HASH`)
1. Visit `https://my.telegram.org`
2. Log in with your phone number
3. Open **API development tools**
4. Create app if needed
5. Copy `api_id` and `api_hash`

### 3) GramJS session (`GRAMJS_SESSION`)
Generate with:

```bash
node bot/auth-session.js
```

Prompts shown:
- Phone number
- Telegram code
- 2FA password (if enabled)

Copy printed session string into `.env` as `GRAMJS_SESSION`.

Sanity check:

```bash
node -e "require('dotenv').config(); const s=(process.env.GRAMJS_SESSION||'').replace(/\s+/g,''); console.log('session_len=',s.length,'prefix=',s.slice(0,6),'suffix=',s.slice(-6));"
```

### 4) HydraDB API key + tenant (`HYDRADB_API_KEY`, `HYDRA_TENANT_ID`)
1. Open `https://app.hydradb.com/keys`
2. Sign up or log in
3. Create/copy your API key (for `HYDRADB_API_KEY`)
4. Go to **Tenant** and click **Create Tenant**
5. Select **Standard Tenant**
6. Add tenant ID, description, and keys (optional)
7. Click **Create**
8. Set values in `.env`:
   - `HYDRADB_API_KEY=...`
   - `HYDRA_TENANT_ID=<your_tenant_id>`

### 5) LLM API key
Choose one provider:

Anthropic:
- `LLM_PROVIDER=anthropic`
- `ANTHROPIC_API_KEY=...`
- `ANTHROPIC_MODEL=claude-sonnet-4-20250514`

OpenAI:
- `LLM_PROVIDER=openai`
- `OPENAI_API_KEY=...`
- `OPENAI_MODEL=gpt-5.4-mini`

Gemini:
- `LLM_PROVIDER=gemini`
- `GEMINI_API_KEY=...`
- `GEMINI_MODEL=gemini-2.5-flash`
- Optional retry tuning:
  - `GEMINI_MAX_RETRIES=2`
  - `GEMINI_RETRY_BASE_MS=1500`

## All run commands (used in this project)

### Run bot

```bash
npm run dev
# or
npm run bot
```

Expected output (examples):
- `[bot] Hydra scopes: write=..., recall=..., global=...`
- `[bot] Agent pipeline enabled: yes|no`
- `[seed] ...` (auto-seed runs at startup)
- `[bot] Starting long polling as @your_bot`

### Seeder

List groups first:

```bash
npm run seed:list-groups
```

Dry run:

```bash
npm run seed:dry
```

Real seed:

```bash
npm run seed
```

Force reseed:

```bash
SEED_FORCE=1 npm run seed
```

PowerShell:

```powershell
$env:SEED_FORCE="1"; npm run seed
```

### Dashboard

```bash
npm run dashboard
```

Open: `http://localhost:3000`

### Phase checks

```bash
npm run phase1:test
npm run phase2:test
```

Enable Hydra in phase1:

```bash
PHASE1_HYDRA_TEST=1 npm run phase1:test
```

Override phase2 prompt/context:

```bash
PHASE2_CONTEXT="Alice: release Friday" PHASE2_QUESTION="When is release?" npm run phase2:test
```

### Session auth utility

```bash
node bot/auth-session.js
```

### Misc scripts

```bash
npm run lint
npm test
```

## Telegram usage (new commands)

Mention usage:
- `@your_bot what did we decide about deployment?`
- `@your_bot list issues and action items from recent discussion`
- `@your_bot pin the latest summary`

Slash commands:
- `/help` or `/examples`
- `/issues` -> last extracted issues
- `/actions` -> last extracted action items
- `/status` -> provider/pipeline/scope/pending action
- `/followup <question>` -> multi-turn follow-up
- `/confirm yes` -> confirm pending safe action

## Safe action execution

Allowlisted actions currently supported:
- `summarize_thread`
- `pin_summary` (requires bot permission)
- `schedule_reminder` (preview message; no scheduler integration yet)
- `moderation_action` (preview/safe-mode response)

Actions are not auto-executed. User confirmation is required via `/confirm yes`.

## Output formatting behavior

Bot replies are normalized to plain Telegram text:
- strips markdown fences and markers (`**`, `*`, backticks, headings)
- keeps readable bullet points and evidence lines
- avoids raw formatting artifacts in final messages

## Debug modes

### Bot runtime debug
Set:

```env
BOT_DEBUG=1
```

Adds logs such as:
- incoming message metadata
- mention detection
- pipeline stage signals
- recall chunk counts
- reply sent / fallback events

### Seed verification controls
Set:

```env
HYDRA_VERIFY_PROCESSING_ON_SEED=1
HYDRA_VERIFY_POLL_INTERVAL_MS=3000
HYDRA_VERIFY_MAX_WAIT_MS=300000
```

This waits until seeded source IDs are ready/failed in Hydra before finishing group seed.

## Expected input/output examples

### Example 1: Mention question
Input:
- `@your_bot what did we decide for deployment?`

Expected:
- contextual answer
- evidence footer lines with source IDs/scores
- SQLite row with `is_bot_reply=1`

### Example 2: Structured extraction
Input:
- `@your_bot extract issues and action items from latest task messages`
- then `/issues` or `/actions`

Expected:
- extracted lists in clean text

### Example 3: Action confirmation
Input:
- `@your_bot pin the latest summary`
- `/confirm yes`

Expected:
- action preview/proposal then confirmed action response

## Common issues

1. `Missing Hydra API key`
- Set `HYDRADB_API_KEY` or `HYDRA_DB_API_KEY`

2. `GRAMJS session is not authorized`
- Re-run `node bot/auth-session.js`
- Replace `GRAMJS_SESSION`

3. Seeder says `.seeded exists ... Skipping seeding`
- Use `SEED_FORCE=1 npm run seed`

4. Bot not responding in group
- Add bot to group
- Disable bot privacy in BotFather
- Mention bot username explicitly

5. Dashboard says DB not found
- Start bot once so SQLite file is created
- Check `SQLITE_DB_PATH`

6. `phase2:test` fails with `fetch failed`
- Check internet access / firewall
- Verify `GEMINI_API_KEY` and provider/model settings

## Recommended first run

1. Configure `.env`
2. Generate GramJS session
3. Run `npm run seed:list-groups`
4. Set `SEED_TARGET_GROUP_ID`
5. Run `npm run seed:dry`
6. Run `npm run seed`
7. Run `npm run bot`
8. Mention bot in Telegram group
9. Run `npm run dashboard`
10. Validate new commands: `/status`, `/issues`, `/actions`, `/followup ...`

