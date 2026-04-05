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

### Option A (recommended): global `monday-auto` command

```bash
git clone https://github.com/djordje-a11y/monday-automation-toolkit.git
cd monday-automation-toolkit
npm config set prefix "$HOME/.local" --location=user
npm link
```

Verify:

```bash
monday-auto
```

If `npm link` fails with:

```text
EACCES: permission denied, mkdir '/usr/local/lib/node_modules'
```

run:

```bash
npm config set prefix "$HOME/.local" --location=user
npm config get prefix
# expected: /home/<you>/.local
npm link
```

If `monday-auto` is not found after linking, ensure `~/.local/bin` is in `PATH`:

```bash
grep -q 'HOME/.local/bin' ~/.bashrc || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

### Option B: no global link (works on locked-down machines)

From anywhere, run toolkit commands via npm script:

```bash
npm --prefix /path/to/monday-automation-toolkit run monday:auto -- check --workspace /path/to/your/repo
```

In this guide we use `monday-auto ...` for readability.  
If you use Option B, replace each command with:

```bash
npm --prefix /path/to/monday-automation-toolkit run monday:auto -- <command> [args...]
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
- `monday-handoff.md`

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

Strict baseline required values (recommended for team rollout):

- `MONDAY_API_TOKEN`
- `MONDAY_WEBHOOK_SECRET`
- `MONDAY_BOARD_ID`
- `MONDAY_ALLOWED_BOARD_IDS`
- `MONDAY_TRIGGER_STATUS`
- `MONDAY_STATUS_COLUMN_ID`
- `MONDAY_AGENT_COMMAND`
- `MONDAY_WEBHOOK_AUTO_REGISTER=true`
- `MONDAY_WEBHOOK_REGISTER_BOARD_IDS=<board-id-list>`
- `MONDAY_REQUIRE_LOCAL_IGNORES=true`

Why both board variables:

- `MONDAY_ALLOWED_BOARD_IDS` controls bridge-side filtering (which boards are accepted).
- `MONDAY_WEBHOOK_REGISTER_BOARD_IDS` controls where managed webhooks are created.
- Toolkit now also treats `MONDAY_WEBHOOK_REGISTER_BOARD_IDS` as board-scope fallback.

Strongly recommended:

- `MONDAY_ASSIGNEE_USER_IDS` (or routing key) to avoid dispatching everyone’s tasks

For easy Cursor `@`:

- `MONDAY_AGENT_OUTPUT_DIR=".monday/intake"`
- `MONDAY_AGENT_HANDOFF_DIR=".monday/handoffs"`
- `MONDAY_AGENT_HANDOFF_ALIAS_FILE="monday-handoff.md"`
- `MONDAY_AGENT_IDE_HANDOFF="true"`

### 5.1 Extended options (optional / compatibility)

`.monday.local.example` is a strict baseline profile.  
These additional options are supported when you need explicit override behavior:

- `MONDAY_ON_MATCH_COMMAND` for custom dispatch command override
- `MONDAY_AUTOMATION_RUNTIME_FILE` and `MONDAY_WEBHOOK_MANAGED_STATE_FILE` for explicit state file locations
- `MONDAY_AGENT_RULES_FILE` to load custom ticket rules text
- `MONDAY_AGENT_UNSET_CURSOR_API_KEY` to force login-session auth behavior for `cursor-agent`
- `MONDAY_AGENT_HEADLESS_PRINT` to control terminal-only output vs interactive behavior

### 5.2 Runtime flow and variable contract (exact sequence)

1. **Launcher config check (`monday-auto check/start`)**
   - Requires: `MONDAY_API_TOKEN`, `MONDAY_WEBHOOK_SECRET`, `MONDAY_AGENT_COMMAND`
   - Requires board scope: one or more of `MONDAY_ALLOWED_BOARD_IDS`, `MONDAY_BOARD_ID`, `MONDAY_WEBHOOK_REGISTER_BOARD_IDS`
   - Requires webhook target mode: tunnel enabled or `MONDAY_PUBLIC_WEBHOOK_BASE_URL`

2. **Bridge startup**
   - Bridge enforces board scope before accepting events.
   - Trigger matching uses `MONDAY_TRIGGER_STATUS` + `MONDAY_STATUS_COLUMN_ID`.
   - Optional narrowing: assignee (`MONDAY_ASSIGNEE_*`) or routing key (`MONDAY_ROUTING_KEY_*`).

3. **Webhook registration (when `MONDAY_WEBHOOK_AUTO_REGISTER=true`)**
   - Uses `MONDAY_WEBHOOK_REGISTER_BOARD_IDS` (or falls back to `MONDAY_BOARD_ID`).
   - Registers `change_specific_column_value` (with fallback) and optionally subitem webhook when `MONDAY_WEBHOOK_REGISTER_SUBITEMS=true`.

