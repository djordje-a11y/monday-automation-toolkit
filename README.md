# Monday Automation Toolkit

Local standalone toolkit for monday -> local agent automation, reusable across any git workspace.

## What this solves

- Keeps automation code outside product repos.
- Uses a stable handoff path for Cursor `@`:
  - `.monday/handoffs/<branch-flat>.agent-handoff.md`
- Keeps generated files untracked via workspace-local `.git/info/exclude`.

## Commands

```bash
monday-auto init --workspace /path/to/repo
monday-auto check --workspace /path/to/repo
monday-auto start --workspace /path/to/repo
monday-auto stop --workspace /path/to/repo
```

Optional direct commands:

```bash
monday-auto bridge --workspace /path/to/repo
monday-auto intake --workspace /path/to/repo --item-id 123 --dispatch
```

## One-time setup

From toolkit root:

```bash
cd /path/to/monday-automation-toolkit
npm link
```

Initialize a target workspace (adds local ignore entries and local folders):

```bash
monday-auto init --workspace /path/to/repo
```

Creates:

- `/path/to/repo/.monday/handoffs`
- `/path/to/repo/.monday/intake`

And appends to `/path/to/repo/.git/info/exclude`:

- `.monday/`
- `.monday.local`

## Workspace config

In each target repo, create `.monday.local` with your monday token and workflow config.

Typical trigger command:

```bash
MONDAY_ON_MATCH_COMMAND='node "/path/to/monday-automation-toolkit/scripts/monday-agent-intake.js" --item-id "$MONDAY_TRIGGER_ITEM_ID" --dispatch'
```

If `MONDAY_ON_MATCH_COMMAND` is omitted, the bridge defaults to the same toolkit intake command automatically.

## Handoff file location

By default intake writes:

- `.monday/intake/<item>-<slug>-<timestamp>.prompt.md`
- `.monday/intake/<item>-<slug>-<timestamp>.context.json`
- `.monday/handoffs/<branch-flat>.agent-handoff.md`

Use in Cursor Agent chat:

```text
@.monday/handoffs/<branch-flat>.agent-handoff.md
```

## Notes

- `start` reuses healthy existing bridge/tunnel processes.
- `stop` cleans stale bridge/tunnel processes using runtime PIDs first, then process discovery fallback.
