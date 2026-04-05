# Requirements for Monday + Agent Automation

Canonical onboarding is documented in:

- `SETUP_GUIDE.md`

This file is a compact checklist for reviewers and operators.

## Required baseline

- `monday-auto` installed (`npm link` from toolkit root)
- Workspace initialized:
  - `monday-auto init --workspace /path/to/repo`
- Workspace `.monday.local` configured with:
  - `MONDAY_API_TOKEN`
  - `MONDAY_WEBHOOK_SECRET`
  - `MONDAY_BOARD_ID`
  - `MONDAY_ALLOWED_BOARD_IDS`
  - `MONDAY_TRIGGER_STATUS`
  - `MONDAY_STATUS_COLUMN_ID`
  - `MONDAY_AGENT_COMMAND`
- ngrok authenticated (`ngrok config add-authtoken ...`)

## Recommended baseline

- Scope by assignee and/or routing key:
  - `MONDAY_ASSIGNEE_USER_IDS` and/or `MONDAY_ROUTING_KEY*`
- Auto-register webhooks:
  - `MONDAY_WEBHOOK_AUTO_REGISTER=true`
  - `MONDAY_WEBHOOK_REGISTER_BOARD_IDS=<parent-board-id>`
- Keep handoff paths predictable:
  - `MONDAY_AGENT_OUTPUT_DIR=".monday/intake"`
  - `MONDAY_AGENT_HANDOFF_DIR=".monday/handoffs"`
  - `MONDAY_AGENT_HANDOFF_ALIAS_FILE="monday-handoff.md"`
  - `MONDAY_AGENT_IDE_HANDOFF=true`
- Enforce local-only generated artifacts:
  - `MONDAY_REQUIRE_LOCAL_IGNORES=true`
- Use strict git safety:
  - `MONDAY_AGENT_GIT_PREPARE_BRANCH=true`
  - `MONDAY_AGENT_GIT_REQUIRE_CLEAN_WORKTREE=true`

## Operational commands

```bash
monday-auto check --workspace /path/to/repo
monday-auto start --workspace /path/to/repo
monday-auto stop --workspace /path/to/repo
```

## Expected trigger outcomes

After monday status changes to trigger value:

1. Bridge logs matched item and dispatch.
2. Intake prepares/switches git branch.
3. Branch-history handoff file is written:
   - `.monday/handoffs/<branch-flat>.agent-handoff.md`
4. Stable alias file is updated:
   - `monday-handoff.md`
5. Cursor Agent can use:
   - `@monday-handoff.md`
