# Requirements for Monday + Agent Automation

This checklist is for a seamless trigger flow:

`monday status change -> local bridge -> agent intake -> spawned agent`

## Required setup

1. **Configure tunnel (ngrok)**
   - Install ngrok CLI
   - Login once:
     ```bash
     ngrok config add-authtoken <YOUR_TOKEN>
     ```
   - Optional but recommended: use a static/reserved ngrok domain so your monday webhook URL stays stable.

2. **Configure local env (`.monday.local`)**
   Place file at project root:
   - `/home/sasa/Documents/projects/style-mimic-kit-48/.monday.local`

   Minimum values:
   ```bash
   MONDAY_API_TOKEN="..."
   MONDAY_WEBHOOK_SECRET="..."
   MONDAY_TRIGGER_STATUS="AI Work in progress"
   MONDAY_AGENT_COMMAND='echo "replace with your local agent runner"'
   ```

3. **Configure user scoping (recommended)**
   At least one:
   ```bash
   # Assigned-to-me filter
   MONDAY_ASSIGNEE_USER_IDS="12345678"

   # or custom routing key filter
   MONDAY_ROUTING_KEY_COLUMN_ID="cursor_owner_key"
   MONDAY_ROUTING_KEY="sasa-local"
   ```

4. **Configure webhook delivery (recommended: auto-register on startup)**
   ```bash
   MONDAY_WEBHOOK_AUTO_REGISTER="true"
   MONDAY_WEBHOOK_REGISTER_BOARD_IDS="2116143116"
   MONDAY_WEBHOOK_EVENT="change_specific_column_value"
   MONDAY_WEBHOOK_MANAGED_STATE_FILE="artifacts/monday-automation/managed-webhooks.json"
   ```
   - Each `monday:automation:start` run re-registers webhook URL with current ngrok URL.
   - This removes manual webhook URL updates when ngrok subdomain changes.
   - Keep `MONDAY_WEBHOOK_REGISTER_BOARD_IDS` on the parent board where webhook creation is allowed.
   - If your workspace supports webhook actions in UI, manual workflow setup still works as fallback.

5. **Configure section-based branch naming (optional but recommended)**
   ```bash
   MONDAY_AGENT_BRANCH_PREFIX="dev/monday"
   MONDAY_AGENT_BRANCH_PREFIX_RULES="id:group_mkx4b56t=fix,id:<EPICS_BACKLOG_GROUP_ID>=feat,bugs=fix,epics backlog=feat"
   MONDAY_AGENT_BRANCH_INCLUDE_TICKET_ID="false"
   ```
   - Rule priority: section ID match first, then section title match.
   - If section matches `Bugs`, branch prefix resolves to `fix`.
   - If section matches `Epics Backlog`, branch prefix resolves to `feat`.
   - Otherwise fallback prefix is `MONDAY_AGENT_BRANCH_PREFIX`.

6. **Configure git + chat dispatch hardening (recommended)**
   ```bash
   MONDAY_AGENT_GIT_PREPARE_BRANCH="true"
   MONDAY_AGENT_GIT_BASE_BRANCH="acceptance"
   MONDAY_AGENT_GIT_REMOTE="origin"
   MONDAY_AGENT_GIT_REQUIRE_CLEAN_WORKTREE="true"
   MONDAY_AGENT_CREATE_CHAT="true"
   MONDAY_AGENT_CREATE_CHAT_COMMAND='$HOME/.local/bin/cursor-agent create-chat'
   MONDAY_AGENT_COMMAND='$HOME/.local/bin/cursor-agent --print --trust --mode plan --resume "$MONDAY_AGENT_CHAT_ID" --workspace "/home/sasa/Documents/projects/style-mimic-kit-48" "Read $MONDAY_AGENT_PROMPT_FILE and $MONDAY_AGENT_CONTEXT_FILE. Inspect the triggered ticket and propose an implementation plan."'
   ```
   - On trigger dispatch, intake ensures local `acceptance` matches `origin/acceptance`.
   - Then it creates/switches target branch using `git checkout -B <branchCandidate>`.
   - A fresh Cursor chat ID is created and passed as `MONDAY_AGENT_CHAT_ID`.

7. **Enable single-ticket processing guard for v1**
   ```bash
   MONDAY_SINGLE_TICKET_MODE="true"
   ```
   - While one ticket is being dispatched/running, new matched webhook events are ignored with a busy reason.
   - This avoids spawning multiple agents and conflicting local git/branch operations in parallel.

## One-command startup

Use:

```bash
npm run monday:automation:start
```

This launcher:
- validates config
- starts webhook bridge
- starts ngrok tunnel (unless you configured a public URL)
- auto-registers managed monday webhooks (when enabled)
- prints final webhook URL to use in monday automation
- writes runtime info to `artifacts/monday-automation/runtime.json`

## Preflight validation only

```bash
npm run monday:automation:check
```

## Stop automation processes

```bash
npm run monday:automation:stop
```

This helper stops the monday bridge and ngrok tunnel for the configured bridge port. It first uses PIDs from `artifacts/monday-automation/runtime.json`, then falls back to process discovery to clean up stale/reused processes.

## Optional: avoid manual startup on each project/session

You can run `monday:automation:start` through an OS startup service (systemd user service) so tunnel + bridge come up automatically at login.
