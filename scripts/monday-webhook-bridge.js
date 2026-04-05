#!/usr/bin/env node
/**
 * Monday webhook bridge for local Cursor workflows.
 *
 * Purpose:
 * - Receive monday.com webhook events for status changes.
 * - Re-fetch item state from monday API for deterministic filtering.
 * - Trigger a local command only when filters match.
 *
 * Main filters:
 * - Status label (default: "AI Work in progress")
 * - Assignee user IDs (optional)
 * - Custom routing key column + expected value (optional)
 *
 * Security:
 * - Supports webhook secret validation via query/header.
 * - Dry-run mode supported for safe verification.
 */

import http from 'http';
import process from 'process';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const TOOLKIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveWorkspaceFromArgv(argv = process.argv, envWorkspace = '') {
  const envCandidate = String(envWorkspace || '').trim();
  let cliCandidate = '';

  for (let i = 2; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    if (token === '--workspace') {
      const next = String(argv[i + 1] || '').trim();
      if (next && !next.startsWith('--')) cliCandidate = next;
      break;
    }
    if (token.startsWith('--workspace=')) {
      cliCandidate = token.slice('--workspace='.length).trim();
      break;
    }
  }

  const selected = cliCandidate || envCandidate;
  if (!selected) return process.cwd();
  return path.isAbsolute(selected) ? selected : path.resolve(process.cwd(), selected);
}

const SELECTED_WORKSPACE = resolveWorkspaceFromArgv(
  process.argv,
  process.env.MONDAY_TOOLKIT_WORKSPACE || process.env.MONDAY_WORKSPACE || '',
);
try {
  process.chdir(SELECTED_WORKSPACE);
} catch (error) {
  throw new Error(`Workspace path is not accessible: ${SELECTED_WORKSPACE}`);
}

const DEFAULT_API_URL = 'https://api.monday.com/v2';
const DEFAULT_API_VERSION = '2025-04';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const DEFAULT_WEBHOOK_PATH = '/monday/webhook';
const DEFAULT_HEALTH_PATH = '/healthz';
const DEFAULT_STATUS_COLUMN_ID = 'status';
const DEFAULT_TRIGGER_STATUS = 'AI Work in progress';
const DEFAULT_ON_MATCH_COMMAND = `node "${path.resolve(
  TOOLKIT_ROOT,
  'scripts/monday-agent-intake.js',
)}" --item-id "$MONDAY_TRIGGER_ITEM_ID" --dispatch`;
const DEFAULT_DEDUPE_SECONDS = 120;
const DEFAULT_SINGLE_TICKET_MODE = true;
const DEFAULT_LOCAL_ENV_FILES = ['.monday.local', '.env.local', 'scripts/.monday.local'];

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

const dedupeMap = new Map();
let dispatchChain = Promise.resolve();
let dispatchQueueDepth = 0;
let dispatchInFlight = false;
let dispatchActiveItemId = '';
let dispatchStartedAt = '';

function print(message, color = '') {
  // eslint-disable-next-line no-console
  console.log(`${color}${message}${colors.reset}`);
}

function fail(message) {
  throw new Error(message);
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (Number.isNaN(parsed)) return fallback;
  return parsed;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = normalize(value);
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
}

function parseArgs(argv = process.argv) {
  const args = { _: [] };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }

    const eqIndex = token.indexOf('=');
    if (eqIndex > 2) {
      const key = token.slice(2, eqIndex);
      const value = token.slice(eqIndex + 1);
      args[key] = value;
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    const isFlag = !next || next.startsWith('--');
    if (isFlag) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i += 1;
  }

  return args;
}

function getOptionalArg(args, key, fallback = '') {
  const value = String(args[key] || '').trim();
  return value || fallback;
}

function stripOptionalQuotes(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1).replace(/\\n/g, '\n');
  return raw.replace(/\s+#.*$/, '').trim();
}

function parseEnvText(content) {
  const entries = {};
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const normalizedLine = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eqIndex = normalizedLine.indexOf('=');
    if (eqIndex <= 0) continue;

    const key = normalizedLine.slice(0, eqIndex).trim();
    const value = normalizedLine.slice(eqIndex + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    entries[key] = stripOptionalQuotes(value);
  }
  return entries;
}

