# Monday Automation Toolkit (Standalone)

Reusable monday -> local agent automation for any git workspace.

This toolkit is intentionally **outside product repos** and writes local runtime files under each workspace's `.monday/` folder.

## What you get

- One CLI for all operations: `monday-auto`
- Workspace-scoped execution (`--workspace /path/to/repo`)
- Stable easy-attach handoff alias for Cursor `@`:
  - `monday-handoff.md`
- Branch-specific handoff file:
  - `.monday/handoffs/<branch-flat>.agent-handoff.md`
- Safe retrigger behavior:
  - existing ticket branch is reused (not reset from base)
  - handoff is rewritten with latest monday comment only
- Local-only files ignored through `.git/info/exclude` (no product repo pollution)

## Quick Start

1. Install CLI once (recommended):

```bash
cd /path/to/monday-automation-toolkit
npm config set prefix "$HOME/.local" --location=user
npm link
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

If `monday-auto` is still not found, ensure `~/.local/bin` is on `PATH`:

```bash
grep -q 'HOME/.local/bin' ~/.bashrc || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

No-link fallback (works without global install):

```bash
npm --prefix /path/to/monday-automation-toolkit run monday:auto -- check --workspace /path/to/repo
```

2. Initialize a target workspace:

```bash
monday-auto init --workspace /path/to/repo
```

This also ensures local ignore entries for `.monday/`, `.monday.local`, and `monday-handoff.md`.

3. Create workspace config:

```bash
cp /path/to/monday-automation-toolkit/.monday.local.example /path/to/repo/.monday.local
```

The example file is a strict baseline profile (including board scope).

4. Validate config:

```bash
monday-auto check --workspace /path/to/repo
```

5. Start automation:

```bash
monday-auto start --workspace /path/to/repo
```

6. Stop automation:

```bash
monday-auto stop --workspace /path/to/repo
```

Important git safety note:
- Intake branch prep requires a clean tracked working tree by default (`MONDAY_AGENT_GIT_REQUIRE_CLEAN_WORKTREE=true`).
- If tracked files are dirty, branch preparation is blocked.

## Commands

```bash
monday-auto init   --workspace /path/to/repo
monday-auto check  --workspace /path/to/repo
monday-auto start  --workspace /path/to/repo
monday-auto stop   --workspace /path/to/repo
monday-auto bridge --workspace /path/to/repo
monday-auto intake --workspace /path/to/repo --item-id 123 --dispatch
monday-auto reply-latest --workspace /path/to/repo --item-id 123 --body "Fix is implemented."
```

Always run/start/stop via `monday-auto` when validating toolkit behavior.  
If a target project still contains old `npm run monday:automation:*` scripts, do not use them.

## Staged Push Closeout Flow

For done-task closeout:

1. User reviews code and stages intended files.
2. User tells agent that changes are staged.
3. On command `staged push` (or equivalent intent), agent should:
   - commit staged files only with a meaningful message (outcome + why)
   - use custom signing/author command only if user explicitly requested it; otherwise use normal `git commit -m`
   - push branch (`-u` only when upstream is missing)
   - post monday update with `monday-auto reply-latest` (reply latest, fallback top-level)
   - set status to `AI fix ready`

Detailed requirements: `MONDAY_AGENT_AUTOMATION_REQUIREMENTS.md`.

Quick template for reply body:

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

## Generated files

Per workspace, the toolkit writes:

- `.monday/intake/<item>-<slug>-<timestamp>.prompt.md`
- `.monday/intake/<item>-<slug>-<timestamp>.context.json`
- `.monday/handoffs/<branch-flat>.agent-handoff.md`
- `monday-handoff.md` (stable alias that always points to the latest handoff)
- `.monday/runtime.json`
- `.monday/managed-webhooks.json`

When the same ticket retriggers, the existing branch is reused and handoff files are rewritten to include only the latest monday comment (to minimize repeated agent input).

In Cursor Agent chat, attach the stable alias:

```text
@monday-handoff.md
```

If needed, you can still attach a specific branch handoff file from `.monday/handoffs/`.

## Full Setup Guide

For a complete from-scratch onboarding flow (including how to find monday board/group/user/column IDs and the subitem parent-board gotcha), read:

- `SETUP_GUIDE.md`

`SETUP_GUIDE.md` also documents extended/compat `.monday.local` options for explicit override behavior.

## Additional references

- `MONDAY_AGENT_AUTOMATION_REQUIREMENTS.md`
- `MONDAY_WEBHOOK_BRIDGE.md`
- `MONDAY_AGENT_INTAKE.md`
