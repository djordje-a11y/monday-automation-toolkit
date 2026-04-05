# Monday Webhook Bridge (Cursor Trigger)

This bridge enables event-driven local processing:

1. monday item status changes to trigger label (default: `AI Work in progress`)
2. monday sends webhook to your local bridge
3. bridge validates filters (status + assignee and/or routing key)
4. bridge runs local command (default: create agent-intake prompt/context and dispatch agent runner)

For end-to-end setup requirements, see:

- `scripts/MONDAY_AGENT_AUTOMATION_REQUIREMENTS.md`

## 1) Configure local env

Use an ignored local env file (`.monday.local` recommended):

```bash
cat >> .monday.local <<'EOF'
MONDAY_API_TOKEN="your-monday-token"
MONDAY_BOARD_ID="2113467445"

# Webhook auth (recommended)
MONDAY_WEBHOOK_SECRET="replace-with-strong-random-secret"
MONDAY_WEBHOOK_AUTO_REGISTER="true"
MONDAY_WEBHOOK_REGISTER_BOARD_IDS="2113467445"
MONDAY_WEBHOOK_EVENT="change_specific_column_value"
MONDAY_WEBHOOK_MANAGED_STATE_FILE="artifacts/monday-automation/managed-webhooks.json"

# Trigger settings
MONDAY_TRIGGER_STATUS="AI Work in progress"
MONDAY_STATUS_COLUMN_ID="status"

# Optional: process only tickets assigned to your monday user id
MONDAY_ASSIGNEE_COLUMN_ID="person"
MONDAY_ASSIGNEE_USER_IDS="12345678"

# Optional: extra user-specific key filter
MONDAY_ROUTING_KEY_COLUMN_ID="cursor_owner_key"
MONDAY_ROUTING_KEY="sasa-local"

# Optional: override command bridge runs on match
# (default is monday:agent-intake with --dispatch)
MONDAY_ON_MATCH_COMMAND='node scripts/monday-agent-intake.js --item-id "$MONDAY_TRIGGER_ITEM_ID" --dispatch'

# v1 safety guard: allow only one active ticket dispatch at a time
MONDAY_SINGLE_TICKET_MODE="true"

# Agent-intake special rules + branch naming
MONDAY_AGENT_RULES_FILE="scripts/templates/monday-ticket-agent-rules.md"
MONDAY_AGENT_BRANCH_PREFIX="dev/monday"
MONDAY_AGENT_BRANCH_PREFIX_RULES="id:bugs=fix,id:epics_backlog=feat,bugs=fix,epics backlog=feat"
MONDAY_AGENT_BRANCH_INCLUDE_TICKET_ID="false"
MONDAY_AGENT_GIT_PREPARE_BRANCH="true"
MONDAY_AGENT_GIT_BASE_BRANCH="acceptance"
MONDAY_AGENT_GIT_REMOTE="origin"
MONDAY_AGENT_GIT_REQUIRE_CLEAN_WORKTREE="true"
MONDAY_AGENT_CREATE_CHAT="true"
MONDAY_AGENT_CREATE_CHAT_COMMAND='$HOME/.local/bin/cursor-agent create-chat'

# Required for dispatch mode:
# command that spawns your local agent using prompt/context env vars
# Available env vars:
# - MONDAY_AGENT_PROMPT_FILE
# - MONDAY_AGENT_CONTEXT_FILE
# - MONDAY_AGENT_ITEM_ID
# - MONDAY_AGENT_ITEM_NAME
# - MONDAY_AGENT_BRANCH_CANDIDATE
# - MONDAY_AGENT_CHAT_ID
# - MONDAY_AGENT_BASE_BRANCH
# - MONDAY_AGENT_GIT_REMOTE
# - MONDAY_AGENT_PREPARED_BRANCH
# - MONDAY_AGENT_PREPARED_HEAD_SHA
MONDAY_AGENT_COMMAND='$HOME/.local/bin/cursor-agent --print --trust --mode plan --resume "$MONDAY_AGENT_CHAT_ID" --workspace "/home/sasa/Documents/projects/style-mimic-kit-48" "Read $MONDAY_AGENT_PROMPT_FILE and $MONDAY_AGENT_CONTEXT_FILE. Inspect the triggered ticket and propose an implementation plan."'
EOF
```