function resolveEnvFileCandidate(rawPath) {
  const normalizedPath = String(rawPath || '').trim();
  if (!normalizedPath) return '';
  if (path.isAbsolute(normalizedPath)) return normalizedPath;
  return path.resolve(process.cwd(), normalizedPath);
}

function uniqueNonEmpty(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function resolveEnvFileCandidates(args) {
  const explicit = resolveEnvFileCandidate(getOptionalArg(args, 'env-file'));
  const fromEnv = resolveEnvFileCandidate(process.env.MONDAY_ENV_FILE);
  const defaults = DEFAULT_LOCAL_ENV_FILES.map((candidate) => resolveEnvFileCandidate(candidate));
  const fromHome = resolveEnvFileCandidate(
    process.env.HOME ? path.join(process.env.HOME, '.config', 'meetric', 'monday.env') : '',
  );
  return uniqueNonEmpty([explicit, fromEnv, ...defaults, fromHome]);
}

async function loadMondayEnvValues(args) {
  const candidates = resolveEnvFileCandidates(args);
  const keys = [
    'MONDAY_API_TOKEN',
    'MONDAY_API_URL',
    'MONDAY_API_VERSION',
    'MONDAY_WEBHOOK_SECRET',
    'MONDAY_BOARD_ID',
    'MONDAY_ALLOWED_BOARD_IDS',
    'MONDAY_TRIGGER_STATUS',
    'MONDAY_STATUS_COLUMN_ID',
    'MONDAY_ASSIGNEE_COLUMN_ID',
    'MONDAY_ASSIGNEE_USER_IDS',
    'MONDAY_ROUTING_KEY_COLUMN_ID',
    'MONDAY_ROUTING_KEY',
    'MONDAY_ON_MATCH_COMMAND',
    'MONDAY_WEBHOOK_PORT',
    'MONDAY_WEBHOOK_HOST',
    'MONDAY_WEBHOOK_PATH',
    'MONDAY_HEALTH_PATH',
    'MONDAY_BRIDGE_DRY_RUN',
    'MONDAY_ALLOW_EMPTY_SECRET',
    'MONDAY_DEDUPE_SECONDS',
    'MONDAY_SINGLE_TICKET_MODE',
  ];

  const values = {};
  let source = '';
  for (const candidate of candidates) {
    let fileContent = '';
    try {
      fileContent = await fs.readFile(candidate, 'utf8');
    } catch {
      continue;
    }

    const parsed = parseEnvText(fileContent);
    const hasInterestingKeys = keys.some((key) => String(parsed[key] || '').trim());
    if (!source && hasInterestingKeys) source = candidate;

    for (const key of keys) {
      if (values[key]) continue;
      const nextValue = String(parsed[key] || '').trim();
      if (!nextValue) continue;
      values[key] = nextValue;
    }
  }

  return {
    values,
    source,
    candidates,
  };
}

function parseMaybeJson(rawValue) {
  if (rawValue === null || rawValue === undefined) return null;
  if (typeof rawValue !== 'string') return rawValue;
  const trimmed = rawValue.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return rawValue;
  }
}

