#!/usr/bin/env node
/**
 * monday automation launcher
 *
 * Goal:
 * - start monday webhook bridge
 * - start tunnel (ngrok by default) if needed
 * - print final webhook URL and requirements checklist
 *
 * This removes the need to manually run multiple commands each session.
 */

import process from 'process';
import fs from 'fs/promises';
import path from 'path';
import net from 'net';
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

const DEFAULT_LOCAL_ENV_FILES = ['.monday.local', '.env.local', 'scripts/.monday.local'];
const DEFAULT_BRIDGE_PORT = 8787;
const DEFAULT_BRIDGE_HOST = '127.0.0.1';
const DEFAULT_BRIDGE_PATH = '/monday/webhook';
const DEFAULT_HEALTH_PATH = '/healthz';
const DEFAULT_API_URL = 'https://api.monday.com/v2';
const DEFAULT_API_VERSION = '2025-04';
const DEFAULT_TUNNEL_API_URL = 'http://127.0.0.1:4040/api/tunnels';
const DEFAULT_TUNNEL_COMMAND = 'ngrok http {PORT}';
const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
const DEFAULT_RUNTIME_FILE = '.monday/runtime.json';
const DEFAULT_WEBHOOK_AUTO_REGISTER = true;
const DEFAULT_WEBHOOK_EVENT = 'change_specific_column_value';
const DEFAULT_WEBHOOK_REGISTER_SUBITEMS = true;
const SUBITEM_WEBHOOK_EVENT = 'change_subitem_column_value';
const DEFAULT_STATUS_COLUMN_ID = 'status';
const DEFAULT_MANAGED_WEBHOOK_STATE_FILE = '.monday/managed-webhooks.json';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

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

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = normalize(value);
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (Number.isNaN(parsed)) return fallback;
  return parsed;
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
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue || seen.has(normalizedValue)) continue;
    seen.add(normalizedValue);
    out.push(normalizedValue);
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
    'MONDAY_STATUS_COLUMN_ID',
    'MONDAY_WEBHOOK_PORT',
    'MONDAY_WEBHOOK_HOST',
    'MONDAY_WEBHOOK_PATH',
    'MONDAY_HEALTH_PATH',
    'MONDAY_AGENT_COMMAND',
    'MONDAY_ASSIGNEE_USER_IDS',
    'MONDAY_ROUTING_KEY',
    'MONDAY_PUBLIC_WEBHOOK_BASE_URL',
    'MONDAY_TUNNEL_ENABLED',
    'MONDAY_TUNNEL_COMMAND',
    'MONDAY_TUNNEL_API_URL',
    'MONDAY_AUTOMATION_START_TIMEOUT_MS',
    'MONDAY_AUTOMATION_RUNTIME_FILE',
    'MONDAY_WEBHOOK_AUTO_REGISTER',
    'MONDAY_WEBHOOK_REGISTER_BOARD_IDS',
    'MONDAY_WEBHOOK_EVENT',
    'MONDAY_WEBHOOK_REGISTER_SUBITEMS',
    'MONDAY_WEBHOOK_MANAGED_STATE_FILE',
    'MONDAY_ENV_FILE',
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
    const hasKeys = keys.some((key) => String(parsed[key] || '').trim());
    if (!source && hasKeys) source = candidate;

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

function maskSecret(value) {
  const raw = String(value || '');
  if (!raw) return '';
  if (raw.length <= 8) return `${raw.slice(0, 2)}...${raw.slice(-2)}`;
  return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
}