## 2) Start bridge

```bash
npm run monday:bridge
```

For a seamless one-command startup (bridge + ngrok + printed webhook URL), use:

```bash
npm run monday:automation:start
```

Preflight only:

```bash
npm run monday:automation:check
```

Stop stale or running bridge/tunnel processes:

```bash
npm run monday:automation:stop
```

Default endpoints:

- Webhook: `http://127.0.0.1:8787/monday/webhook`
- Health: `http://127.0.0.1:8787/healthz`

## 3) Expose local endpoint to monday

monday cloud must reach your local bridge. Use a tunnel (for example `ngrok`):

```bash
ngrok http 8787
```

Then use webhook URL like:

```text
https://<your-ngrok-subdomain>.ngrok.app/monday/webhook?key=<MONDAY_WEBHOOK_SECRET>
```

## 4) Configure monday automation

Preferred flow when your monday UI does not expose a webhook action:

- Keep `MONDAY_WEBHOOK_AUTO_REGISTER="true"`.
- Launcher will re-register webhook with the current ngrok URL each startup.
- Managed webhook IDs are tracked in `artifacts/monday-automation/managed-webhooks.json`.

In monday board automation:

- **When** status changes to `AI Work in progress`
- **Then** send webhook to your bridge URL

The bridge also performs its own status verification, so it remains safe even if board automations expand later.

## User-scoped filtering options

You can isolate to only your tickets using one or both:

1. **Assignee filter (recommended)**  
   Set `MONDAY_ASSIGNEE_USER_IDS` to your monday user ID(s).

2. **Custom key filter (extra guardrail)**  
   Add a board text column (for example `cursor_owner_key`) and set unique per-user values.  
   Configure:
   - `MONDAY_ROUTING_KEY_COLUMN_ID`
   - `MONDAY_ROUTING_KEY`

Only tickets matching all configured filters are dispatched.

## Special rules + agent spawn flow

Default trigger command now uses:

```bash
node scripts/monday-agent-intake.js --item-id "$MONDAY_TRIGGER_ITEM_ID" --dispatch
```

That script:

1. fetches the full ticket details from monday
2. creates two files under `artifacts/monday-agent-intake/`:
   - `*.prompt.md` (agent prompt with strict rules and required output)
   - `*.context.json` (structured ticket context)
3. proposes deterministic branch candidate:
   - default: `<MONDAY_AGENT_BRANCH_PREFIX>/<slug>`
4. on dispatch, prepares git state from base branch (default `acceptance`) and checks out target with `git checkout -B <branchCandidate>`
5. creates a fresh Cursor chat session and runs `MONDAY_AGENT_COMMAND` with context env vars

This is where you enforce your "special rules" for this flow (rules file + output contract).

## CLI flags (optional)

```bash
node scripts/monday-webhook-bridge.js \
  --port 8787 \
  --host 127.0.0.1 \
  --path /monday/webhook \
  --trigger-status "AI Work in progress" \
  --assignee-user-ids "12345678" \
  --routing-key-column-id "cursor_owner_key" \
  --routing-key "sasa-local"
```

## Notes

- Mutations are not done by this bridge; it only reads monday and runs your local command.
- Duplicate webhook events are de-duplicated for a short window (`MONDAY_DEDUPE_SECONDS`, default `120`).
- Single-ticket mode is enabled by default (`MONDAY_SINGLE_TICKET_MODE=true`) to prevent concurrent multi-ticket dispatch confusion in v1.
- Use `MONDAY_BRIDGE_DRY_RUN=true` to test matching/filters without running the command.
