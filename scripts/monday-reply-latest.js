#!/usr/bin/env node
/**
 * monday reply-latest
 *
 * Posts a ticket update as:
 * - reply to the latest update when one exists
 * - fallback to top-level update when no updates exist
 *
 * Auth:
 * - MONDAY_API_TOKEN from shell or local env files (.monday.local, .env.local, scripts/.monday.local, ~/.config/meetric/monday.env)
 */

import process from 'process';
import fs from 'fs/promises';
import path from 'path';

const DEFAULT_API_URL = 'https://api.monday.com/v2';
const DEFAULT_API_VERSION = '2025-04';
const DEFAULT_LOCAL_ENV_FILES = ['.monday.local', '.env.local', 'scripts/.monday.local'];
const DEFAULT_UPDATES_LIMIT = 50;

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
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
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

function getRequiredArg(args, key, label) {
  const value = String(args[key] || '').trim();
  if (!value) fail(`Missing required argument: ${label}`);
  return value;
}

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
  const keys = ['MONDAY_API_TOKEN', 'MONDAY_API_URL', 'MONDAY_API_VERSION'];
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
    const hasRelevantKeys = keys.some((key) => String(parsed[key] || '').trim());
    if (!source && hasRelevantKeys) source = candidate;

    for (const key of keys) {
      if (values[key]) continue;
      const nextValue = String(parsed[key] || '').trim();
      if (!nextValue) continue;
      values[key] = nextValue;
    }
  }

  return { values, source };
}

function maskSecret(value) {
  const raw = String(value || '');
  if (!raw) return '';
  if (raw.length <= 8) return `${raw.slice(0, 2)}...${raw.slice(-2)}`;
  return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
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

  return payload?.data || {};
}

async function fetchLatestUpdateId(config) {
  const query = `
    query ReplyLatest($itemIds: [ID!], $limit: Int!) {
      items(ids: $itemIds) {
        id
        updates(limit: $limit) {
          id
          created_at
        }
      }
    }
  `;

  const data = await mondayRequest(config, query, {
    itemIds: [String(config.itemId)],
    limit: config.maxUpdates,
  });

  const item = Array.isArray(data?.items) ? data.items[0] : null;
  if (!item) fail(`Ticket not found for item id: ${config.itemId}`);

  const updates = Array.isArray(item?.updates) ? item.updates : [];
  if (updates.length === 0) return '';

  const latest = updates
    .map((entry, index) => ({
      entry,
      index,
      timestamp: Number.isFinite(Date.parse(String(entry?.created_at || '').trim()))
        ? Date.parse(String(entry?.created_at || '').trim())
        : Number.NEGATIVE_INFINITY,
    }))
    .sort((a, b) => (b.timestamp !== a.timestamp ? b.timestamp - a.timestamp : a.index - b.index))[0]?.entry;

  return String(latest?.id || '').trim();
}

async function createReplyOrUpdate(config, parentUpdateId) {
  if (parentUpdateId) {
    const query = `
      mutation ReplyToLatest($itemId: ID!, $parentId: ID!, $body: String!) {
        create_update(item_id: $itemId, parent_id: $parentId, body: $body) { id }
      }
    `;
    const data = await mondayRequest(config, query, {
      itemId: String(config.itemId),
      parentId: String(parentUpdateId),
      body: config.body,
    });
    return String(data?.create_update?.id || '').trim();
  }

  const query = `
    mutation CreateTopLevelUpdate($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) { id }
    }
  `;
  const data = await mondayRequest(config, query, {
    itemId: String(config.itemId),
    body: config.body,
  });
  return String(data?.create_update?.id || '').trim();
}

async function readBody(args) {
  const direct = getOptionalArg(args, 'body');
  if (direct) return direct;

  const bodyFile = getOptionalArg(args, 'body-file');
  if (bodyFile) {
    const absolutePath = path.isAbsolute(bodyFile) ? bodyFile : path.resolve(process.cwd(), bodyFile);
    const content = await fs.readFile(absolutePath, 'utf8');
    const trimmed = String(content || '').trim();
    if (!trimmed) fail(`Body file is empty: ${absolutePath}`);
    return trimmed;
  }

  fail('Missing reply body. Provide --body "<text>" or --body-file <path>.');
}

