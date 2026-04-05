# Monday Agent Intake Dispatcher

`monday:agent-intake` prepares a ticket package for an AI agent and can immediately dispatch a command that spawns the agent.

## What it does

For a given monday item:

1. fetches full item context (`column_values`, recent `updates`, `assets`)
2. proposes a branch candidate:
   - default: `<MONDAY_AGENT_BRANCH_PREFIX>/<slug>`
   - optional legacy mode: `<MONDAY_AGENT_BRANCH_PREFIX>/<itemId>-<slug>`
3. when dispatch is enabled, prepares git branch workflow:
   - fetches `origin/<base>` (default base branch: `acceptance`)
   - checks out local base branch
   - verifies local base branch matches remote exactly
   - creates/switches target branch with `git checkout -B <branchCandidate>`
4. builds output files:
   - `artifacts/monday-agent-intake/<itemId>-<slug>-<timestamp>.prompt.md`
   - `artifacts/monday-agent-intake/<itemId>-<slug>-<timestamp>.context.json`
   - **IDE handoff (default):** `artifacts/monday-agent-intake/<branch-as-flat-name>.agent-handoff.md` — same content as the prompt, plus a short header. The flat name matches the **git branch** with `/` replaced by `-` (e.g. branch `dev/monday/fix-bug` → file `dev-monday-fix-bug.agent-handoff.md`). Re-running intake for that branch overwrites the handoff file.
5. optionally creates a fresh Cursor chat session and runs your agent command (`MONDAY_AGENT_COMMAND`)

## Command

```bash
node scripts/monday-agent-intake.js --item-id 123456789
```

Dispatch (spawn command):

```bash
node scripts/monday-agent-intake.js --item-id 123456789 --dispatch
```

## Environment

Add to `.monday.local`:

```bash
MONDAY_AGENT_RULES_FILE="scripts/templates/monday-ticket-agent-rules.md"
MONDAY_AGENT_BRANCH_PREFIX="dev/monday"
MONDAY_AGENT_BRANCH_PREFIX_RULES="id:bugs=fix,id:epics_backlog=feat,bugs=fix,epics backlog=feat"
MONDAY_AGENT_BRANCH_INCLUDE_TICKET_ID="false"
MONDAY_AGENT_OUTPUT_DIR="artifacts/monday-agent-intake"
MONDAY_AGENT_GIT_PREPARE_BRANCH="true"
MONDAY_AGENT_GIT_BASE_BRANCH="acceptance"
MONDAY_AGENT_GIT_REMOTE="origin"
MONDAY_AGENT_GIT_REQUIRE_CLEAN_WORKTREE="true"
MONDAY_AGENT_CREATE_CHAT="true"
MONDAY_AGENT_CREATE_CHAT_COMMAND='$HOME/.local/bin/cursor-agent create-chat'
MONDAY_AGENT_UNSET_CURSOR_API_KEY="true"
MONDAY_AGENT_IDE_HANDOFF="true"
```

When `MONDAY_AGENT_UNSET_CURSOR_API_KEY` is true (default), `CURSOR_API_KEY` is not passed to `cursor-agent` subprocesses so a stale env key cannot override `cursor-agent login`. Set to `false` if you rely on a valid API key in the environment only.

Set `MONDAY_AGENT_IDE_HANDOFF="false"` to skip writing the branch-keyed `.agent-handoff.md` file.

### IDE Agent handoff (sidebar chat + `@` file)

Terminal `cursor-agent` does not share history with the **Cursor IDE** Agent sidebar. For the workflow where **you** keep the real conversation in the IDE:

1. Let intake run (with or without `--dispatch`).
2. Open **Agent** in Cursor on this repo.
3. Start a new chat and attach the handoff file with `@`, using the path printed as `IDE handoff (@ this file in Cursor Agent): ...` (same as `MONDAY_AGENT_IDE_HANDOFF_FILE` when dispatch runs).

The handoff filename stays aligned with the **prepared git branch** (or branch candidate if git prep is off), so it is obvious which ticket/branch it belongs to.

### Terminal output vs visible Cursor Agent chat

`cursor-agent --print` (**headless**) streams the whole run into the terminal. It **does not** open or focus the Agent / Composer panel in the Cursor IDE, even though `create-chat` returns a real session id.

