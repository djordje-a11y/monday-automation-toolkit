# Monday Automation Setup Guide

This guide is written for first-time setup and team handoff.

Goal:

`monday status change -> local bridge -> intake -> branch switch -> handoff markdown for @ in Cursor`

## 1) Prerequisites

- Node.js (same machine where you run git and Cursor)
- Git
- `ngrok` installed and authenticated (`ngrok config add-authtoken ...`)
- `cursor-agent` installed if you want auto-dispatch to Agent CLI
- Access to monday workspace + API token

## 2) Install the toolkit CLI once

```bash
git clone https://github.com/djordje-a11y/monday-automation-toolkit.git
cd monday-automation-toolkit
npm link
```

Verify:

```bash
monday-auto
```

## 3) Initialize any target workspace

```bash
monday-auto init --workspace /path/to/your/repo
```

This creates:

- `/path/to/your/repo/.monday/handoffs`
- `/path/to/your/repo/.monday/intake`

And appends to local-only ignore file:

- `.monday/`
- `.monday.local`

in `/path/to/your/repo/.git/info/exclude`.

## 4) Gather monday IDs and secrets (important)

## 4.1 Get monday API token

Create/copy your monday API token in monday account settings.

Set it in shell while querying:

```bash
export MONDAY_API_TOKEN="paste-token-here"
```

## 4.2 Generate `MONDAY_WEBHOOK_SECRET`

Generate a strong random secret locally:

```bash
openssl rand -hex 32
```

Example of setting it directly:

```bash
export MONDAY_WEBHOOK_SECRET="$(openssl rand -hex 32)"
```

Use this same value in `.monday.local` as `MONDAY_WEBHOOK_SECRET`.

## 4.3 Get your monday user ID (for assignee filter)

```bash
curl -s https://api.monday.com/v2 \
  -H "Authorization: $MONDAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "API-Version: 2025-04" \
  -d '{"query":"query { me { id name email } }"}'
```

Use `me.id` for `MONDAY_ASSIGNEE_USER_IDS`.

## 4.4 Find board IDs

```bash
curl -s https://api.monday.com/v2 \
  -H "Authorization: $MONDAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "API-Version: 2025-04" \
  -d '{"query":"query { boards(limit: 100) { id name } }"}'
```

Use the board ID where webhooks should be registered in `MONDAY_WEBHOOK_REGISTER_BOARD_IDS`.

## 4.5 Subitem gotcha: URL may show subitem board ID only

When your ticket is a subitem, the board visible in URL is not always the parent board that should own webhook registrations.

Use item lookup to confirm parent board/group:

```bash
curl -s https://api.monday.com/v2 \
  -H "Authorization: $MONDAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "API-Version: 2025-04" \
  -d '{"query":"query { items(ids: 1234567890) { id name board { id name } parent_item { id board { id name } group { id title } } group { id title } } }"}'
```

If `parent_item.board.id` exists, prefer that for webhook registration and branch-rule group mapping.

## 4.6 Get group IDs for branch rules

```bash
curl -s https://api.monday.com/v2 \
  -H "Authorization: $MONDAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "API-Version: 2025-04" \
  -d '{"query":"query { boards(ids: 2116143116) { id name groups { id title } } }"}'
```

Use group IDs in `MONDAY_AGENT_BRANCH_PREFIX_RULES`, for example:

`id:group_mkx4b56t=fix,id:new_group=feat,bugs=fix,epics backlog=feat`

## 4.7 Get column IDs (status/person/routing key)

```bash
curl -s https://api.monday.com/v2 \
  -H "Authorization: $MONDAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "API-Version: 2025-04" \
  -d '{"query":"query { boards(ids: 2116143116) { columns { id title type } } }"}'
```

Common examples:

- status column -> `MONDAY_STATUS_COLUMN_ID` (often `status`)
- people/assignee column -> `MONDAY_ASSIGNEE_COLUMN_ID` (often `person`)
- custom text routing column -> `MONDAY_ROUTING_KEY_COLUMN_ID`

## 5) Create workspace `.monday.local`

Start from example:

```bash
cp /path/to/monday-automation-toolkit/.monday.local.example /path/to/your/repo/.monday.local
```

Edit values in `/path/to/your/repo/.monday.local`.

Minimum required values:

- `MONDAY_API_TOKEN`
- `MONDAY_WEBHOOK_SECRET`
- `MONDAY_TRIGGER_STATUS`
- `MONDAY_AGENT_COMMAND`

Strongly recommended:

- `MONDAY_ASSIGNEE_USER_IDS` (or routing key) to avoid dispatching everyone’s tasks
- `MONDAY_WEBHOOK_AUTO_REGISTER=true`
- `MONDAY_WEBHOOK_REGISTER_BOARD_IDS=<parent-board-id>`

For easy Cursor `@`:

- `MONDAY_AGENT_OUTPUT_DIR=".monday/intake"`
- `MONDAY_AGENT_HANDOFF_DIR=".monday/handoffs"`
- `MONDAY_AGENT_IDE_HANDOFF="true"`

## 6) Validate config before running

```bash
monday-auto check --workspace /path/to/your/repo
```

Fix all `FAIL` items before continuing.

## 7) Start automation

```bash
monday-auto start --workspace /path/to/your/repo
```

Expected startup output includes:

- bridge health status
- tunnel URL (or reused tunnel)
- webhook URL

## 8) Configure monday automation rule

In monday:

- **When** status changes to `AI work in progress`
- **Then** send webhook to the printed URL

If `MONDAY_WEBHOOK_AUTO_REGISTER=true` is configured correctly, startup can manage webhooks automatically.

## 9) End-to-end test expectations

After changing status to trigger value, terminal should show:

- matched item
- prepared git branch
- handoff file path

Example handoff line:

`IDE handoff (@ this file in Cursor Agent): .monday/handoffs/<branch-flat>.agent-handoff.md`

Then in Cursor Agent chat use:

```text
@.monday/handoffs/<branch-flat>.agent-handoff.md
```

The markdown contains ticket context + rules.

## 10) Stop automation

```bash
monday-auto stop --workspace /path/to/your/repo
```

Dry run option:

```bash
monday-auto stop --workspace /path/to/your/repo --dry-run
```

## Troubleshooting

- **No handoff file visible in explorer**  
  Open by path directly (`Ctrl+P`) and use `.monday/handoffs/...`. Hidden/ignored files may be collapsed in UI.

- **`EADDRINUSE` on 8787**  
  Run `monday-auto stop ...` then restart. The launcher also reuses healthy bridge/tunnel processes automatically.

- **Trigger ignored due status mismatch**  
  Verify monday status text and `MONDAY_TRIGGER_STATUS` value.

- **Auto-register webhook fails**  
  Usually wrong board ID. Confirm parent board ID for subitem flows (section 4.5).

- **No dispatch because of filters**  
  Check assignee/routing settings and IDs.

- **Git branch preparation blocked**  
  Ensure target workspace has clean tracked changes (or set `MONDAY_AGENT_GIT_REQUIRE_CLEAN_WORKTREE=false` intentionally).