function safeReadPath(obj, pathExpr) {
  const pathSegments = String(pathExpr || '')
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);
  let current = obj;
  for (const segment of pathSegments) {
    if (!current || typeof current !== 'object' || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

function extractEvent(payload) {
  if (!payload || typeof payload !== 'object') return {};
  if (payload.event && typeof payload.event === 'object') return payload.event;
  return payload;
}

function extractItemId(event) {
  const candidates = [
    safeReadPath(event, 'pulseId'),
    safeReadPath(event, 'pulse_id'),
    safeReadPath(event, 'itemId'),
    safeReadPath(event, 'item_id'),
    safeReadPath(event, 'pulse.id'),
    safeReadPath(event, 'item.id'),
  ];
  const first = candidates.find((value) => String(value || '').trim());
  return String(first || '').trim();
}

function extractBoardId(event) {
  const candidates = [
    safeReadPath(event, 'boardId'),
    safeReadPath(event, 'board_id'),
    safeReadPath(event, 'board.id'),
  ];
  const first = candidates.find((value) => String(value || '').trim());
  return String(first || '').trim();
}

function extractEventColumnId(event) {
  if (!event || typeof event !== 'object') return '';
  const candidates = [
    event.columnId,
    event.column_id,
    safeReadPath(event, 'column.id'),
    safeReadPath(event, 'columnId'),
  ];
  for (const value of candidates) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function extractStatusFromEvent(event) {
  const rawValue = parseMaybeJson(event?.value);
  if (!rawValue || typeof rawValue !== 'object') return '';

  const label = rawValue.label;
  if (typeof label === 'string') return label.trim();
  if (label && typeof label === 'object') {
    const text = String(label.text || '').trim();
    if (text) return text;
  }

  const text = String(rawValue.text || '').trim();
  return text;
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function maskSecret(value) {
  const raw = String(value || '');
  if (!raw) return '';
  if (raw.length <= 8) return `${raw.slice(0, 2)}...${raw.slice(-2)}`;
  return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
}

function buildRuntimeConfig(args, envValues) {
  const token = String(
    process.env.MONDAY_API_TOKEN || envValues.MONDAY_API_TOKEN || '',
  ).trim();
  if (!token) {
    fail(
      'MONDAY_API_TOKEN is required. Set it in shell or in an ignored local env file ' +
        '(.monday.local, .env.local, scripts/.monday.local, or --env-file).',
    );
  }

  const host = getOptionalArg(
    args,
    'host',
    process.env.MONDAY_WEBHOOK_HOST || envValues.MONDAY_WEBHOOK_HOST || DEFAULT_HOST,
  );
  const port = parseInteger(
    getOptionalArg(
      args,
      'port',
      process.env.MONDAY_WEBHOOK_PORT || envValues.MONDAY_WEBHOOK_PORT || String(DEFAULT_PORT),
    ),
    DEFAULT_PORT,
  );
  if (port <= 0 || port > 65535) {
    fail(`Invalid port: ${port}`);
  }

  const webhookPath = getOptionalArg(
    args,
    'path',
    process.env.MONDAY_WEBHOOK_PATH || envValues.MONDAY_WEBHOOK_PATH || DEFAULT_WEBHOOK_PATH,
  );
  const healthPath = getOptionalArg(
    args,
    'health-path',
    process.env.MONDAY_HEALTH_PATH || envValues.MONDAY_HEALTH_PATH || DEFAULT_HEALTH_PATH,
  );

  const webhookSecret = String(
    process.env.MONDAY_WEBHOOK_SECRET || envValues.MONDAY_WEBHOOK_SECRET || '',
  ).trim();
  const allowEmptySecret = parseBoolean(
    getOptionalArg(
      args,
      'allow-empty-secret',
      process.env.MONDAY_ALLOW_EMPTY_SECRET || envValues.MONDAY_ALLOW_EMPTY_SECRET || 'false',
    ),
    false,
  );

  const dryRun = parseBoolean(
    getOptionalArg(
      args,
      'dry-run',
      process.env.MONDAY_BRIDGE_DRY_RUN || envValues.MONDAY_BRIDGE_DRY_RUN || 'false',
    ),
    false,
  );

  const allowedBoardIds = new Set(
    parseList(
      process.env.MONDAY_ALLOWED_BOARD_IDS ||
        envValues.MONDAY_ALLOWED_BOARD_IDS ||
        getOptionalArg(args, 'allowed-board-ids'),
    ),
  );
  const configuredBoardId = String(
    process.env.MONDAY_BOARD_ID || envValues.MONDAY_BOARD_ID || '',
  ).trim();
  if (configuredBoardId) allowedBoardIds.add(configuredBoardId);

  const triggerStatus = String(
    process.env.MONDAY_TRIGGER_STATUS ||
      envValues.MONDAY_TRIGGER_STATUS ||
      getOptionalArg(args, 'trigger-status', DEFAULT_TRIGGER_STATUS),
  ).trim();

  const statusColumnId = String(
    process.env.MONDAY_STATUS_COLUMN_ID ||
      envValues.MONDAY_STATUS_COLUMN_ID ||
      getOptionalArg(args, 'status-column-id', DEFAULT_STATUS_COLUMN_ID),
  ).trim();

  const assigneeColumnId = String(
    process.env.MONDAY_ASSIGNEE_COLUMN_ID ||
      envValues.MONDAY_ASSIGNEE_COLUMN_ID ||
      getOptionalArg(args, 'assignee-column-id'),
  ).trim();

  const assigneeUserIds = new Set(
    parseList(
      process.env.MONDAY_ASSIGNEE_USER_IDS ||
        envValues.MONDAY_ASSIGNEE_USER_IDS ||
        getOptionalArg(args, 'assignee-user-ids'),
    ),
  );

  const routingKeyColumnId = String(
    process.env.MONDAY_ROUTING_KEY_COLUMN_ID ||
      envValues.MONDAY_ROUTING_KEY_COLUMN_ID ||
      getOptionalArg(args, 'routing-key-column-id'),
  ).trim();
  const routingKey = String(
    process.env.MONDAY_ROUTING_KEY ||
      envValues.MONDAY_ROUTING_KEY ||
      getOptionalArg(args, 'routing-key'),
  ).trim();

  const onMatchCommand = String(
    process.env.MONDAY_ON_MATCH_COMMAND ||
      envValues.MONDAY_ON_MATCH_COMMAND ||
      getOptionalArg(args, 'on-match-command', DEFAULT_ON_MATCH_COMMAND),
  ).trim();

  const dedupeSeconds = parseInteger(
    getOptionalArg(
      args,
      'dedupe-seconds',
      process.env.MONDAY_DEDUPE_SECONDS || envValues.MONDAY_DEDUPE_SECONDS || String(DEFAULT_DEDUPE_SECONDS),
    ),
    DEFAULT_DEDUPE_SECONDS,
  );
  const singleTicketMode = parseBoolean(
    getOptionalArg(
      args,
      'single-ticket-mode',
      process.env.MONDAY_SINGLE_TICKET_MODE ||
        envValues.MONDAY_SINGLE_TICKET_MODE ||
        String(DEFAULT_SINGLE_TICKET_MODE),
    ),
    DEFAULT_SINGLE_TICKET_MODE,
  );

  return {
    token,
    apiUrl: String(process.env.MONDAY_API_URL || envValues.MONDAY_API_URL || DEFAULT_API_URL).replace(/\/$/, ''),
    apiVersion: String(process.env.MONDAY_API_VERSION || envValues.MONDAY_API_VERSION || DEFAULT_API_VERSION).trim(),
    host,
    port,
    webhookPath: webhookPath.startsWith('/') ? webhookPath : `/${webhookPath}`,
    healthPath: healthPath.startsWith('/') ? healthPath : `/${healthPath}`,
    webhookSecret,
    allowEmptySecret,
    dryRun,
    allowedBoardIds,
    triggerStatus,
    statusColumnId,
    assigneeColumnId,
    assigneeUserIds,
    routingKeyColumnId,
    routingKey,
    onMatchCommand,
    dedupeWindowMs: Math.max(dedupeSeconds, 0) * 1000,
    singleTicketMode,
  };
}

async function mondayRequest(config, query, variables = {}) {
  const response = await fetch(config.apiUrl, {
    method: 'POST',
    headers: {
      Authorization: config.token,
      'Content-Type': 'application/json',
      'API-Version': config.apiVersion,
    },
    body: JSON.stringify({ query, variables }),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.error_message || payload?.message || `HTTP ${response.status}`;
    fail(`monday API request failed: ${String(message).slice(0, 300)}`);
  }

  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    const message = payload.errors[0]?.message || JSON.stringify(payload.errors[0]);
    fail(`monday GraphQL error: ${String(message).slice(0, 300)}`);
  }

  return payload?.data;
}

async function fetchItemDetails(config, itemId) {
  const query = `
    query ItemById($itemIds: [ID!]) {
      items(ids: $itemIds) {
        id
        name
        updated_at
        board {
          id
          name
        }
        column_values {
          id
          type
          text
          value
        }
      }
    }
  `;

  const data = await mondayRequest(config, query, {
    itemIds: [String(itemId)],
  });

  const item = Array.isArray(data?.items) ? data.items[0] : null;
  if (!item) fail(`Item not found for webhook event: ${itemId}`);
  return item;
}

function findColumn(item, columnId) {
  if (!columnId) return null;
  const values = Array.isArray(item?.column_values) ? item.column_values : [];
  return values.find((column) => String(column?.id || '').trim() === columnId) || null;
}

function parsePeopleIdsFromColumn(column) {
  const value = parseMaybeJson(column?.value);
  if (!value || typeof value !== 'object') return [];
  const people = Array.isArray(value.personsAndTeams) ? value.personsAndTeams : [];
  return people
    .filter((entry) => !entry?.kind || normalize(entry.kind) === 'person')
    .map((entry) => String(entry?.id || '').trim())
    .filter(Boolean);
}

function resolveAssigneeIds(item, assigneeColumnId) {
  const values = Array.isArray(item?.column_values) ? item.column_values : [];
  const candidateColumns = assigneeColumnId
    ? values.filter((column) => String(column?.id || '').trim() === assigneeColumnId)
    : values.filter((column) => normalize(column?.type).includes('person'));

  const ids = new Set();
  for (const column of candidateColumns) {
    for (const userId of parsePeopleIdsFromColumn(column)) {
      ids.add(userId);
    }
  }
  return Array.from(ids);
}

function evaluateFilters({ config, event, item, itemId, boardId }) {
  if (!itemId) {
    return { matched: false, reason: 'No item id in webhook payload.' };
  }

  if (config.allowedBoardIds.size > 0 && boardId && !config.allowedBoardIds.has(boardId)) {
    return {
      matched: false,
      reason: `Board ${boardId} is not in MONDAY_ALLOWED_BOARD_IDS.`,
    };
  }

  const statusColumn = findColumn(item, config.statusColumnId);
  const statusFromItem = String(statusColumn?.text || '').trim();
  const statusFromEvent = extractStatusFromEvent(event);
  const effectiveStatus = statusFromItem || statusFromEvent;

  if (!effectiveStatus) {
    return {
      matched: false,
      reason: `Could not resolve status from column '${config.statusColumnId}' or webhook payload.`,
    };
  }
  if (normalize(effectiveStatus) !== normalize(config.triggerStatus)) {
    return {
      matched: false,
      reason: `Status '${effectiveStatus}' does not match trigger '${config.triggerStatus}'.`,
    };
  }

  const assignedIds = resolveAssigneeIds(item, config.assigneeColumnId);
  if (config.assigneeUserIds.size > 0) {
    const matchesAssignee = assignedIds.some((id) => config.assigneeUserIds.has(id));
    if (!matchesAssignee) {
      return {
        matched: false,
        reason: `Assignee mismatch. Item assignees=[${assignedIds.join(', ')}], expected any of [${Array.from(config.assigneeUserIds).join(', ')}].`,
      };
    }
  }

  if (config.routingKey) {
    if (!config.routingKeyColumnId) {
      return {
        matched: false,
        reason: 'MONDAY_ROUTING_KEY is set but MONDAY_ROUTING_KEY_COLUMN_ID is missing.',
      };
    }

    const routingColumn = findColumn(item, config.routingKeyColumnId);
    const routingText = String(routingColumn?.text || '').trim();
    if (!routingText) {
      return {
        matched: false,
        reason: `Routing key column '${config.routingKeyColumnId}' is empty.`,
      };
    }
    if (normalize(routingText) !== normalize(config.routingKey)) {
      return {
        matched: false,
        reason: `Routing key mismatch. Item='${routingText}', expected='${config.routingKey}'.`,
      };
    }
  }

  return {
    matched: true,
    reason: 'Matched all configured filters.',
    metadata: {
      effectiveStatus,
      assignedIds,
    },
  };
}

function buildDedupeKey(item, statusText) {
  const parts = [
    String(item?.id || ''),
    String(item?.board?.id || ''),
    String(statusText || ''),
    String(item?.updated_at || ''),
  ];
  return parts.join('|');
}

function shouldSkipAsDuplicate(key, dedupeWindowMs) {
  if (!key || dedupeWindowMs <= 0) return false;

  const now = Date.now();
  for (const [existingKey, timestamp] of dedupeMap.entries()) {
    if (now - timestamp > dedupeWindowMs) dedupeMap.delete(existingKey);
  }

  const previous = dedupeMap.get(key);
  if (previous && now - previous <= dedupeWindowMs) return true;

  dedupeMap.set(key, now);
  return false;
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const bodyText = Buffer.concat(chunks).toString('utf8');
  if (!bodyText.trim()) return {};
  try {
    return JSON.parse(bodyText);
  } catch {
    fail('Invalid JSON payload.');
  }
}

function extractSecretCandidates(req, urlObj) {
  const authorizationHeader = String(req.headers.authorization || '').trim();
  const bearerMatch = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  const bearerToken = bearerMatch ? String(bearerMatch[1] || '').trim() : '';

  return [
    String(urlObj.searchParams.get('key') || '').trim(),
    String(urlObj.searchParams.get('token') || '').trim(),
    String(req.headers['x-monday-webhook-secret'] || '').trim(),
    String(req.headers['x-webhook-key'] || '').trim(),
    bearerToken,
  ].filter(Boolean);
}

function hasValidWebhookSecret(req, urlObj, config) {
  if (!config.webhookSecret) return config.allowEmptySecret;
  const candidates = extractSecretCandidates(req, urlObj);
  return candidates.some((candidate) => timingSafeEqualString(candidate, config.webhookSecret));
}

function buildBusyReason() {
  if (dispatchInFlight) {
    const itemInfo = dispatchActiveItemId ? `item ${dispatchActiveItemId}` : 'another item';
    const startedInfo = dispatchStartedAt ? ` (started ${dispatchStartedAt})` : '';
    return `Single-ticket mode is active; dispatch already running for ${itemInfo}${startedInfo}.`;
  }
  if (dispatchQueueDepth > 0) {
    return `Single-ticket mode is active; dispatch queue already contains ${dispatchQueueDepth} pending job(s).`;
  }
  return 'Single-ticket mode is active; another ticket is already being processed.';
}

function queueCommandExecution(config, context) {
  if (config.singleTicketMode && (dispatchInFlight || dispatchQueueDepth > 0)) {
    return {
      queued: false,
      reason: buildBusyReason(),
    };
  }

  dispatchQueueDepth += 1;
  dispatchChain = dispatchChain
    .then(async () => {
      dispatchQueueDepth = Math.max(0, dispatchQueueDepth - 1);
      dispatchInFlight = true;
      dispatchActiveItemId = String(context?.item?.id || '');
      dispatchStartedAt = new Date().toISOString();
      try {
        await executeOnMatchCommand(config, context);
      } finally {
        dispatchInFlight = false;
        dispatchActiveItemId = '';
        dispatchStartedAt = '';
      }
    })
    .catch((error) => {
      dispatchInFlight = false;
      dispatchActiveItemId = '';
      dispatchStartedAt = '';
      print(`Dispatch error: ${error?.message || String(error)}`, colors.red);
    });

  return {
    queued: true,
    reason: 'Queued local command dispatch.',
  };
}

function executeOnMatchCommand(config, context) {
  const command = String(config.onMatchCommand || '').trim();
  if (!command) {
    print('No MONDAY_ON_MATCH_COMMAND configured; skipping command dispatch.', colors.yellow);
    return Promise.resolve();
  }

  const env = {
    ...process.env,
    MONDAY_TRIGGER_ITEM_ID: String(context.item.id || ''),
    MONDAY_TRIGGER_ITEM_NAME: String(context.item.name || ''),
    MONDAY_TRIGGER_BOARD_ID: String(context.item?.board?.id || context.boardId || ''),
    MONDAY_TRIGGER_BOARD_NAME: String(context.item?.board?.name || ''),
    MONDAY_TRIGGER_STATUS: String(context.statusText || ''),
  };

  if (config.dryRun) {
    print(`[dry-run] Would run command: ${command}`, colors.yellow);
    return Promise.resolve();
  }

  print(`Running command: ${command}`, colors.cyan);

  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        print(`Command exited by signal: ${signal}`, colors.red);
      } else if (code === 0) {
        print('Command finished successfully.', colors.green);
      } else {
        print(`Command failed with exit code: ${code}`, colors.red);
      }
      resolve();
    });

    child.on('error', (error) => {
      print(`Failed to start command: ${error?.message || String(error)}`, colors.red);
      resolve();
    });
  });
}

