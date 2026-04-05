# Monday Automation Toolkit (Standalone)

Reusable monday -> local agent automation for any git workspace.

This toolkit is intentionally **outside product repos** and writes local runtime files under each workspace's `.monday/` folder.

## What you get

- One CLI for all operations: `monday-auto`
- Workspace-scoped execution (`--workspace /path/to/repo`)
- Stable handoff markdown path for Cursor `@`:
  - `.monday/handoffs/<branch-flat>.agent-handoff.md`
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

## Commands

```bash
monday-auto init   --workspace /path/to/repo
monday-auto check  --workspace /path/to/repo
monday-auto start  --workspace /path/to/repo
monday-auto stop   --workspace /path/to/repo
monday-auto bridge --workspace /path/to/repo
monday-auto intake --workspace /path/to/repo --item-id 123 --dispatch
```

Always run/start/stop via `monday-auto` when validating toolkit behavior.  
If a target project still contains old `npm run monday:automation:*` scripts, do not use them.

## Generated files

Per workspace, the toolkit writes:

- `.monday/intake/<item>-<slug>-<timestamp>.prompt.md`
- `.monday/intake/<item>-<slug>-<timestamp>.context.json`
- `.monday/handoffs/<branch-flat>.agent-handoff.md`
- `.monday/runtime.json`
- `.monday/managed-webhooks.json`

In Cursor Agent chat, attach:

```text
@.monday/handoffs/<branch-flat>.agent-handoff.md
```

## Full Setup Guide

For a complete from-scratch onboarding flow (including how to find monday board/group/user/column IDs and the subitem parent-board gotcha), read:

- `SETUP_GUIDE.md`

`SETUP_GUIDE.md` also documents extended/compat `.monday.local` options for explicit override behavior.

## Additional references

- `MONDAY_AGENT_AUTOMATION_REQUIREMENTS.md`
- `MONDAY_WEBHOOK_BRIDGE.md`
- `MONDAY_AGENT_INTAKE.md`