function printUsage() {
  print('');
  print('monday reply-latest', colors.cyan);
  print('');
  print('Usage:');
  print('  monday-auto reply-latest --workspace /path/to/repo --item-id <id> --body "<text>"');
  print('  monday-auto reply-latest --workspace /path/to/repo --item-id <id> --body-file ./reply.md');
  print('');
  print('Options:');
  print('  --workspace <path>');
  print('  --item-id <id> (required)');
  print('  --body "<markdown>"');
  print('  --body-file <path>');
  print(`  --max-updates <n> (default ${DEFAULT_UPDATES_LIMIT})`);
  print('  --dry-run true|false');
  print('  --json true|false');
  print('  --env-file <path>');
  print('');
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help || args.h || args._[0] === 'help') {
    printUsage();
    return 0;
  }

  const workspace = resolveWorkspaceFromArgv(
    argv,
    process.env.MONDAY_TOOLKIT_WORKSPACE || process.env.MONDAY_WORKSPACE || '',
  );
  try {
    process.chdir(workspace);
  } catch {
    fail(`Workspace path is not accessible: ${workspace}`);
  }

  const loadedEnv = await loadMondayEnvValues(args);
  const token = String(process.env.MONDAY_API_TOKEN || loadedEnv.values.MONDAY_API_TOKEN || '').trim();
  if (!token) {
    fail(
      'MONDAY_API_TOKEN is required. Set it in shell or in an ignored local env file (.monday.local, .env.local, scripts/.monday.local, or --env-file).',
    );
  }

  const config = {
    token,
    apiUrl: String(process.env.MONDAY_API_URL || loadedEnv.values.MONDAY_API_URL || DEFAULT_API_URL).replace(/\/$/, ''),
    apiVersion: String(
      process.env.MONDAY_API_VERSION || loadedEnv.values.MONDAY_API_VERSION || DEFAULT_API_VERSION,
    ).trim(),
    itemId: getRequiredArg(args, 'item-id', '--item-id'),
    body: await readBody(args),
    maxUpdates: parseInteger(getOptionalArg(args, 'max-updates', String(DEFAULT_UPDATES_LIMIT)), DEFAULT_UPDATES_LIMIT),
    dryRun: parseBoolean(getOptionalArg(args, 'dry-run', 'false'), false),
    json: parseBoolean(getOptionalArg(args, 'json', 'false'), false),
  };

  print(`workspace: ${process.cwd()}`, colors.dim);
  if (loadedEnv.source) {
    print(`monday env source: ${loadedEnv.source}`, colors.dim);
  }
  print(`monday token: ${maskSecret(config.token)} (masked)`, colors.dim);

  const parentUpdateId = await fetchLatestUpdateId(config);
  const mode = parentUpdateId ? 'reply-latest' : 'top-level';

  if (config.dryRun) {
    const output = {
      itemId: String(config.itemId),
      mode,
      parentUpdateId: parentUpdateId || null,
      createdUpdateId: null,
    };
    if (config.json) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(output, null, 2));
    } else {
      print(`item_id=${output.itemId}`, colors.green);
      print(`parent_update_id=${output.parentUpdateId || 'none'}`, colors.green);
      print(`mode=${mode}`, colors.green);
      print('dry_run=true', colors.yellow);
    }
    return 0;
  }

  const createdUpdateId = await createReplyOrUpdate(config, parentUpdateId);
  if (!createdUpdateId) {
    fail('monday did not return create_update.id');
  }

  const output = {
    itemId: String(config.itemId),
    mode,
    parentUpdateId: parentUpdateId || null,
    createdUpdateId,
  };

  if (config.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(output, null, 2));
  } else {
    print(`item_id=${output.itemId}`, colors.green);
    print(`parent_update_id=${output.parentUpdateId || 'none'}`, colors.green);
    print(`new_reply_update_id=${output.createdUpdateId}`, colors.green);
    print(`mode=${output.mode}`, colors.green);
  }

  return 0;
}

main().catch((error) => {
  print(`Error: ${error?.message || String(error)}`, colors.red);
  process.exit(1);
});