- **Default (automation-friendly):** `MONDAY_AGENT_HEADLESS_PRINT="true"` — keep `--print` in `MONDAY_AGENT_COMMAND`; read the analysis in the `monday:automation:start` terminal.
- **IDE Agent UI:** set `MONDAY_AGENT_HEADLESS_PRINT="false"`. The intake script strips `--print`, `--trust`, and `--stream-partial-output` from your command so `cursor-agent` can use the **interactive** UI. Requirements: run `monday:automation:start` from a **normal desktop terminal** (not a no-TTY environment), with Cursor installed; you may need to approve trust/prompts in the UI because `--trust` only applies with `--print`.

Manual check without Monday:

```bash
CHAT=$(cursor-agent create-chat)
cursor-agent --resume "$CHAT" --mode plan --workspace "$PWD" "Say hello in one line."
```

If that opens or attaches to the Agent UI, the same behavior applies when headless print is off.

Branch strategy notes:

- The dispatcher tries to detect section from `parent_item.group.title` (for subitems).
- It also captures section ID from `parent_item.group.id` (or item group id fallback).
- Rule priority: **section ID exact match** -> **section title exact/partial match** -> fallback prefix.
- If parent section is unavailable, it falls back to the item's own group title.
- It resolves branch prefix from `MONDAY_AGENT_BRANCH_PREFIX_RULES`.
- If no rule matches, it falls back to `MONDAY_AGENT_BRANCH_PREFIX`.

Supported rule formats:

- CSV:
  - `id:bugs=fix,id:epics_backlog=feat,bugs=fix,epics backlog=feat`
- JSON:
  - `{"id":{"bugs":"fix"},"title":{"epics backlog":"feat"}}`

Ticket ID in branch name:

- Default: `MONDAY_AGENT_BRANCH_INCLUDE_TICKET_ID=false`
- Set `true` only if you explicitly want `<itemId>-` included before slug.

To auto-spawn your local agent, define:

```bash
MONDAY_AGENT_COMMAND='$HOME/.local/bin/cursor-agent --print --trust --mode plan --resume "$MONDAY_AGENT_CHAT_ID" --workspace "/home/sasa/Documents/projects/style-mimic-kit-48" "Read $MONDAY_AGENT_PROMPT_FILE and $MONDAY_AGENT_CONTEXT_FILE. Inspect the triggered ticket and propose an implementation plan."'
```

Available env vars inside `MONDAY_AGENT_COMMAND`:

- `MONDAY_AGENT_PROMPT_FILE`
- `MONDAY_AGENT_CONTEXT_FILE`
- `MONDAY_AGENT_IDE_HANDOFF_FILE` (repo-relative path to `.agent-handoff.md`, empty if handoff disabled)
- `MONDAY_AGENT_ITEM_ID`
- `MONDAY_AGENT_ITEM_NAME`
- `MONDAY_AGENT_BRANCH_CANDIDATE`
- `MONDAY_AGENT_CHAT_ID`
- `MONDAY_AGENT_BASE_BRANCH`
- `MONDAY_AGENT_GIT_REMOTE`
- `MONDAY_AGENT_PREPARED_BRANCH`
- `MONDAY_AGENT_PREPARED_HEAD_SHA`

Git preparation notes:

- Default behavior is strict and safe for automation:
  - requires clean tracked worktree (`MONDAY_AGENT_GIT_REQUIRE_CLEAN_WORKTREE=true`)
  - fails if local base branch is ahead of remote (must match exactly)
- Disable git preparation explicitly only when needed:
  - `MONDAY_AGENT_GIT_PREPARE_BRANCH=false`

## Required output contract for spawned agent

The generated prompt requires the agent to output:

1. Ticket understanding
2. Root cause hypotheses (ordered by confidence)
3. Proposed branch name (final)
4. Proposed solution approach
5. Validation and regression checks
6. Risks / blockers / questions

## Tip

Use this as the webhook bridge command:

```bash
MONDAY_ON_MATCH_COMMAND='node scripts/monday-agent-intake.js --item-id "$MONDAY_TRIGGER_ITEM_ID" --dispatch'
```

For full automation (bridge + tunnel + webhook URL output), use:

```bash
npm run monday:automation:start
```
