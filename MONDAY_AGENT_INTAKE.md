# Monday Agent Intake (Standalone Toolkit)

Intake role:

1. Fetch monday item context (updates/assets/columns)
2. Propose and prepare git branch
3. Write prompt/context artifacts
4. Write stable IDE handoff markdown for Cursor `@`
5. Optionally dispatch local agent command

## Run via toolkit CLI

```bash
monday-auto intake --workspace /path/to/repo --item-id 123456789
monday-auto intake --workspace /path/to/repo --item-id 123456789 --dispatch
```

## Default output paths

- `.monday/intake/<itemId>-<slug>-<timestamp>.prompt.md`
- `.monday/intake/<itemId>-<slug>-<timestamp>.context.json`
- `.monday/handoffs/<branch-flat>.agent-handoff.md`

Handoff path is printed as:

`IDE handoff (@ this file in Cursor Agent): .monday/handoffs/...`

## Key env configuration

In workspace `.monday.local`:

```bash
MONDAY_AGENT_BRANCH_PREFIX="dev/monday"
MONDAY_AGENT_BRANCH_PREFIX_RULES="id:bugs=fix,id:epics_backlog=feat,bugs=fix,epics backlog=feat"
MONDAY_AGENT_BRANCH_INCLUDE_TICKET_ID="false"
MONDAY_AGENT_GIT_PREPARE_BRANCH="true"
MONDAY_AGENT_GIT_BASE_BRANCH="acceptance"
MONDAY_AGENT_GIT_REMOTE="origin"
MONDAY_AGENT_GIT_REQUIRE_CLEAN_WORKTREE="true"

MONDAY_AGENT_OUTPUT_DIR=".monday/intake"
MONDAY_AGENT_HANDOFF_DIR=".monday/handoffs"
MONDAY_AGENT_IDE_HANDOFF="true"
```

Dispatch-related:

```bash
MONDAY_AGENT_CREATE_CHAT="true"
MONDAY_AGENT_CREATE_CHAT_COMMAND='$HOME/.local/bin/cursor-agent create-chat'
MONDAY_AGENT_UNSET_CURSOR_API_KEY="true"
MONDAY_AGENT_COMMAND='...'
```

## Cursor IDE workflow

Use the handoff markdown in sidebar Agent chat:

```text
@.monday/handoffs/<branch-flat>.agent-handoff.md
```

This gives the agent ticket context + rules in one file, with filename tied to the prepared branch.

## Agent command env vars

Available inside `MONDAY_AGENT_COMMAND`:

- `MONDAY_AGENT_PROMPT_FILE`
- `MONDAY_AGENT_CONTEXT_FILE`
- `MONDAY_AGENT_IDE_HANDOFF_FILE`
- `MONDAY_AGENT_ITEM_ID`
- `MONDAY_AGENT_ITEM_NAME`
- `MONDAY_AGENT_BRANCH_CANDIDATE`
- `MONDAY_AGENT_CHAT_ID`
- `MONDAY_AGENT_BASE_BRANCH`
- `MONDAY_AGENT_GIT_REMOTE`
- `MONDAY_AGENT_PREPARED_BRANCH`
- `MONDAY_AGENT_PREPARED_HEAD_SHA`

## Branch rule notes

- Rule priority:
  - section ID exact match
  - section title exact/partial match
  - fallback prefix
- Parent group (`parent_item.group`) is preferred for subitem tickets.