function buildRuntimeConfig(args, envValues, envFile) {
  const webhookSecret = String(
    process.env.MONDAY_WEBHOOK_SECRET || envValues.MONDAY_WEBHOOK_SECRET || '',
  ).trim();
  const token = String(
    process.env.MONDAY_API_TOKEN || envValues.MONDAY_API_TOKEN || '',
  ).trim();
  const boardId = String(
    process.env.MONDAY_BOARD_ID || envValues.MONDAY_BOARD_ID || '',
  ).trim();
  const registerBoardIdsRaw = parseList(
    getOptionalArg(
      args,
      'webhook-register-board-ids',
      process.env.MONDAY_WEBHOOK_REGISTER_BOARD_IDS ||
        envValues.MONDAY_WEBHOOK_REGISTER_BOARD_IDS ||
        '',
    ),
  );
  const registerBoardIds = registerBoardIdsRaw.length > 0
    ? registerBoardIdsRaw
    : boardId
      ? [boardId]
      : [];
  const allowedBoardIds = Array.from(
    new Set([
      ...parseList(process.env.MONDAY_ALLOWED_BOARD_IDS || envValues.MONDAY_ALLOWED_BOARD_IDS || ''),
      ...registerBoardIds,
      ...(boardId ? [boardId] : []),
    ]),
  );
  const webhookEvent = String(
    process.env.MONDAY_WEBHOOK_EVENT ||
      envValues.MONDAY_WEBHOOK_EVENT ||
      DEFAULT_WEBHOOK_EVENT,
  ).trim();

  return {
    envFile,
    token,
    webhookSecret,
    apiUrl: String(process.env.MONDAY_API_URL || envValues.MONDAY_API_URL || DEFAULT_API_URL).replace(/\/$/, ''),
    apiVersion: String(process.env.MONDAY_API_VERSION || envValues.MONDAY_API_VERSION || DEFAULT_API_VERSION).trim(),
    boardId,
    allowedBoardIds,
    statusColumnId: String(
      process.env.MONDAY_STATUS_COLUMN_ID || envValues.MONDAY_STATUS_COLUMN_ID || DEFAULT_STATUS_COLUMN_ID,
    ).trim(),
    webhookAutoRegister: parseBoolean(
      getOptionalArg(
        args,
        'webhook-auto-register',
        process.env.MONDAY_WEBHOOK_AUTO_REGISTER ||
          envValues.MONDAY_WEBHOOK_AUTO_REGISTER ||
          String(DEFAULT_WEBHOOK_AUTO_REGISTER),
      ),
      DEFAULT_WEBHOOK_AUTO_REGISTER,
    ),
    webhookRegisterBoardIds: registerBoardIds,
    webhookEvent,
    webhookManagedStateFile: getOptionalArg(
      args,
      'webhook-managed-state-file',
      process.env.MONDAY_WEBHOOK_MANAGED_STATE_FILE ||
        envValues.MONDAY_WEBHOOK_MANAGED_STATE_FILE ||
        DEFAULT_MANAGED_WEBHOOK_STATE_FILE,
    ),
    webhookRegisterSubitems: parseBoolean(
      getOptionalArg(
        args,
        'webhook-register-subitems',
        process.env.MONDAY_WEBHOOK_REGISTER_SUBITEMS ||
          envValues.MONDAY_WEBHOOK_REGISTER_SUBITEMS ||
          String(DEFAULT_WEBHOOK_REGISTER_SUBITEMS),
      ),
      DEFAULT_WEBHOOK_REGISTER_SUBITEMS,
    ),
    bridgeHost: getOptionalArg(
      args,
      'bridge-host',
      process.env.MONDAY_WEBHOOK_HOST || envValues.MONDAY_WEBHOOK_HOST || DEFAULT_BRIDGE_HOST,
    ),
    bridgePort: parseInteger(
      getOptionalArg(
        args,
        'bridge-port',
        process.env.MONDAY_WEBHOOK_PORT || envValues.MONDAY_WEBHOOK_PORT || String(DEFAULT_BRIDGE_PORT),
      ),
      DEFAULT_BRIDGE_PORT,
    ),
    bridgePath: getOptionalArg(
      args,
      'bridge-path',
      process.env.MONDAY_WEBHOOK_PATH || envValues.MONDAY_WEBHOOK_PATH || DEFAULT_BRIDGE_PATH,
    ),
    healthPath: getOptionalArg(
      args,
      'health-path',
      process.env.MONDAY_HEALTH_PATH || envValues.MONDAY_HEALTH_PATH || DEFAULT_HEALTH_PATH,
    ),
    tunnelEnabled: parseBoolean(
      getOptionalArg(
        args,
        'tunnel-enabled',
        process.env.MONDAY_TUNNEL_ENABLED || envValues.MONDAY_TUNNEL_ENABLED || 'true',
      ),
      true,
    ),
    tunnelCommandTemplate: getOptionalArg(
      args,
      'tunnel-command',
      process.env.MONDAY_TUNNEL_COMMAND || envValues.MONDAY_TUNNEL_COMMAND || DEFAULT_TUNNEL_COMMAND,
    ),
    tunnelApiUrl: getOptionalArg(
      args,
      'tunnel-api-url',
      process.env.MONDAY_TUNNEL_API_URL || envValues.MONDAY_TUNNEL_API_URL || DEFAULT_TUNNEL_API_URL,
    ),
    publicWebhookBaseUrl: getOptionalArg(
      args,
      'public-webhook-base-url',
      process.env.MONDAY_PUBLIC_WEBHOOK_BASE_URL || envValues.MONDAY_PUBLIC_WEBHOOK_BASE_URL || '',
    ),
    startupTimeoutMs: parseInteger(
      getOptionalArg(
        args,
        'startup-timeout-ms',
        process.env.MONDAY_AUTOMATION_START_TIMEOUT_MS ||
          envValues.MONDAY_AUTOMATION_START_TIMEOUT_MS ||
          String(DEFAULT_STARTUP_TIMEOUT_MS),
      ),
      DEFAULT_STARTUP_TIMEOUT_MS,
    ),
    runtimeFile: getOptionalArg(
      args,
      'runtime-file',
      process.env.MONDAY_AUTOMATION_RUNTIME_FILE || envValues.MONDAY_AUTOMATION_RUNTIME_FILE || DEFAULT_RUNTIME_FILE,
    ),
    checkOnly: Boolean(args.check),
    noTunnelFlag: Boolean(args['no-tunnel']),
    assigneeFilter: String(process.env.MONDAY_ASSIGNEE_USER_IDS || envValues.MONDAY_ASSIGNEE_USER_IDS || '').trim(),
    routingKeyFilter: String(process.env.MONDAY_ROUTING_KEY || envValues.MONDAY_ROUTING_KEY || '').trim(),
    agentCommand: String(process.env.MONDAY_AGENT_COMMAND || envValues.MONDAY_AGENT_COMMAND || '').trim(),
  };
}

