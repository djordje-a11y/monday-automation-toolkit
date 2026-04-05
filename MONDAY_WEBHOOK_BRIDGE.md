# Monday Webhook Bridge (Standalone Toolkit)

Bridge role:

1. Receive monday webhook event
2. Re-fetch item state from monday API
3. Validate trigger/filter rules
4. Run local command (default: toolkit intake dispatch)

Use this with:

- `SETUP_GUIDE.md` (full onboarding)
- `MONDAY_AGENT_AUTOMATION_REQUIREMENTS.md` (operator checklist)

## Run via toolkit CLI

Preferred:

```bash
monday-auto check --workspace /path/to/repo
monday-auto start --workspace /path/to/repo
```

Stop:

```bash
monday-auto stop --workspace /path/to/repo
```

Direct bridge mode (advanced/debug):

```bash
monday-auto bridge --workspace /path/to/repo
```

## Important environment keys

Set in workspace `.monday.local`:

- `MONDAY_API_TOKEN`
- `MONDAY_WEBHOOK_SECRET`
- `MONDAY_TRIGGER_STATUS`
- `MONDAY_STATUS_COLUMN_ID` (default `status`)
- `MONDAY_ASSIGNEE_USER_IDS` and/or `MONDAY_ROUTING_KEY*`
- `MONDAY_ON_MATCH_COMMAND` (optional override)
- `MONDAY_SINGLE_TICKET_MODE`

Webhook auto-register (recommended):

- `MONDAY_WEBHOOK_AUTO_REGISTER=true`
- `MONDAY_WEBHOOK_REGISTER_BOARD_IDS=<parent-board-id>`
- `MONDAY_WEBHOOK_REGISTER_SUBITEMS=true`
- `MONDAY_WEBHOOK_MANAGED_STATE_FILE=.monday/managed-webhooks.json`

## Default trigger command

If `MONDAY_ON_MATCH_COMMAND` is not set, bridge runs toolkit intake:

```bash
node "<toolkit>/scripts/monday-agent-intake.js" --item-id "$MONDAY_TRIGGER_ITEM_ID" --dispatch
```

## Default endpoints

- Webhook: `http://127.0.0.1:8787/monday/webhook`
- Health: `http://127.0.0.1:8787/healthz`

## Notes

- Bridge performs read/filter/dispatch only.
- Duplicate webhook events are deduped (`MONDAY_DEDUPE_SECONDS`, default `120`).
- Single-ticket mode defaults to enabled (`MONDAY_SINGLE_TICKET_MODE=true`).
- Set `MONDAY_BRIDGE_DRY_RUN=true` to validate filters without dispatch.
