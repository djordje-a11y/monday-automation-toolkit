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
- Keep retrigger behavior safe:
  - `MONDAY_AGENT_HANDOFF_RETRIGGER_LATEST_ONLY=true`

## Operational commands

```bash
monday-auto check --workspace /path/to/repo
monday-auto start --workspace /path/to/repo
monday-auto stop --workspace /path/to/repo
```

## Expected trigger outcomes

After monday status changes to trigger value:

1. Bridge logs matched item and dispatch.
2. Intake prepares/switches git branch (blocked if tracked worktree is dirty).
3. Branch handoff file is written:
   - `.monday/handoffs/<branch-flat>.agent-handoff.md`
4. Stable alias file is updated:
   - `monday-handoff.md`
5. Cursor Agent can use:
   - `@monday-handoff.md`

For same-ticket retriggers:
- existing branch is reused (not reset to base)
- handoff files contain only the latest monday comment context

## Done-task closeout protocol (required)

When user confirms task is done:

1. User reviews changes and stages intended files.
2. User tells agent that changes are staged (trigger phrase: `staged push`, or equivalent).
3. Agent on staged-push intent:
   - verifies staged diff is non-empty
   - writes a meaningful commit message (fix|feat|chore + outcome + why)
   - commits staged files only (no auto-adding unrelated files)
   - uses custom signing/author commit command only when user explicitly asks for it
   - otherwise uses normal commit flow (`git commit -m "<message>"`)
4. Agent pushes branch:
   - `git push -u origin HEAD` when branch has no upstream
   - `git push origin HEAD` when upstream already exists
5. Agent posts monday update:
   - use `monday-auto reply-latest --workspace "$PWD" --item-id "<ticket-id>" --body-file "<reply-file.md>"`
   - this automatically replies to latest update, or posts top-level update if no comments exist
   - include root cause, fix summary, validation evidence, branch, commit SHA, commit URL
6. Agent sets status to `AI fix ready` after monday update.

Fast-path template:

```bash
cat > .monday/reply-latest.md <<'EOF'
Fix is implemented.

Root cause:
- ...

Fix:
- ...

Validation:
- ...

Git:
- Branch: ...
- Commit: ...
- Commit URL: ...
EOF

monday-auto reply-latest --workspace "$PWD" --item-id "<ticket-id>" --body-file ".monday/reply-latest.md"
```

Guardrails:
- Do not hardcode personal names/emails in shared rules or ticket comments.
- Do not set `AI fix ready` before push + commit URL are available.