async function commandExists(commandName) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', `command -v ${commandName} >/dev/null 2>&1`], {
      stdio: 'ignore',
    });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

function normalizePathWithSlash(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function buildTunnelCommand(template, port) {
  const source = String(template || DEFAULT_TUNNEL_COMMAND);
  return source.replaceAll('{PORT}', String(port));
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function buildBridgeHealthUrl(config) {
  return `http://${config.bridgeHost}:${config.bridgePort}${normalizePathWithSlash(config.healthPath)}`;
}

async function checkBridgeHealthOnce(config, timeoutMs = 1500) {
  const healthUrl = buildBridgeHealthUrl(config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(250, timeoutMs));
  try {
    const response = await fetch(healthUrl, { method: 'GET', signal: controller.signal });
    return {
      healthy: response.ok,
      status: response.status,
      healthUrl,
    };
  } catch {
    return {
      healthy: false,
      status: 0,
      healthUrl,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function isTcpPortInUse(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;

    const finish = (inUse) => {
      if (settled) return;
      settled = true;
      resolve(Boolean(inUse));
    };

    server.once('error', (error) => {
      if (error && (error.code === 'EADDRINUSE' || error.code === 'EACCES')) {
        finish(true);
        return;
      }
      finish(false);
    });

    server.once('listening', () => {
      server.close(() => finish(false));
    });

    server.listen(port, host);
  });
}

async function waitForBridgeHealth(config) {
  const deadline = Date.now() + config.startupTimeoutMs;
  const healthUrl = buildBridgeHealthUrl(config);

  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, { method: 'GET' });
      if (response.ok) return healthUrl;
    } catch {
      // no-op, keep waiting
    }
    await sleep(750);
  }

  fail(`Bridge did not become healthy in time: ${healthUrl}`);
}

async function waitForTunnelPublicUrl(config) {
  const deadline = Date.now() + config.startupTimeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(config.tunnelApiUrl, { method: 'GET' });
      if (!response.ok) {
        await sleep(1000);
        continue;
      }
      const payload = await response.json();
      const tunnels = Array.isArray(payload?.tunnels) ? payload.tunnels : [];
      const httpsTunnel = tunnels.find((tunnel) => String(tunnel?.public_url || '').startsWith('https://'));
      const fallbackTunnel = tunnels.find((tunnel) => String(tunnel?.public_url || '').startsWith('http://'));
      const selected = httpsTunnel || fallbackTunnel;
      if (selected?.public_url) return String(selected.public_url).replace(/\/$/, '');
    } catch {
      // no-op
    }
    await sleep(1000);
  }

  fail(
    `Could not discover tunnel public URL from ${config.tunnelApiUrl}. ` +
      'Make sure your tunnel process is running and API is reachable.',
  );
}

function normalizeTunnelAddr(addr) {
  const raw = String(addr || '').trim().toLowerCase();
  if (!raw) return '';
  try {
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      const parsed = new URL(raw);
      return `${parsed.hostname}:${parsed.port || '80'}`;
    }
  } catch {
    // fall through to raw normalization
  }
  return raw.replace(/^tcp:\/\//, '');
}

function matchesLocalPort(addr, port) {
  const normalized = normalizeTunnelAddr(addr);
  if (!normalized) return false;
  return (
    normalized === `localhost:${port}` ||
    normalized === `127.0.0.1:${port}` ||
    normalized.endsWith(`:${port}`)
  );
}