function printUsage() {
  print('');
  print('Monday webhook bridge', colors.cyan);
  print('');
  print('Usage:');
  print('  node scripts/monday-webhook-bridge.js [--port 8787] [--host 127.0.0.1] [--path /monday/webhook]');
  print('');
  print('Optional flags:');
  print('  --workspace <path>');
  print('  --env-file <path>');
  print('  --trigger-status "<label>"');
  print('  --status-column-id <id>');
  print('  --assignee-column-id <id>');
  print('  --assignee-user-ids 123,456');
  print('  --routing-key-column-id <id>');
  print('  --routing-key "<value>"');
  print('  --on-match-command "<shell command>"');
  print('  --allowed-board-ids 111,222');
  print('  --dry-run true|false');
  print('  --allow-empty-secret true|false');
  print('  --single-ticket-mode true|false');
  print('');
  print('Environment variables (preferred):');
  print('  MONDAY_API_TOKEN (required)');
  print('  MONDAY_WEBHOOK_SECRET (recommended)');
  print('  MONDAY_TRIGGER_STATUS, MONDAY_STATUS_COLUMN_ID');
  print('  MONDAY_ASSIGNEE_USER_IDS, MONDAY_ASSIGNEE_COLUMN_ID');
  print('  MONDAY_ROUTING_KEY, MONDAY_ROUTING_KEY_COLUMN_ID');
  print('  MONDAY_ON_MATCH_COMMAND');
  print('  MONDAY_SINGLE_TICKET_MODE');
  print('');
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help || args.h || args._[0] === 'help') {
    printUsage();
    return 0;
  }

  const loadedEnv = await loadMondayEnvValues(args);
  const config = buildRuntimeConfig(args, loadedEnv.values);

  print(`monday token: ${maskSecret(config.token)} (masked)`, colors.dim);
  print(`workspace: ${process.cwd()}`, colors.dim);
  if (loadedEnv.source) {
    print(`monday env source: ${loadedEnv.source}`, colors.dim);
  }
  print(`api: ${config.apiUrl} (version ${config.apiVersion})`, colors.dim);
  print(`listen: http://${config.host}:${config.port}${config.webhookPath}`, colors.dim);
  print(`health: http://${config.host}:${config.port}${config.healthPath}`, colors.dim);
  print(`trigger status: ${config.triggerStatus} (column: ${config.statusColumnId})`, colors.dim);
  if (config.assigneeUserIds.size > 0) {
    print(
      `assignee filter: [${Array.from(config.assigneeUserIds).join(', ')}]` +
        (config.assigneeColumnId ? ` (column: ${config.assigneeColumnId})` : ' (auto-detect person column)'),
      colors.dim,
    );
  }
  if (config.routingKey) {
    print(`routing key filter: '${config.routingKey}' (column: ${config.routingKeyColumnId || '(missing)'})`, colors.dim);
  }
  print(`on-match command: ${config.onMatchCommand}`, colors.dim);
  print(`single-ticket mode: ${config.singleTicketMode ? 'ENABLED' : 'DISABLED'}`, colors.dim);
  print(`mode: ${config.dryRun ? 'DRY-RUN' : 'APPLY'}`, config.dryRun ? colors.yellow : colors.green);
  if (config.webhookSecret) {
    print(`webhook secret: ${maskSecret(config.webhookSecret)} (masked)`, colors.dim);
  } else if (!config.allowEmptySecret) {
    print('webhook secret: MISSING (set MONDAY_WEBHOOK_SECRET or allow empty explicitly)', colors.yellow);
  } else {
    print('webhook secret: empty (allowed by MONDAY_ALLOW_EMPTY_SECRET=true)', colors.yellow);
  }

  const server = http.createServer(async (req, res) => {
    const method = String(req.method || 'GET').toUpperCase();
    const urlObj = new URL(req.url || '/', `http://${req.headers.host || `${config.host}:${config.port}`}`);

    if (method === 'GET' && urlObj.pathname === config.healthPath) {
      sendJson(res, 200, { ok: true, status: 'healthy' });
      return;
    }

    if (method !== 'POST' || urlObj.pathname !== config.webhookPath) {
      sendJson(res, 404, { ok: false, error: 'Not found' });
      return;
    }

    if (!hasValidWebhookSecret(req, urlObj, config)) {
      sendJson(res, 401, { ok: false, error: 'Invalid webhook secret' });
      return;
    }

    let payload = {};
    try {
      payload = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error?.message || 'Invalid JSON body' });
      return;
    }

    if (payload?.challenge) {
      sendJson(res, 200, { challenge: payload.challenge });
      return;
    }

    const event = extractEvent(payload);
    const itemId = extractItemId(event);
    const boardIdFromEvent = extractBoardId(event);
    const eventColumnId = extractEventColumnId(event);
    const eventType = String(event?.type || payload?.type || '').trim();

    print(
      `Webhook received: pulseId=${itemId || '(none)'} boardId=${boardIdFromEvent || '(none)'} ` +
        `columnId=${eventColumnId || '(unset)'} type=${eventType || '(unset)'}`,
      colors.dim,
    );

    if (!itemId) {
      sendJson(res, 202, {
        ok: true,
        matched: false,
        reason: 'No item id in event payload',
      });
      return;
    }

    if (
      eventColumnId &&
      normalize(eventColumnId) !== normalize(config.statusColumnId)
    ) {
      const reason = `Column '${eventColumnId}' is not the status trigger column '${config.statusColumnId}'.`;
      print(`Ignored item ${itemId}: ${reason}`, colors.dim);
      sendJson(res, 202, {
        ok: true,
        matched: false,
        reason,
      });
      return;
    }

    let item = null;
    try {
      item = await fetchItemDetails(config, itemId);
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error?.message || 'Failed to fetch item details from monday',
      });
      return;
    }

    const boardId = String(item?.board?.id || boardIdFromEvent || '').trim();
    const filterResult = evaluateFilters({
      config,
      event,
      item,
      itemId,
      boardId,
    });

    if (!filterResult.matched) {
      print(`Ignored item ${itemId}: ${filterResult.reason}`, colors.dim);
      sendJson(res, 202, {
        ok: true,
        matched: false,
        reason: filterResult.reason,
      });
      return;
    }

    const statusText = filterResult.metadata?.effectiveStatus || '';
    const dedupeKey = buildDedupeKey(item, statusText);
    if (shouldSkipAsDuplicate(dedupeKey, config.dedupeWindowMs)) {
      print(`Ignored duplicate event for item ${itemId}.`, colors.dim);
      sendJson(res, 202, {
        ok: true,
        matched: false,
        reason: 'Duplicate event within dedupe window',
      });
      return;
    }

    const queueResult = queueCommandExecution(config, {
      item,
      boardId,
      statusText,
    });
    if (!queueResult.queued) {
      print(`Ignored item ${item.id} (${item.name}): ${queueResult.reason}`, colors.yellow);
      sendJson(res, 202, {
        ok: true,
        matched: false,
        reason: queueResult.reason,
        itemId: String(item.id),
        boardId,
        status: statusText,
      });
      return;
    }
    print(`Matched item ${item.id} (${item.name}) -> dispatching local command.`, colors.green);

    sendJson(res, 202, {
      ok: true,
      matched: true,
      itemId: String(item.id),
      boardId,
      status: statusText,
      singleTicketMode: config.singleTicketMode,
    });
  });

  server.listen(config.port, config.host, () => {
    print('Webhook bridge started.', colors.green);
  });

  server.on('error', (error) => {
    print(`Server error: ${error?.message || String(error)}`, colors.red);
    process.exit(1);
  });

  return new Promise(() => {});
}

main().catch((error) => {
  print(`Error: ${error?.message || String(error)}`, colors.red);
  process.exit(1);
});