4. **Matched event dispatch**
   - Bridge runs `MONDAY_ON_MATCH_COMMAND` (default: toolkit intake).
   - Bridge exports trigger env vars (`MONDAY_TRIGGER_ITEM_ID`, board/status metadata) for intake.

5. **Intake processing**
   - Requires token + `--item-id`.
   - Writes prompt/context to `MONDAY_AGENT_OUTPUT_DIR` (default `.monday/intake`).
   - Writes branch-history handoff to `MONDAY_AGENT_HANDOFF_DIR` (default `.monday/handoffs`) when `MONDAY_AGENT_IDE_HANDOFF=true`.
   - Writes stable attach alias to `MONDAY_AGENT_HANDOFF_ALIAS_FILE` (default `monday-handoff.md`).
   - Prepares git branch using `MONDAY_AGENT_GIT_*` (defaults: `acceptance`, `origin`, clean worktree required).

6. **Agent dispatch**
   - Runs `MONDAY_AGENT_COMMAND`.
   - Injects paths via env (`MONDAY_AGENT_PROMPT_FILE`, `MONDAY_AGENT_CONTEXT_FILE`, `MONDAY_AGENT_IDE_HANDOFF_FILE`).
   - For interactive UI behavior, set `MONDAY_AGENT_HEADLESS_PRINT=false`.

## 6) Validate config before running

```bash
monday-auto check --workspace /path/to/your/repo
```

Fix all `FAIL` items before continuing.

## 7) Start automation

Use the toolkit launcher, not old project scripts:

- Use: `monday-auto start --workspace ...`
- Avoid: `npm run monday:automation:start` in product repos that still have legacy scripts

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
- branch-history handoff file path
- stable handoff alias path

Example handoff line:

`IDE handoff (@ this file in Cursor Agent): .monday/handoffs/<branch-flat>.agent-handoff.md`

Example stable alias line:

`Stable handoff alias (@ this file in Cursor Agent): monday-handoff.md`

Then in Cursor Agent chat use:

```text
@monday-handoff.md
```

The markdown contains ticket context + rules.
If needed, you can still attach a specific history file from `.monday/handoffs/`.

## 10) Stop automation

Use the toolkit launcher, not old project scripts:

- Use: `monday-auto stop --workspace ...`
- Avoid: `npm run monday:automation:stop` in product repos that still have legacy scripts

```bash
monday-auto stop --workspace /path/to/your/repo
```

Dry run option:

```bash
monday-auto stop --workspace /path/to/your/repo --dry-run
```

## Troubleshooting

- **No handoff file visible in explorer**  
  Use `@monday-handoff.md` first (repo root alias).  
  For history files, open by path directly (`Ctrl+P`) and use `.monday/handoffs/...` if hidden files are collapsed.

- **`EADDRINUSE` on 8787**  
  Run `monday-auto stop ...` then restart. The launcher also reuses healthy bridge/tunnel processes automatically.

- **Automation ran but used old `artifacts/...` paths**  
  You likely started legacy in-repo scripts. Start/stop with `monday-auto ... --workspace ...` so toolkit defaults (`.monday/...`) apply.

- **Fail: board scope is missing**  
  Set board scope explicitly with `MONDAY_ALLOWED_BOARD_IDS` and/or `MONDAY_BOARD_ID`.  
  If you use auto-register, ensure `MONDAY_WEBHOOK_REGISTER_BOARD_IDS` is also set.

- **Fail: local ignores are missing**  
  Run `monday-auto init --workspace /path/to/your/repo` to append required local excludes.
  (Or add `.monday/`, `.monday.local`, and `monday-handoff.md` in `.git/info/exclude` or `.gitignore`.)

- **`npm link` fails with `EACCES` (`/usr/local/lib/node_modules`)**  
  Configure user-scoped npm globals and retry:
  `npm config set prefix "$HOME/.local" --location=user` then `npm link`.
  If needed, add `~/.local/bin` to `PATH` and `source ~/.bashrc`.

- **Trigger ignored due status mismatch**  
  Verify monday status text and `MONDAY_TRIGGER_STATUS` value.

- **Auto-register webhook fails**  
  Usually wrong board ID. Confirm parent board ID for subitem flows (section 4.5).

- **No dispatch because of filters**  
  Check assignee/routing settings and IDs.

- **Git branch preparation blocked**  
  Ensure target workspace has clean tracked changes (or set `MONDAY_AGENT_GIT_REQUIRE_CLEAN_WORKTREE=false` intentionally).