async function getExistingTunnelPublicUrl(config) {
  try {
    const response = await fetch(config.tunnelApiUrl, { method: 'GET' });
    if (!response.ok) return '';
    const payload = await response.json();
    const tunnels = Array.isArray(payload?.tunnels) ? payload.tunnels : [];
    const matching = tunnels.filter((tunnel) =>
      matchesLocalPort(tunnel?.config?.addr, config.bridgePort),
    );
    if (matching.length === 0) return '';
    const httpsTunnel = matching.find((tunnel) => String(tunnel?.public_url || '').startsWith('https://'));
    const fallback = matching.find((tunnel) => String(tunnel?.public_url || '').trim());
    return String((httpsTunnel || fallback)?.public_url || '').replace(/\/$/, '');
  } catch {
    return '';
  }
}

function prefixChildOutput(child, prefix, color = colors.dim) {
  if (child.stdout) {
    child.stdout.on('data', (chunk) => {
      const lines = String(chunk || '')
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);
      for (const line of lines) {
        print(`[${prefix}] ${line}`, color);
      }
    });
  }

  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      const lines = String(chunk || '')
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);
      for (const line of lines) {
        print(`[${prefix}] ${line}`, colors.red);
      }
    });
  }
}

function validateRequirements(config) {
  const items = [
    {
      key: 'MONDAY_API_TOKEN',
      ok: Boolean(config.token),
      required: true,
      message: config.token ? 'Configured' : 'Missing Monday API token',
    },
    {
      key: 'MONDAY_WEBHOOK_SECRET',
      ok: Boolean(config.webhookSecret),
      required: true,
      message: config.webhookSecret ? 'Configured' : 'Missing webhook secret',
    },
    {
      key: 'MONDAY_AGENT_COMMAND',
      ok: Boolean(config.agentCommand),
      required: true,
      message: config.agentCommand ? 'Configured' : 'Missing agent spawn command',
    },
    {
      key: 'BOARD_SCOPE',
      ok: config.allowedBoardIds.length > 0,
      required: true,
      message:
        config.allowedBoardIds.length > 0
          ? `Scoped boards: ${config.allowedBoardIds.join(', ')}`
          : 'No board scope configured (set MONDAY_ALLOWED_BOARD_IDS, MONDAY_BOARD_ID, or MONDAY_WEBHOOK_REGISTER_BOARD_IDS)',
    },
    {
      key: 'USER_FILTER',
      ok: Boolean(config.assigneeFilter || config.routingKeyFilter),
      required: false,
      message:
        config.assigneeFilter || config.routingKeyFilter
          ? 'Configured (assignee and/or routing key)'
          : 'Not configured (recommended: assignee or routing key filter)',
    },
    {
      key: 'TUNNEL_MODE',
      ok: Boolean(config.publicWebhookBaseUrl) || config.tunnelEnabled,
      required: true,
      message: config.publicWebhookBaseUrl
        ? `Using preconfigured public URL: ${config.publicWebhookBaseUrl}`
        : config.tunnelEnabled
          ? 'Tunnel enabled'
          : 'No tunnel and no public webhook URL configured',
    },
    {
      key: 'WEBHOOK_AUTO_REGISTER',
      ok: !config.webhookAutoRegister || config.webhookRegisterBoardIds.length > 0,
      required: config.webhookAutoRegister,
      message: config.webhookAutoRegister
        ? `Enabled (boards: ${config.webhookRegisterBoardIds.join(', ') || '(none)'})`
        : 'Disabled (manual webhook management)',
    },
  ];

  return items;
}

function printRequirementsReport(items) {
  print('');
  print('Requirements check:', colors.cyan);
  for (const item of items) {
    const ok = item.ok;
    const required = item.required;
    const marker = ok ? 'OK' : required ? 'FAIL' : 'WARN';
    const color = ok ? colors.green : required ? colors.red : colors.yellow;
    print(`- [${marker}] ${item.key}: ${item.message}`, color);
  }
  print('');
}

async function ensureRuntimeDir(runtimeFilePath) {
  const dir = path.dirname(runtimeFilePath);
  await fs.mkdir(dir, { recursive: true });
}

async function writeRuntimeFile(runtimeFilePath, payload) {
  await ensureRuntimeDir(runtimeFilePath);
  await fs.writeFile(runtimeFilePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function isSafeWebhookEventName(value) {
  return /^[a-z_]+$/i.test(String(value || '').trim());
}

function isLocalOnlyWebhookBaseUrl(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw.startsWith('http://127.0.0.1') || raw.startsWith('http://localhost');
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

async function readJsonFileSafe(filePath, fallbackValue) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

function normalizeWebhookState(rawState) {
  const entries = Array.isArray(rawState?.webhooks) ? rawState.webhooks : [];
  return entries
    .map((entry) => ({
      id: String(entry?.id || '').trim(),
      boardId: String(entry?.boardId || '').trim(),
      event: String(entry?.event || '').trim(),
      statusColumnId: String(entry?.statusColumnId || '').trim(),
    }))
    .filter((entry) => entry.id);
}

async function deleteWebhookById(config, entry) {
  const webhookId = String(entry?.id || '').trim();
  if (!webhookId) return false;

  const deleteByIdQuery = `
    mutation DeleteWebhook($id: ID!) {
      delete_webhook(id: $id) {
        id
        board_id
      }
    }
  `;
  const deleteByIdAndBoardQuery = `
    mutation DeleteWebhook($id: ID!, $boardId: ID!) {
      delete_webhook(id: $id, board_id: $boardId) {
        id
        board_id
      }
    }
  `;

  try {
    await mondayRequest(config, deleteByIdQuery, { id: webhookId });
    return true;
  } catch (firstError) {
    const boardId = String(entry?.boardId || '').trim();
    if (!boardId) throw firstError;
    await mondayRequest(config, deleteByIdAndBoardQuery, {
      id: webhookId,
      boardId,
    });
    return true;
  }
}

async function createWebhookForBoard(config, boardId, webhookUrl) {
  const safeBoardId = String(boardId || '').trim();
  if (!safeBoardId) fail('Webhook board id is required for auto-registration.');
  if (!/^\d+$/.test(safeBoardId)) {
    fail(`Invalid monday board id for webhook registration: ${safeBoardId}`);
  }
  const safeStatusColumnId = String(config.statusColumnId || DEFAULT_STATUS_COLUMN_ID).trim();
  const configJson = JSON.stringify({ columnId: safeStatusColumnId });
  const encodedUrl = JSON.stringify(String(webhookUrl || '').trim());
  const encodedConfig = JSON.stringify(configJson);
  const preferredEvent = String(config.webhookEvent || DEFAULT_WEBHOOK_EVENT).trim();
  const eventsToTry = [preferredEvent];
  if (preferredEvent === 'change_specific_column_value') {
    eventsToTry.push('change_column_value');
  }

  for (const eventName of eventsToTry) {
    if (!isSafeWebhookEventName(eventName)) {
      fail(`Invalid webhook event name: ${eventName}`);
    }

    const supportsConfig = eventName === 'change_specific_column_value';
    const configArg = supportsConfig ? `, config: ${encodedConfig}` : '';
    const createWebhookMutation = `
      mutation {
        create_webhook(
          board_id: ${safeBoardId},
          url: ${encodedUrl},
          event: ${eventName}${configArg}
        ) {
          id
          board_id
          event
          config
        }
      }
    `;

    try {
      const data = await mondayRequest(config, createWebhookMutation);
      const hook = data?.create_webhook;
      if (!hook?.id) {
        fail(`monday create_webhook returned empty id for board ${safeBoardId}.`);
      }
      return {
        id: String(hook.id),
        boardId: String(hook.board_id || safeBoardId),
        event: String(hook.event || eventName),
        statusColumnId: safeStatusColumnId,
      };
    } catch (error) {
      const message = String(error?.message || error || '');
      const isFinalAttempt = eventName === eventsToTry[eventsToTry.length - 1];
      if (isFinalAttempt) throw error;
      print(
        `Webhook registration with event '${eventName}' failed for board ${safeBoardId} (${message}). Retrying fallback event...`,
        colors.yellow,
      );
    }
  }

  fail(`Could not register webhook for board ${safeBoardId}.`);
}

async function createSubitemWebhookForBoard(config, boardId, webhookUrl) {
  const safeBoardId = String(boardId || '').trim();
  if (!safeBoardId) fail('Webhook board id is required for subitem webhook registration.');
  if (!/^\d+$/.test(safeBoardId)) {
    fail(`Invalid monday board id for subitem webhook registration: ${safeBoardId}`);
  }
  const eventName = SUBITEM_WEBHOOK_EVENT;
  if (!isSafeWebhookEventName(eventName)) {
    fail(`Invalid subitem webhook event name: ${eventName}`);
  }
  const encodedUrl = JSON.stringify(String(webhookUrl || '').trim());
  const createWebhookMutation = `
    mutation {
      create_webhook(
        board_id: ${safeBoardId},
        url: ${encodedUrl},
        event: ${eventName}
      ) {
        id
        board_id
        event
        config
      }
    }
  `;

  const data = await mondayRequest(config, createWebhookMutation);
  const hook = data?.create_webhook;
  if (!hook?.id) {
    fail(`monday create_webhook returned empty id for subitem webhook on board ${safeBoardId}.`);
  }
  return {
    id: String(hook.id),
    boardId: String(hook.board_id || safeBoardId),
    event: String(hook.event || eventName),
    statusColumnId: '',
  };
}

async function syncManagedWebhooks(config, webhookUrl) {
  if (!config.webhookAutoRegister) {
    return {
      enabled: false,
      stateFilePath: '',
      deleted: [],
      created: [],
      failedBoards: [],
    };
  }

  const boardIds = Array.isArray(config.webhookRegisterBoardIds)
    ? config.webhookRegisterBoardIds.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  if (boardIds.length === 0) {
    fail(
      'Webhook auto-registration is enabled, but no target boards are configured. ' +
        'Set MONDAY_BOARD_ID or MONDAY_WEBHOOK_REGISTER_BOARD_IDS.',
    );
  }

  const stateFilePath = path.isAbsolute(config.webhookManagedStateFile)
    ? config.webhookManagedStateFile
    : path.resolve(process.cwd(), config.webhookManagedStateFile);
  const previousState = await readJsonFileSafe(stateFilePath, { webhooks: [] });
  const previousHooks = normalizeWebhookState(previousState);

  const deleted = [];
  for (const hook of previousHooks) {
    try {
      await deleteWebhookById(config, hook);
      deleted.push(hook.id);
    } catch (error) {
      const message = String(error?.message || error || '');
      print(`Warning: failed to delete previous managed webhook ${hook.id}: ${message}`, colors.yellow);
    }
  }

  const created = [];
  const failedBoards = [];
  for (const boardId of boardIds) {
    try {
      const hook = await createWebhookForBoard(config, boardId, webhookUrl);
      created.push(hook);
      print(
        `Auto-registered webhook ${hook.id} on board ${hook.boardId} (${hook.event}).`,
        colors.green,
      );
    } catch (error) {
      const message = String(error?.message || error || '');
      failedBoards.push({ boardId, message, kind: 'primary' });
      print(`Warning: primary webhook registration failed for board ${boardId}: ${message}`, colors.yellow);
    }

    if (config.webhookRegisterSubitems) {
      try {
        const subHook = await createSubitemWebhookForBoard(config, boardId, webhookUrl);
        created.push(subHook);
        print(
          `Auto-registered subitem webhook ${subHook.id} on board ${subHook.boardId} (${subHook.event}).`,
          colors.green,
        );
      } catch (error) {
        const message = String(error?.message || error || '');
        failedBoards.push({ boardId, message, kind: 'subitem' });
        print(
          `Warning: subitem webhook registration failed for board ${boardId}: ${message}`,
          colors.yellow,
        );
      }
    }
  }

  if (created.length === 0) {
    fail(
      'Webhook auto-registration failed for all configured boards. ' +
        'No reachable webhook target was registered on monday.',
    );
  }

  await writeRuntimeFile(stateFilePath, {
    updatedAt: new Date().toISOString(),
    webhookUrl,
    webhooks: created,
  });

  return {
    enabled: true,
    stateFilePath,
    deleted,
    created,
    failedBoards,
  };
}

function printUsage() {
  print('');
  print('monday automation launcher', colors.cyan);
  print('');
  print('Usage:');
  print('  node scripts/monday-automation-start.js');
  print('  node scripts/monday-automation-start.js --check');
  print('');
  print('Options:');
  print('  --workspace <path>');
  print('  --env-file <path>');
  print('  --check');
  print('  --no-tunnel');
  print('  --bridge-host <host>');
  print('  --bridge-port <port>');
  print('  --bridge-path <path>');
  print('  --health-path <path>');
  print('  --public-webhook-base-url <url>');
  print('  --tunnel-command "<cmd with optional {PORT}>"');
  print('  --tunnel-api-url <url>');
  print('  --webhook-auto-register true|false');
  print('  --webhook-register-board-ids "2116143116,..."');
  print('  --webhook-register-subitems true|false (default true; registers change_subitem_column_value)');
  print('  --webhook-managed-state-file <path>');
  print('');
}

async function startAutomation(config) {
  const state = {
    stopping: false,
    bridgeChild: null,
    tunnelChild: null,
  };

  const bridgeScriptPath = path.resolve(TOOLKIT_ROOT, 'scripts/monday-webhook-bridge.js');
  const bridgeArgs = [bridgeScriptPath];
  if (config.envFile) {
    bridgeArgs.push('--env-file', config.envFile);
  }
  if (config.noTunnelFlag) {
    // no bridge changes required; this flag only impacts launcher tunnel behavior
  }

  const cleanupChildren = async () => {
    if (state.tunnelChild && !state.tunnelChild.killed) {
      state.tunnelChild.kill('SIGTERM');
    }
    if (state.bridgeChild && !state.bridgeChild.killed) {
      state.bridgeChild.kill('SIGTERM');
    }
  };

  const stopAll = async (exitCode = 0) => {
    if (state.stopping) return;
    state.stopping = true;
    await cleanupChildren();

    process.exit(exitCode);
  };

  process.on('SIGINT', () => {
    print('Received SIGINT, stopping automation...', colors.yellow);
    stopAll(0);
  });
  process.on('SIGTERM', () => {
    print('Received SIGTERM, stopping automation...', colors.yellow);
    stopAll(0);
  });

  let reusedExistingBridge = false;
  try {
    const probe = await checkBridgeHealthOnce(config);
    if (probe.healthy) {
      reusedExistingBridge = true;
      print(`Reusing existing bridge: ${probe.healthUrl}`, colors.green);
      print('Bridge health check passed.', colors.green);
    } else {
      const bridgePortInUse = await isTcpPortInUse(config.bridgeHost, config.bridgePort);
      if (bridgePortInUse) {
        fail(
          `Bridge port ${config.bridgeHost}:${config.bridgePort} is already in use, but ${probe.healthUrl} is not a healthy monday bridge. ` +
            'Stop the conflicting process (or change MONDAY_BRIDGE_PORT) and retry.',
        );
      }

      print('Starting monday bridge process...', colors.cyan);
      state.bridgeChild = spawn('node', bridgeArgs, {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      prefixChildOutput(state.bridgeChild, 'bridge', colors.dim);

      state.bridgeChild.on('exit', (code, signal) => {
        if (state.stopping) return;
        const status =
          signal ? `signal ${signal}` : `exit code ${code === null ? 'unknown' : String(code)}`;
        print(`Bridge process ended unexpectedly (${status}).`, colors.red);
        stopAll(1);
      });

      await waitForBridgeHealth(config);
      print('Bridge health check passed.', colors.green);
    }

    let publicBaseUrl = String(config.publicWebhookBaseUrl || '').trim().replace(/\/$/, '');
    let reusedExistingTunnel = false;
    const shouldUseTunnel = !config.noTunnelFlag && !publicBaseUrl && config.tunnelEnabled;

    if (shouldUseTunnel) {
      const existingTunnelUrl = await getExistingTunnelPublicUrl(config);
      if (existingTunnelUrl) {
        publicBaseUrl = existingTunnelUrl;
        reusedExistingTunnel = true;
        print(`Reusing existing tunnel: ${publicBaseUrl}`, colors.green);
      } else {
        const tunnelCommand = buildTunnelCommand(config.tunnelCommandTemplate, config.bridgePort);
        print(`Starting tunnel: ${tunnelCommand}`, colors.cyan);

        state.tunnelChild = spawn('bash', ['-lc', tunnelCommand], {
          cwd: process.cwd(),
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        prefixChildOutput(state.tunnelChild, 'tunnel', colors.dim);

        state.tunnelChild.on('exit', (code, signal) => {
          if (state.stopping) return;
          const status =
            signal ? `signal ${signal}` : `exit code ${code === null ? 'unknown' : String(code)}`;
          print(`Tunnel process ended unexpectedly (${status}).`, colors.red);
          stopAll(1);
        });

        publicBaseUrl = await waitForTunnelPublicUrl(config);
        print(`Tunnel public URL discovered: ${publicBaseUrl}`, colors.green);
      }
    }

    if (!publicBaseUrl) {
      publicBaseUrl = `http://${config.bridgeHost}:${config.bridgePort}`;
      print(
        `No public tunnel configured. Using local URL (${publicBaseUrl}) ` +
          'which is not reachable from monday cloud.',
        colors.yellow,
      );
    }

    const webhookPath = normalizePathWithSlash(config.bridgePath);
    const webhookUrl = `${publicBaseUrl}${webhookPath}?key=${encodeURIComponent(config.webhookSecret)}`;
    const runtimeFilePath = path.isAbsolute(config.runtimeFile)
      ? config.runtimeFile
      : path.resolve(process.cwd(), config.runtimeFile);
    let webhookSync = {
      enabled: false,
      stateFilePath: '',
      deleted: [],
      created: [],
      failedBoards: [],
      reason: 'disabled',
    };
    if (config.webhookAutoRegister && isLocalOnlyWebhookBaseUrl(publicBaseUrl)) {
      print(
        'Webhook auto-sync skipped: public webhook URL resolves to localhost/127.0.0.1 and is not reachable from monday cloud.',
        colors.yellow,
      );
      webhookSync.reason = 'local-only-url';
    } else {
      webhookSync = await syncManagedWebhooks(config, webhookUrl);
      webhookSync.reason = webhookSync.enabled ? 'active' : 'disabled';
    }

    await writeRuntimeFile(runtimeFilePath, {
      startedAt: new Date().toISOString(),
      webhookUrl,
      publicBaseUrl,
      bridge: {
        host: config.bridgeHost,
        port: config.bridgePort,
        path: webhookPath,
        healthPath: normalizePathWithSlash(config.healthPath),
        pid: state.bridgeChild?.pid || null,
        reusedExistingBridge,
      },
      tunnel: state.tunnelChild
        ? {
            enabled: true,
            apiUrl: config.tunnelApiUrl,
            commandTemplate: config.tunnelCommandTemplate,
            pid: state.tunnelChild?.pid || null,
          }
        : reusedExistingTunnel
          ? {
              enabled: true,
              apiUrl: config.tunnelApiUrl,
              commandTemplate: 'reused-existing',
              pid: null,
            }
        : {
            enabled: false,
          },
      webhookSync,
    });

    print('');
    print('Automation is ready.', colors.green);
    if (reusedExistingBridge) {
      print(
        'Bridge mode: reusing an existing bridge process on this port (this launcher will not stop that external process).',
        colors.dim,
      );
    }
    print(`Webhook URL for monday automation:\n${webhookUrl}`, colors.cyan);
    if (webhookSync.enabled) {
      print(
        `Webhook auto-sync: created ${webhookSync.created.length}, deleted ${webhookSync.deleted.length}, failed ${webhookSync.failedBoards.length}`,
        webhookSync.failedBoards.length > 0 ? colors.yellow : colors.green,
      );
      print(`Managed webhook state file: ${webhookSync.stateFilePath}`, colors.dim);
    } else {
      const reasonText = webhookSync.reason === 'local-only-url'
        ? 'skipped (local-only URL)'
        : 'disabled (manual webhook management)';
      print(`Webhook auto-sync: ${reasonText}.`, colors.yellow);
    }
    print(`Runtime info file: ${runtimeFilePath}`, colors.dim);
    print('');
    const hasManagedChildProcess = Boolean(state.bridgeChild || state.tunnelChild);
    if (hasManagedChildProcess) {
      print(
        'Keep this command running. Stop with Ctrl+C. ' +
          'To avoid manual setup each day, run this via a startup service.',
        colors.dim,
      );
    } else {
      print(
        'No local child processes were started (bridge/tunnel were reused). Exiting launcher.',
        colors.dim,
      );
    }
  } catch (error) {
    await cleanupChildren();
    throw error;
  }

  if (!state.bridgeChild && !state.tunnelChild) return;
  return new Promise(() => {});
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help || args.h || args._[0] === 'help') {
    printUsage();
    return 0;
  }

  const loadedEnv = await loadMondayEnvValues(args);
  const envFile = resolveEnvFileCandidate(getOptionalArg(args, 'env-file')) || loadedEnv.source || '';
  const config = buildRuntimeConfig(args, loadedEnv.values, envFile);

  print(`monday token: ${maskSecret(config.token)} (masked)`, colors.dim);
  print(`webhook secret: ${maskSecret(config.webhookSecret)} (masked)`, colors.dim);
  print(`workspace: ${process.cwd()}`, colors.dim);
  if (loadedEnv.source) {
    print(`monday env source: ${loadedEnv.source}`, colors.dim);
  }

  const requirements = validateRequirements(config);
  printRequirementsReport(requirements);

  const hardFailures = requirements.filter((item) => item.required && !item.ok);
  if (hardFailures.length > 0) {
    fail('Missing required automation configuration. Fix FAIL items and retry.');
  }

  const shouldUseTunnel = !config.noTunnelFlag && !config.publicWebhookBaseUrl && config.tunnelEnabled;
  if (shouldUseTunnel) {
    const tunnelCommand = buildTunnelCommand(config.tunnelCommandTemplate, config.bridgePort);
    const defaultTunnel = normalize(config.tunnelCommandTemplate) === normalize(DEFAULT_TUNNEL_COMMAND);
    if (defaultTunnel) {
      const ngrokExists = await commandExists('ngrok');
      if (!ngrokExists) {
        fail(
          "ngrok is not installed or not on PATH. Install ngrok, or set MONDAY_PUBLIC_WEBHOOK_BASE_URL, " +
            "or disable tunnel with MONDAY_TUNNEL_ENABLED=false.",
        );
      }
    }
    print(`Tunnel command: ${tunnelCommand}`, colors.dim);
  }

  if (config.checkOnly) {
    print('Check mode complete.', colors.green);
    return 0;
  }

  await startAutomation(config);
  return 0;
}

main().catch((error) => {
  print(`Error: ${error?.message || String(error)}`, colors.red);
  process.exit(1);
});
