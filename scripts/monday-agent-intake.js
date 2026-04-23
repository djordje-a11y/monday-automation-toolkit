#!/usr/bin/env node
/**
 * monday ticket -> agent intake dispatcher.
 *
 * Flow:
 * 1) Fetch ticket details from monday (item, column values, updates, assets).
 * 2) Build a structured context JSON + prompt markdown.
 * 3) Propose deterministic branch name candidate.
 * 4) Write timestamped .prompt.md / .context.json plus IDE handoff files:
 *    - branch history: `<handoffDir>/<branch-with-slashes-as-hyphens>.agent-handoff.md`
 *    - stable alias: `<repo-root>/monday-handoff.md` (default) for easy @ attach
 *    - on same-ticket retrigger with existing branch: write latest-update-only handoff
 * 5) Optionally run a configured agent command with prompt/context paths.
 *
 * This script is designed to be called from monday-webhook-bridge:
 *   node scripts/monday-agent-intake.js --item-id "$MONDAY_TRIGGER_ITEM_ID" --dispatch
 */

import process from 'process';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';

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
const DEFAULT_MAX_UPDATES = 20;
const DEFAULT_OUTPUT_DIR = '.monday/intake';
const DEFAULT_HANDOFF_DIR = '.monday/handoffs';
const DEFAULT_HANDOFF_ALIAS_FILE = 'monday-handoff.md';
const DEFAULT_HANDOFF_RETRIGGER_LATEST_ONLY = true;
const DEFAULT_BRANCH_PREFIX = 'dev/monday';
const DEFAULT_BRANCH_PREFIX_RULES = 'bugs=fix,epics backlog=feat';
const DEFAULT_BRANCH_INCLUDE_TICKET_ID = false;
const DEFAULT_GIT_PREPARE_BRANCH = true;
const DEFAULT_GIT_BASE_BRANCH = 'acceptance';
const DEFAULT_GIT_REMOTE = 'origin';
const DEFAULT_GIT_REQUIRE_CLEAN_WORKTREE = true;
const DEFAULT_AGENT_CREATE_CHAT = true;
const DEFAULT_AGENT_CREATE_CHAT_COMMAND = '$HOME/.local/bin/cursor-agent create-chat';
/** When true, drop CURSOR_API_KEY for cursor-agent so CLI uses `cursor-agent login` session (invalid env keys override login). */
const DEFAULT_AGENT_UNSET_CURSOR_API_KEY = true;
/** When true, keep cursor-agent --print (output in terminal only; no Cursor IDE Agent panel). When false, strip --print/--trust so the CLI can open the interactive Agent UI (needs a desktop session + TTY). */
const DEFAULT_AGENT_HEADLESS_PRINT = true;
/** Write `<branch>.agent-handoff.md` for IDE Agent (@ file); filename derived from prepared branch or branch candidate. */
const DEFAULT_IDE_HANDOFF = true;
const DEFAULT_LOCAL_ENV_FILES = ['.monday.local', '.env.local', 'scripts/.monday.local'];

const DEFAULT_RULES = [
  'Ticket intake rules:',
  '- Investigate root cause first. Do not propose symptom-only workarounds.',
  '- Preserve security constraints and account isolation (no access widening fixes).',
  '- Keep scope minimal and explicit; call out behavior changes separately.',
  '- Include deterministic validation plan (targeted tests first, then confidence checks).',
  '- Output must include: ticket understanding, proposed branch name, solution approach, risks/blockers.',
  '',
  'Completion and handoff rules (mandatory when user asks to commit):',
  '- Do not hardcode personal names/emails in shared rules or ticket comments.',
  '- Use custom signing/author commit command only when user explicitly asks for it.',
  '- If user does not explicitly request custom signing/author, use normal commit flow (`git commit -m "<message>"`).',
  '- Write a meaningful commit message: fix|feat|chore subject + user-visible outcome + why (avoid vague messages).',
  '- Staged-first workflow: user stages reviewed files and tells agent changes are staged.',
  '- On "staged push" (or equivalent): verify staged diff is non-empty, commit staged files only, push branch, post monday update via `monday-auto reply-latest --workspace "$PWD" --item-id "<ticket-id>" --body-file "<reply-file.md>"`, then set status to "AI fix ready".',
  '- Push rule: use "git push -u origin HEAD" when no upstream exists, otherwise "git push origin HEAD".',
  '- monday update must include root cause, fix summary, validation, branch, commit SHA, and commit URL.',
  '- Never set "AI fix ready" before push + commit URL are available.',
].join('\n');

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

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = normalize(value);
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeOptionalPath(value, fallback = '') {
  const raw = String(value ?? fallback ?? '').trim();
  if (!raw) return '';
  const normalized = normalize(raw);
  if (['0', 'false', 'no', 'n', 'off', 'none', 'disable', 'disabled'].includes(normalized)) {
    return '';
  }
  return raw;
}

function normalizePrefix(value) {
  return String(value || '').trim().replace(/\/+$/g, '');
}

function parseRuleMatcher(matchRaw) {
  const raw = String(matchRaw || '').trim();
  if (!raw) return { matchType: 'title', match: '' };

  const marker = raw.match(/^(id|group|group-id)\s*:\s*(.+)$/i);
  if (marker) {
    return {
      matchType: 'id',
      match: normalize(marker[2]),
    };
  }

  return {
    matchType: 'title',
    match: normalize(raw),
  };
}

function createBranchRule(matchRaw, prefixRaw, forcedMatchType = '') {
  const parsed = parseRuleMatcher(matchRaw);
  const prefix = normalizePrefix(prefixRaw);
  const normalizedForcedType = normalize(forcedMatchType);
  const matchType = normalizedForcedType === 'id' ? 'id' : parsed.matchType;

  if (!parsed.match || !prefix) return null;
  return {
    matchType,
    match: parsed.match,
    prefix,
  };
}

function parseBranchPrefixRules(rawValue) {
  const normalizedRaw = String(rawValue || '').trim();
  const source = normalizedRaw || DEFAULT_BRANCH_PREFIX_RULES;

  if (!source) return [];

  if (source.startsWith('{')) {
    try {
      const parsed = JSON.parse(source);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const rules = [];

        if (parsed.title && typeof parsed.title === 'object' && !Array.isArray(parsed.title)) {
          for (const [match, prefix] of Object.entries(parsed.title)) {
            const rule = createBranchRule(match, prefix, 'title');
            if (rule) rules.push(rule);
          }
        }

        if (parsed.id && typeof parsed.id === 'object' && !Array.isArray(parsed.id)) {
          for (const [match, prefix] of Object.entries(parsed.id)) {
            const rule = createBranchRule(match, prefix, 'id');
            if (rule) rules.push(rule);
          }
        }

        for (const [match, prefix] of Object.entries(parsed)) {
          if (match === 'title' || match === 'id') continue;
          const rule = createBranchRule(match, prefix);
          if (rule) rules.push(rule);
        }

        if (rules.length > 0) return rules;
      }
    } catch {
      // fall back to CSV parser
    }
  }

  return source
    .split(',')
    .map((pair) => String(pair || '').trim())
    .filter(Boolean)
    .map((pair) => {
      const separatorIndex = pair.indexOf('=');
      if (separatorIndex <= 0) return null;
      return createBranchRule(pair.slice(0, separatorIndex), pair.slice(separatorIndex + 1));
    })
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

function getRequiredArg(args, key, label) {
  const value = String(args[key] || '').trim();
  if (!value) fail(`Missing required argument: ${label}`);
  return value;
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
  const keys = [
    'MONDAY_API_TOKEN',
    'MONDAY_API_URL',
    'MONDAY_API_VERSION',
    'MONDAY_AGENT_COMMAND',
    'MONDAY_AGENT_OUTPUT_DIR',
    'MONDAY_AGENT_HANDOFF_DIR',
    'MONDAY_AGENT_HANDOFF_ALIAS_FILE',
    'MONDAY_AGENT_HANDOFF_RETRIGGER_LATEST_ONLY',
    'MONDAY_AGENT_HANDOFF_APPEND_LAST_UPDATE_ON_RETRIGGER',
    'MONDAY_AGENT_RULES_FILE',
    'MONDAY_AGENT_BRANCH_PREFIX',
    'MONDAY_AGENT_BRANCH_PREFIX_RULES',
    'MONDAY_AGENT_BRANCH_INCLUDE_TICKET_ID',
    'MONDAY_AGENT_GIT_PREPARE_BRANCH',
    'MONDAY_AGENT_GIT_BASE_BRANCH',
    'MONDAY_AGENT_GIT_REMOTE',
    'MONDAY_AGENT_GIT_REQUIRE_CLEAN_WORKTREE',
    'MONDAY_AGENT_CREATE_CHAT',
    'MONDAY_AGENT_CREATE_CHAT_COMMAND',
    'MONDAY_AGENT_UNSET_CURSOR_API_KEY',
    'MONDAY_AGENT_HEADLESS_PRINT',
    'MONDAY_AGENT_IDE_HANDOFF',
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
    const hasRelevantKeys = keys.some((key) => String(parsed[key] || '').trim());
    if (!source && hasRelevantKeys) source = candidate;

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

  return {
    token,
    apiUrl: String(process.env.MONDAY_API_URL || envValues.MONDAY_API_URL || DEFAULT_API_URL).replace(/\/$/, ''),
    apiVersion: String(process.env.MONDAY_API_VERSION || envValues.MONDAY_API_VERSION || DEFAULT_API_VERSION).trim(),
    itemId: getRequiredArg(args, 'item-id', '--item-id'),
    maxUpdates: parseInteger(getOptionalArg(args, 'max-updates', String(DEFAULT_MAX_UPDATES)), DEFAULT_MAX_UPDATES),
    outputDir: getOptionalArg(
      args,
      'output-dir',
      process.env.MONDAY_AGENT_OUTPUT_DIR || envValues.MONDAY_AGENT_OUTPUT_DIR || DEFAULT_OUTPUT_DIR,
    ),
    handoffDir: getOptionalArg(
      args,
      'handoff-dir',
      process.env.MONDAY_AGENT_HANDOFF_DIR || envValues.MONDAY_AGENT_HANDOFF_DIR || DEFAULT_HANDOFF_DIR,
    ),
    handoffAliasFile: normalizeOptionalPath(
      getOptionalArg(
        args,
        'handoff-alias-file',
        process.env.MONDAY_AGENT_HANDOFF_ALIAS_FILE ||
          envValues.MONDAY_AGENT_HANDOFF_ALIAS_FILE ||
          DEFAULT_HANDOFF_ALIAS_FILE,
      ),
      DEFAULT_HANDOFF_ALIAS_FILE,
    ),
    handoffRetriggerLatestOnly: parseBoolean(
      getOptionalArg(
        args,
        'handoff-retrigger-latest-only',
        String(args['handoff-append-last-update-on-retrigger'] || '').trim() ||
          process.env.MONDAY_AGENT_HANDOFF_RETRIGGER_LATEST_ONLY ||
          envValues.MONDAY_AGENT_HANDOFF_RETRIGGER_LATEST_ONLY ||
          process.env.MONDAY_AGENT_HANDOFF_APPEND_LAST_UPDATE_ON_RETRIGGER ||
          envValues.MONDAY_AGENT_HANDOFF_APPEND_LAST_UPDATE_ON_RETRIGGER ||
          String(DEFAULT_HANDOFF_RETRIGGER_LATEST_ONLY),
      ),
      DEFAULT_HANDOFF_RETRIGGER_LATEST_ONLY,
    ),
    dispatch: parseBoolean(getOptionalArg(args, 'dispatch', 'false'), false) || Boolean(args.dispatch),
    agentCommand: getOptionalArg(
      args,
      'agent-command',
      process.env.MONDAY_AGENT_COMMAND || envValues.MONDAY_AGENT_COMMAND || '',
    ),
    rulesFile: getOptionalArg(
      args,
      'rules-file',
      process.env.MONDAY_AGENT_RULES_FILE || envValues.MONDAY_AGENT_RULES_FILE || '',
    ),
    branchPrefix: getOptionalArg(
      args,
      'branch-prefix',
      process.env.MONDAY_AGENT_BRANCH_PREFIX || envValues.MONDAY_AGENT_BRANCH_PREFIX || DEFAULT_BRANCH_PREFIX,
    ),
    branchPrefixRules: parseBranchPrefixRules(
      getOptionalArg(
        args,
        'branch-prefix-rules',
        process.env.MONDAY_AGENT_BRANCH_PREFIX_RULES ||
          envValues.MONDAY_AGENT_BRANCH_PREFIX_RULES ||
          DEFAULT_BRANCH_PREFIX_RULES,
      ),
    ),
    branchIncludeTicketId: parseBoolean(
      getOptionalArg(
        args,
        'branch-include-ticket-id',
        process.env.MONDAY_AGENT_BRANCH_INCLUDE_TICKET_ID ||
          envValues.MONDAY_AGENT_BRANCH_INCLUDE_TICKET_ID ||
          String(DEFAULT_BRANCH_INCLUDE_TICKET_ID),
      ),
      DEFAULT_BRANCH_INCLUDE_TICKET_ID,
    ),
    gitPrepareBranch: parseBoolean(
      getOptionalArg(
        args,
        'git-prepare-branch',
        process.env.MONDAY_AGENT_GIT_PREPARE_BRANCH ||
          envValues.MONDAY_AGENT_GIT_PREPARE_BRANCH ||
          String(DEFAULT_GIT_PREPARE_BRANCH),
      ),
      DEFAULT_GIT_PREPARE_BRANCH,
    ),
    gitBaseBranch: getOptionalArg(
      args,
      'git-base-branch',
      process.env.MONDAY_AGENT_GIT_BASE_BRANCH ||
        envValues.MONDAY_AGENT_GIT_BASE_BRANCH ||
        DEFAULT_GIT_BASE_BRANCH,
    ),
    gitRemote: getOptionalArg(
      args,
      'git-remote',
      process.env.MONDAY_AGENT_GIT_REMOTE ||
        envValues.MONDAY_AGENT_GIT_REMOTE ||
        DEFAULT_GIT_REMOTE,
    ),
    gitRequireCleanWorktree: parseBoolean(
      getOptionalArg(
        args,
        'git-require-clean-worktree',
        process.env.MONDAY_AGENT_GIT_REQUIRE_CLEAN_WORKTREE ||
          envValues.MONDAY_AGENT_GIT_REQUIRE_CLEAN_WORKTREE ||
          String(DEFAULT_GIT_REQUIRE_CLEAN_WORKTREE),
      ),
      DEFAULT_GIT_REQUIRE_CLEAN_WORKTREE,
    ),
    agentCreateChat: parseBoolean(
      getOptionalArg(
        args,
        'agent-create-chat',
        process.env.MONDAY_AGENT_CREATE_CHAT ||
          envValues.MONDAY_AGENT_CREATE_CHAT ||
          String(DEFAULT_AGENT_CREATE_CHAT),
      ),
      DEFAULT_AGENT_CREATE_CHAT,
    ),
    agentCreateChatCommand: getOptionalArg(
      args,
      'agent-create-chat-command',
      process.env.MONDAY_AGENT_CREATE_CHAT_COMMAND ||
        envValues.MONDAY_AGENT_CREATE_CHAT_COMMAND ||
        DEFAULT_AGENT_CREATE_CHAT_COMMAND,
    ),
    unsetCursorApiKey: parseBoolean(
      getOptionalArg(
        args,
        'unset-cursor-api-key',
        process.env.MONDAY_AGENT_UNSET_CURSOR_API_KEY ||
          envValues.MONDAY_AGENT_UNSET_CURSOR_API_KEY ||
          String(DEFAULT_AGENT_UNSET_CURSOR_API_KEY),
      ),
      DEFAULT_AGENT_UNSET_CURSOR_API_KEY,
    ),
    agentHeadlessPrint: parseBoolean(
      getOptionalArg(
        args,
        'agent-headless-print',
        process.env.MONDAY_AGENT_HEADLESS_PRINT ||
          envValues.MONDAY_AGENT_HEADLESS_PRINT ||
          String(DEFAULT_AGENT_HEADLESS_PRINT),
      ),
      DEFAULT_AGENT_HEADLESS_PRINT,
    ),
    ideHandoff: parseBoolean(
      getOptionalArg(
        args,
        'ide-handoff',
        process.env.MONDAY_AGENT_IDE_HANDOFF ||
          envValues.MONDAY_AGENT_IDE_HANDOFF ||
          String(DEFAULT_IDE_HANDOFF),
      ),
      DEFAULT_IDE_HANDOFF,
    ),
  };
}

/**
 * cursor-agent --print forces headless mode: all output goes to the terminal and the
 * Cursor IDE does not open/focus an Agent chat tab. For GUI mode, remove --print and
 * --trust (--trust is only valid with --print per cursor-agent --help).
 */
function adaptCursorAgentCommandForHeadless(command, headless) {
  let raw = String(command || '').trim();
  if (headless || !raw) return raw;

  const before = raw;
  raw = raw.replace(/\s--print\b/g, '');
  raw = raw.replace(/\s--trust\b/g, '');
  raw = raw.replace(/\s--stream-partial-output\b/g, '');
  raw = raw.replace(/\s{2,}/g, ' ').trim();

  if (raw !== before) {
    print(
      'MONDAY_AGENT_HEADLESS_PRINT=false: removed --print / --trust / --stream-partial-output for interactive Agent UI.',
      colors.yellow,
    );
  }
  return raw;
}

function buildCursorAgentChildEnv(config, extra = {}) {
  const env = { ...process.env, ...extra };
  if (config.unsetCursorApiKey) {
    delete env.CURSOR_API_KEY;
  }
  return env;
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

async function getItemDetails(config) {
  const query = `
    query IntakeItem($itemIds: [ID!], $updatesLimit: Int!) {
      items(ids: $itemIds) {
        id
        name
        updated_at
        group {
          id
          title
        }
        parent_item {
          id
          name
          group {
            id
            title
          }
          board {
            id
            name
          }
        }
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
        updates(limit: $updatesLimit) {
          id
          text_body
          body
          created_at
          creator {
            id
            name
          }
          assets {
            id
            name
            file_extension
            file_size
            url
            public_url
          }
        }
      }
    }
  `;

  const data = await mondayRequest(config, query, {
    itemIds: [String(config.itemId)],
    updatesLimit: config.maxUpdates,
  });

  const item = Array.isArray(data?.items) ? data.items[0] : null;
  if (!item) fail(`Ticket not found for item id: ${config.itemId}`);
  return item;
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

function buildColumnMap(item) {
  const map = new Map();
  const values = Array.isArray(item?.column_values) ? item.column_values : [];
  for (const column of values) {
    map.set(String(column?.id || ''), {
      id: String(column?.id || ''),
      type: String(column?.type || ''),
      text: String(column?.text || ''),
      value: parseMaybeJson(column?.value),
    });
  }
  return map;
}

function getStatusTextFromColumns(columnMap) {
  const statusCandidates = ['status', 'review_status', 'workflow_status'];
  for (const columnId of statusCandidates) {
    const candidate = columnMap.get(columnId);
    const text = String(candidate?.text || '').trim();
    if (text) return text;
  }

  for (const column of columnMap.values()) {
    if (normalize(column.type) === 'status') {
      const text = String(column.text || '').trim();
      if (text) return text;
    }
  }
  return '';
}

function slugifyForBranch(value, maxLen = 48) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '');
  return slug || 'ticket';
}

/** Map git branch name to a single flat filename segment (slashes -> hyphens). */
function sanitizeBranchForHandoffFilename(branch) {
  const raw = String(branch || '').trim() || 'monday-ticket';
  let s = raw.replace(/[/\\:*?"<>|]+/g, '-');
  s = s.replace(/\s+/g, '-');
  s = s.replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (s.length > 180) s = s.slice(0, 180).replace(/-+$/g, '');
  return s || 'monday-ticket';
}

function buildIdeHandoffBody({ branchLabel, relativeHandoffPath, archiveHandoffPath, promptText }) {
  const archiveLine =
    archiveHandoffPath && archiveHandoffPath !== relativeHandoffPath
      ? `- **Branch-specific handoff file:** \`${archiveHandoffPath}\``
      : '';
  return [
    '# Cursor IDE Agent — Monday handoff',
    '',
    'Use **Agent** in the Cursor IDE (sidebar), start a chat, and attach this file with `@` using the path below. Everything after the divider is the ticket package (same as the `.prompt.md` artifact).',
    '',
    `- **Git branch:** \`${branchLabel}\``,
    `- **This file (repo-relative):** \`${relativeHandoffPath}\``,
    ...(archiveLine ? [archiveLine] : []),
    '',
    'Branch handoff files are kept in `.monday/handoffs/` and the stable alias is refreshed on each run.',
    '',
    '---',
    '',
    promptText.trimEnd(),
    '',
  ].join('\n');
}

function resolveRepoRelativePath(absolutePath) {
  const rel = path.relative(process.cwd(), absolutePath);
  return rel.split(path.sep).join('/');
}

function ensureTrailingNewline(text) {
  const raw = String(text || '');
  if (!raw) return '\n';
  return raw.endsWith('\n') ? raw : `${raw}\n`;
}

function normalizeUpdateText(value, maxLen = 0) {
  const html = String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"');
  const normalized = html
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  if (maxLen > 0) return normalized.slice(0, maxLen);
  return normalized;
}

function resolveUpdateText(update, maxLen = 0) {
  const textBody = String(update?.textBody || update?.text_body || '').trim();
  const htmlBody = String(update?.body || '').trim();
  const normalizedTextBody = normalizeUpdateText(textBody);
  const normalizedHtmlBody = normalizeUpdateText(htmlBody);

  // monday may return shortened text_body for long/collapsed updates.
  const preferred = normalizedHtmlBody.length > normalizedTextBody.length
    ? normalizedHtmlBody
    : normalizedTextBody;
  if (!preferred) return '';
  if (maxLen > 0) return preferred.slice(0, maxLen);
  return preferred;
}

function pickLatestUpdate(updates) {
  const entries = Array.isArray(updates) ? updates : [];
  if (entries.length === 0) return null;

  const ranked = entries.map((entry, index) => {
    const timestamp = Date.parse(String(entry?.createdAt || entry?.created_at || '').trim());
    return {
      entry,
      index,
      timestamp: Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY,
    };
  });

  ranked.sort((a, b) => {
    if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
    return a.index - b.index;
  });

  return ranked[0]?.entry || entries[0] || null;
}

function extractLatestUpdateDetails(context) {
  const latestUpdate = pickLatestUpdate(context?.updates);
  if (!latestUpdate) {
    return {
      found: false,
      id: 'unknown',
      createdAt: 'unknown',
      author: 'unknown',
      text: '(No monday updates found for this retrigger.)',
    };
  }

  const updateId = String(latestUpdate?.id || '').trim();
  const updateCreatedAt = String(latestUpdate?.createdAt || latestUpdate?.created_at || '').trim();
  const updateAuthor = String(latestUpdate?.creator?.name || '').trim() || 'unknown';
  const updateText = resolveUpdateText(latestUpdate);

  return {
    found: true,
    id: updateId || 'unknown',
    createdAt: updateCreatedAt || 'unknown',
    author: updateAuthor,
    text: updateText || '(empty update text)',
  };
}

function buildRetriggerLatestOnlyPrompt({
  context,
  branchLabel,
  promptPath,
  contextPath,
  latestUpdate,
}) {
  return [
    `Ticket #${context.ticket.id} — ${context.ticket.title}`,
    '',
    '## Retrigger intake mode',
    'Same-ticket retrigger detected. This handoff intentionally includes only the latest monday update to avoid re-sending full task context.',
    '',
    '## Ticket',
    `- Ticket ID: ${context.ticket.id}`,
    `- Ticket title: ${context.ticket.title}`,
    `- Ticket status: ${context.ticket.status || '(unknown)'}`,
    `- Branch: ${branchLabel}`,
    '',
    '## Latest monday update',
    `- Update ID: ${latestUpdate.id}`,
    `- Update time: ${latestUpdate.createdAt}`,
    `- Update author: ${latestUpdate.author}`,
    '',
    '```text',
    latestUpdate.text,
    '```',
    '',
    '## Optional full artifacts (only if needed)',
    `- Full prompt artifact: \`${promptPath}\``,
    `- Full context artifact: \`${contextPath}\``,
    '',
    '## Required Output (exact sections)',
    '1. What changed in this latest comment',
    '2. Code changes needed on the current branch',
    '3. Validation steps for this delta',
    '4. Risks or questions',
    '',
    'Do not restate previously solved context unless needed for this delta.',
    '',
  ].join('\n');
}

function resolveSectionContext(item) {
  const itemGroupId = String(item?.group?.id || '').trim();
  const itemGroupTitle = String(item?.group?.title || '').trim();
  const parentGroupId = String(item?.parent_item?.group?.id || '').trim();
  const parentGroupTitle = String(item?.parent_item?.group?.title || '').trim();
  const parentBoardId = String(item?.parent_item?.board?.id || '').trim();
  const parentBoardName = String(item?.parent_item?.board?.name || '').trim();

  if (parentGroupTitle || parentGroupId) {
    return {
      sectionId: parentGroupId || itemGroupId,
      sectionTitle: parentGroupTitle || itemGroupTitle,
      source: 'parent_item_group',
      parentBoardId,
      parentBoardName,
    };
  }

  return {
    sectionId: itemGroupId,
    sectionTitle: itemGroupTitle,
    source: 'item_group',
    parentBoardId: '',
    parentBoardName: '',
  };
}

function resolveBranchPrefixForSection(sectionTitle, sectionId, rules, fallbackPrefix) {
  const normalizedSection = normalize(sectionTitle);
  const normalizedSectionId = normalize(sectionId);
  const normalizedFallback = String(fallbackPrefix || DEFAULT_BRANCH_PREFIX).trim().replace(/\/+$/g, '');
  const parsedRules = Array.isArray(rules) ? rules : [];

  if (!normalizedSection && !normalizedSectionId) {
    return {
      prefix: normalizedFallback,
      matchedRule: null,
    };
  }

  if (normalizedSectionId) {
    const idRule = parsedRules.find(
      (rule) => rule?.matchType === 'id' && normalize(rule?.match) === normalizedSectionId,
    );
    if (idRule) {
      return {
        prefix: normalizePrefix(idRule.prefix) || normalizedFallback,
        matchedRule: idRule,
      };
    }
  }

  const exact = parsedRules.find(
    (rule) =>
      (rule?.matchType || 'title') !== 'id' && normalizedSection && normalizedSection === normalize(rule?.match),
  );
  if (exact) {
    return {
      prefix: normalizePrefix(exact.prefix) || normalizedFallback,
      matchedRule: exact,
    };
  }

  const partial = parsedRules.find(
    (rule) =>
      (rule?.matchType || 'title') !== 'id' &&
      normalizedSection &&
      normalize(rule?.match) &&
      normalizedSection.includes(normalize(rule?.match)),
  );
  if (partial) {
    return {
      prefix: normalizePrefix(partial.prefix) || normalizedFallback,
      matchedRule: partial,
    };
  }

  return {
    prefix: normalizedFallback,
    matchedRule: null,
  };
}

function buildBranchCandidate(prefix, item, sectionContext, branchPrefixRules, branchIncludeTicketId) {
  const resolved = resolveBranchPrefixForSection(
    sectionContext?.sectionTitle || '',
    sectionContext?.sectionId || '',
    branchPrefixRules,
    prefix,
  );
  const resolvedPrefix = resolved.prefix;
  const cleanPrefix = String(resolvedPrefix || DEFAULT_BRANCH_PREFIX).replace(/\/+$/g, '');
  const slug = slugifyForBranch(item?.name || '');
  const includeTicketId = Boolean(branchIncludeTicketId);
  const branchName = includeTicketId
    ? `${item?.id || 'unknown'}-${slug}`
    : slug;
  return {
    branchCandidate: `${cleanPrefix}/${branchName}`,
    resolvedPrefix: cleanPrefix,
    matchedRule: resolved.matchedRule,
    includeTicketId,
  };
}

async function runCommandCapture(binary, args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(binary, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk || '');
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk || '');
      });
    }

    child.on('error', (error) => reject(error));
    child.on('exit', (code, signal) => {
      resolve({
        code: Number(code || 0),
        signal: signal || '',
        stdout,
        stderr,
      });
    });
  });
}

async function runGit(args, config) {
  const cwd = String(config?.gitWorkingDirectory || process.cwd());
  const result = await runCommandCapture('git', args, {
    cwd,
    env: process.env,
  });
  if (result.signal) {
    fail(`git ${args.join(' ')} terminated by signal: ${result.signal}`);
  }
  if (result.code !== 0) {
    const stderrText = String(result.stderr || '').trim();
    const stdoutText = String(result.stdout || '').trim();
    const details = stderrText || stdoutText || `exit code ${result.code}`;
    fail(`git ${args.join(' ')} failed: ${details}`);
  }
  return String(result.stdout || '').trim();
}

function parseAheadBehind(value) {
  const raw = String(value || '').trim();
  const [aheadRaw, behindRaw] = raw.split(/\s+/);
  const ahead = Number.parseInt(aheadRaw || '0', 10);
  const behind = Number.parseInt(behindRaw || '0', 10);
  if (Number.isNaN(ahead) || Number.isNaN(behind)) {
    fail(`Could not parse branch divergence output: ${raw || '(empty)'}`);
  }
  return { ahead, behind };
}

async function hasGitRef(ref, config) {
  try {
    await runGit(['show-ref', '--verify', '--quiet', ref], config);
    return true;
  } catch {
    return false;
  }
}

async function remoteBranchExists(remote, branch, config) {
  const output = await runGit(['ls-remote', '--heads', remote, branch], config);
  return Boolean(String(output || '').trim());
}

async function prepareGitBranch(config, branchName) {
  const baseBranch = String(config.gitBaseBranch || DEFAULT_GIT_BASE_BRANCH).trim();
  const remote = String(config.gitRemote || DEFAULT_GIT_REMOTE).trim();
  const targetBranch = String(branchName || '').trim();

  if (!baseBranch) fail('MONDAY_AGENT_GIT_BASE_BRANCH must not be empty.');
  if (!remote) fail('MONDAY_AGENT_GIT_REMOTE must not be empty.');
  if (!targetBranch) fail('Branch candidate is empty; cannot prepare git branch.');

  await runGit(['rev-parse', '--is-inside-work-tree'], config);
  await runGit(['check-ref-format', '--branch', targetBranch], config);

  if (config.gitRequireCleanWorktree) {
    const status = await runGit(['status', '--porcelain', '--untracked-files=no'], config);
    if (status) {
      fail(
        'Refusing branch checkout because working tree has tracked changes. ' +
          'Commit or stash changes first, or set MONDAY_AGENT_GIT_REQUIRE_CLEAN_WORKTREE=false.',
      );
    }
  }

  const hasLocalTargetBranch = await hasGitRef(`refs/heads/${targetBranch}`, config);
  if (hasLocalTargetBranch) {
    print(
      `Reusing existing local branch '${targetBranch}' (safe mode: no reset from base).`,
      colors.yellow,
    );
    await runGit(['checkout', targetBranch], config);
    const headSha = await runGit(['rev-parse', '--short', 'HEAD'], config);
    return {
      baseBranch,
      remote,
      preparedBranch: targetBranch,
      headSha,
      reusedExistingBranch: true,
      branchSource: 'local-existing',
    };
  }

  if (await remoteBranchExists(remote, targetBranch, config)) {
    print(
      `Reusing existing remote branch '${remote}/${targetBranch}' (safe mode: no reset from base).`,
      colors.yellow,
    );
    await runGit(['fetch', remote, targetBranch], config);
    await runGit(['checkout', '-B', targetBranch, `${remote}/${targetBranch}`], config);
    const headSha = await runGit(['rev-parse', '--short', 'HEAD'], config);
    return {
      baseBranch,
      remote,
      preparedBranch: targetBranch,
      headSha,
      reusedExistingBranch: true,
      branchSource: 'remote-existing',
    };
  }

  print(`Preparing git base branch '${baseBranch}' from '${remote}'...`, colors.cyan);
  await runGit(['fetch', remote, baseBranch], config);

  const remoteRef = `refs/remotes/${remote}/${baseBranch}`;
  if (!(await hasGitRef(remoteRef, config))) {
    fail(`Remote base branch not found: ${remote}/${baseBranch}`);
  }

  const hasLocalBaseBranch = await hasGitRef(`refs/heads/${baseBranch}`, config);

  if (hasLocalBaseBranch) {
    await runGit(['checkout', baseBranch], config);
  } else {
    await runGit(['checkout', '-B', baseBranch, `${remote}/${baseBranch}`], config);
  }

  const divergenceBefore = parseAheadBehind(
    await runGit(['rev-list', '--left-right', '--count', `${baseBranch}...${remote}/${baseBranch}`], config),
  );

  if (divergenceBefore.ahead > 0) {
    fail(
      `Local ${baseBranch} is ahead of ${remote}/${baseBranch} by ${divergenceBefore.ahead} commit(s). ` +
        'Refusing to continue because branch must match remote exactly.',
    );
  }

  if (divergenceBefore.behind > 0) {
    await runGit(['merge', '--ff-only', `${remote}/${baseBranch}`], config);
  }

  const divergenceAfter = parseAheadBehind(
    await runGit(['rev-list', '--left-right', '--count', `${baseBranch}...${remote}/${baseBranch}`], config),
  );
  if (divergenceAfter.ahead !== 0 || divergenceAfter.behind !== 0) {
    fail(
      `Failed to sync ${baseBranch} with ${remote}/${baseBranch} ` +
        `(ahead=${divergenceAfter.ahead}, behind=${divergenceAfter.behind}).`,
    );
  }

  await runGit(['checkout', '-B', targetBranch], config);
  const headSha = await runGit(['rev-parse', '--short', 'HEAD'], config);

  return {
    baseBranch,
    remote,
    preparedBranch: targetBranch,
    headSha,
    reusedExistingBranch: false,
    branchSource: 'remote-base',
  };
}

function stripAnsi(text) {
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '');
}

function extractCursorChatId(text) {
  const raw = stripAnsi(String(text || '')).trim();
  if (!raw) return '';
  const exact = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (exact) return exact[0];
  const loose = raw.match(/[0-9a-f]{8}-[0-9a-f-]{27}/i);
  if (loose) return loose[0];
  const token = raw.split(/\s+/).find((value) => value.length >= 12);
  return String(token || '').trim();
}

async function createCursorChatId(config) {
  const command = String(config.agentCreateChatCommand || '').trim();
  if (!command) return '';

  const result = await runCommandCapture('bash', ['-lc', command], {
    cwd: process.cwd(),
    env: buildCursorAgentChildEnv(config),
  });
  if (result.signal) {
    fail(`Chat creation command terminated by signal: ${result.signal}`);
  }
  if (result.code !== 0) {
    const details = String(result.stderr || result.stdout || '').trim() || `exit code ${result.code}`;
    fail(`Failed to create Cursor chat session: ${details}`);
  }

  const chatId = extractCursorChatId(result.stdout);
  if (!chatId) {
    fail(
      'Cursor chat creation did not return a chat ID. ' +
        'Set MONDAY_AGENT_CREATE_CHAT=false to bypass, or fix MONDAY_AGENT_CREATE_CHAT_COMMAND.',
    );
  }
  return chatId;
}

function commandStartsWithCursorAgent(raw) {
  const trimmed = String(raw || '').trim();
  if (/^cursor\s+agent(?:\s|$)/i.test(trimmed)) return true;
  if (/^\$HOME\/\.local\/bin\/cursor-agent(?:\s|$)/.test(trimmed)) return true;
  const firstToken = trimmed.match(/^[^\s]+/);
  return Boolean(firstToken && /cursor-agent$/i.test(firstToken[0]));
}

function injectResumeFlagIfNeeded(command, chatId) {
  const raw = String(command || '').trim();
  if (!raw || !chatId) return raw;

  if (!commandStartsWithCursorAgent(raw)) return raw;

  if (/(^|\s)--resume(\s|=)/.test(raw) || /(^|\s)--continue(\s|$)/.test(raw)) {
    return raw;
  }

  const safeId = String(chatId).replace(/"/g, '\\"');
  const firstSpace = raw.search(/\s/);
  if (firstSpace === -1) {
    return `${raw} --resume "${safeId}"`;
  }
  const bin = raw.slice(0, firstSpace);
  const rest = raw.slice(firstSpace + 1).trimStart();
  return `${bin} --resume "${safeId}" ${rest}`;
}

async function readRulesText(rulesFile) {
  const normalizedPath = String(rulesFile || '').trim();
  if (!normalizedPath) return DEFAULT_RULES;

  const absolutePath = path.isAbsolute(normalizedPath)
    ? normalizedPath
    : path.resolve(process.cwd(), normalizedPath);
  try {
    const content = await fs.readFile(absolutePath, 'utf8');
    const text = String(content || '').trim();
    return text || DEFAULT_RULES;
  } catch {
    return DEFAULT_RULES;
  }
}

function buildPrompt({ item, statusText, branchCandidate, rulesText, sectionContext, resolvedPrefix, gitPreparation }) {
  const updates = Array.isArray(item?.updates) ? item.updates : [];
  const latestUpdateLines = updates.slice(0, 8).map((update, index) => {
    const creator = String(update?.creator?.name || '').trim() || 'unknown';
    const created = String(update?.created_at || '').trim() || 'unknown-time';
    const body = resolveUpdateText(update);
    return `${index + 1}. [${created}] ${creator}: ${body || '(empty update)'}`;
  });

  const assets = updates.flatMap((update) => (Array.isArray(update?.assets) ? update.assets : []));
  const assetLines = assets.slice(0, 15).map((asset, index) => {
    const name = String(asset?.name || '').trim() || `asset-${index + 1}`;
    const url = String(asset?.public_url || asset?.url || '').trim();
    return `${index + 1}. ${name}${url ? ` -> ${url}` : ''}`;
  });

  return [
    '# Monday Ticket Agent Intake',
    '',
    'You are a focused ticket triage agent.',
    '',
    '## Ticket Context',
    `- Item ID: ${item?.id || ''}`,
    `- Title: ${item?.name || ''}`,
    `- Board: ${item?.board?.name || ''} (${item?.board?.id || ''})`,
    `- Group: ${item?.group?.title || ''} (${item?.group?.id || ''})`,
    `- Section used for branch strategy: ${sectionContext?.sectionTitle || '(unknown)'} [id=${sectionContext?.sectionId || '(none)'}] (${sectionContext?.source || 'n/a'})`,
    `- Current Status: ${statusText || '(unknown)'}`,
    `- Resolved Branch Prefix: ${resolvedPrefix || '(unknown)'}`,
    `- Proposed Branch Name Candidate: ${branchCandidate}`,
    `- Git Base Branch: ${gitPreparation?.baseBranch || '(not prepared)'}`,
    `- Git Prepared Branch: ${gitPreparation?.preparedBranch || '(not prepared)'}`,
    `- Git Base Remote: ${gitPreparation?.remote || '(not prepared)'}`,
    `- Git Prepared Head: ${gitPreparation?.headSha || '(not prepared)'}`,
    '',
    '## Latest Ticket Updates',
    ...(latestUpdateLines.length > 0 ? latestUpdateLines : ['(No updates found)']),
    '',
    '## Attached Assets',
    ...(assetLines.length > 0 ? assetLines : ['(No assets found)']),
    '',
    '## Mandatory Rules',
    rulesText,
    '',
    '## Required Output (exact sections)',
    '1. Ticket understanding',
    '2. Root cause hypotheses (ordered by confidence)',
    '3. Proposed branch name (final)',
    '4. Proposed solution approach (step-by-step)',
    '5. Validation and regression checks',
    '6. Risks, unknowns, and questions for clarifications',
    '',
    'Keep recommendations actionable and implementation-ready.',
    '',
  ].join('\n');
}

function buildContextObject({
  item,
  statusText,
  branchCandidate,
  rulesText,
  sectionContext,
  resolvedPrefix,
  branchPrefixRules,
  matchedBranchRule,
  branchIncludeTicketId,
  gitPreparation,
}) {
  const updates = Array.isArray(item?.updates) ? item.updates : [];
  const normalizedUpdates = updates.map((update) => ({
    id: String(update?.id || ''),
    createdAt: String(update?.created_at || ''),
    creator: {
      id: String(update?.creator?.id || ''),
      name: String(update?.creator?.name || ''),
    },
    textBody: String(update?.text_body || ''),
    bodyHtml: String(update?.body || ''),
    textResolved: resolveUpdateText(update),
    assets: (Array.isArray(update?.assets) ? update.assets : []).map((asset) => ({
      id: String(asset?.id || ''),
      name: String(asset?.name || ''),
      extension: String(asset?.file_extension || ''),
      fileSize: Number(asset?.file_size || 0),
      url: String(asset?.url || ''),
      publicUrl: String(asset?.public_url || ''),
    })),
  }));

  return {
    generatedAt: new Date().toISOString(),
    ticket: {
      id: String(item?.id || ''),
      title: String(item?.name || ''),
      status: statusText,
      board: {
        id: String(item?.board?.id || ''),
        name: String(item?.board?.name || ''),
      },
      group: {
        id: String(item?.group?.id || ''),
        name: String(item?.group?.title || ''),
      },
      sectionForBranching: {
        id: String(sectionContext?.sectionId || ''),
        name: String(sectionContext?.sectionTitle || ''),
        source: String(sectionContext?.source || ''),
        parentBoardId: String(sectionContext?.parentBoardId || ''),
        parentBoardName: String(sectionContext?.parentBoardName || ''),
      },
      updatedAt: String(item?.updated_at || ''),
    },
    branchCandidate,
    branchPrefixResolved: resolvedPrefix,
    branchPrefixRules,
    branchPrefixRuleMatched: matchedBranchRule || null,
    branchIncludeTicketId: Boolean(branchIncludeTicketId),
    gitPreparation: gitPreparation || null,
    rules: rulesText,
    columnValues: Array.isArray(item?.column_values) ? item.column_values : [],
    updates: normalizedUpdates,
  };
}

async function writeIntakeFiles(config, context, promptText) {
  const outputDir = path.isAbsolute(config.outputDir)
    ? config.outputDir
    : path.resolve(process.cwd(), config.outputDir);
  const handoffDir = path.isAbsolute(config.handoffDir)
    ? config.handoffDir
    : path.resolve(process.cwd(), config.handoffDir);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(handoffDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeTitle = slugifyForBranch(context.ticket.title || 'ticket', 36);
  const baseName = `${context.ticket.id}-${safeTitle}-${timestamp}`;

  const promptPath = path.join(outputDir, `${baseName}.prompt.md`);
  const contextPath = path.join(outputDir, `${baseName}.context.json`);

  await fs.writeFile(promptPath, `${promptText}\n`, 'utf8');
  await fs.writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`, 'utf8');

  const branchLabel =
    String(context.gitPreparation?.preparedBranch || '').trim() || context.branchCandidate;
  let handoffPath = '';
  let handoffBaseName = '';
  let handoffAliasPath = '';
  let handoffWriteMode = 'full-ticket';
  let retriggerUpdate = null;
  if (config.ideHandoff) {
    const shouldUseRetriggerLatestOnly = Boolean(
      config.handoffRetriggerLatestOnly && context.gitPreparation?.reusedExistingBranch,
    );
    if (shouldUseRetriggerLatestOnly) {
      handoffWriteMode = 'retrigger-latest-only';
      retriggerUpdate = extractLatestUpdateDetails(context);
    }

    handoffBaseName = `${sanitizeBranchForHandoffFilename(branchLabel)}.agent-handoff`;
    handoffPath = path.join(handoffDir, `${handoffBaseName}.md`);
    const handoffPrompt = shouldUseRetriggerLatestOnly
      ? buildRetriggerLatestOnlyPrompt({
          context,
          branchLabel,
          promptPath: resolveRepoRelativePath(promptPath),
          contextPath: resolveRepoRelativePath(contextPath),
          latestUpdate: retriggerUpdate || extractLatestUpdateDetails(context),
        })
      : promptText;
    const handoffBody = buildIdeHandoffBody({
      branchLabel,
      relativeHandoffPath: resolveRepoRelativePath(handoffPath),
      archiveHandoffPath: '',
      promptText: handoffPrompt,
    });
    await fs.writeFile(handoffPath, ensureTrailingNewline(handoffBody), 'utf8');

    if (config.handoffAliasFile) {
      handoffAliasPath = path.isAbsolute(config.handoffAliasFile)
        ? config.handoffAliasFile
        : path.resolve(process.cwd(), config.handoffAliasFile);
      await fs.mkdir(path.dirname(handoffAliasPath), { recursive: true });
      const aliasBody = buildIdeHandoffBody({
        branchLabel,
        relativeHandoffPath: resolveRepoRelativePath(handoffAliasPath),
        archiveHandoffPath: resolveRepoRelativePath(handoffPath),
        promptText: handoffPrompt,
      });
      await fs.writeFile(handoffAliasPath, ensureTrailingNewline(aliasBody), 'utf8');
    }
  }

  return {
    outputDir,
    handoffDir,
    promptPath,
    contextPath,
    baseName,
    handoffPath: handoffPath || null,
    handoffBaseName: handoffBaseName || null,
    handoffAliasPath: handoffAliasPath || null,
    handoffWriteMode,
    retriggerUpdate: retriggerUpdate
      ? {
          found: Boolean(retriggerUpdate.found),
          id: retriggerUpdate.id,
          createdAt: retriggerUpdate.createdAt,
          author: retriggerUpdate.author,
        }
      : null,
  };
}

async function dispatchAgent(config, files, context, gitPreparation) {
  const configuredCommand = String(config.agentCommand || '').trim();
  if (!configuredCommand) {
    fail(
      'Dispatch requested but MONDAY_AGENT_COMMAND is not configured. ' +
        'Set it in .monday.local or pass --agent-command.',
    );
  }

  let chatId = '';
  if (config.agentCreateChat) {
    chatId = await createCursorChatId(config);
    print(`Created Cursor chat session: ${chatId}`, colors.green);
  }

  let command = injectResumeFlagIfNeeded(configuredCommand, chatId);
  command = adaptCursorAgentCommandForHeadless(command, config.agentHeadlessPrint);

  const env = buildCursorAgentChildEnv(config, {
    MONDAY_AGENT_PROMPT_FILE: files.promptPath,
    MONDAY_AGENT_CONTEXT_FILE: files.contextPath,
    MONDAY_AGENT_IDE_HANDOFF_FILE: files.handoffPath ? resolveRepoRelativePath(files.handoffPath) : '',
    MONDAY_AGENT_IDE_HANDOFF_ALIAS_FILE: files.handoffAliasPath
      ? resolveRepoRelativePath(files.handoffAliasPath)
      : '',
    MONDAY_AGENT_ITEM_ID: context.ticket.id,
    MONDAY_AGENT_ITEM_NAME: context.ticket.title,
    MONDAY_AGENT_BRANCH_CANDIDATE: context.branchCandidate,
    MONDAY_AGENT_CHAT_ID: chatId,
    MONDAY_AGENT_BASE_BRANCH: String(gitPreparation?.baseBranch || ''),
    MONDAY_AGENT_GIT_REMOTE: String(gitPreparation?.remote || ''),
    MONDAY_AGENT_PREPARED_BRANCH: String(gitPreparation?.preparedBranch || ''),
    MONDAY_AGENT_PREPARED_HEAD_SHA: String(gitPreparation?.headSha || ''),
    MONDAY_AGENT_PREPARED_BRANCH_REUSED: String(Boolean(gitPreparation?.reusedExistingBranch)),
    MONDAY_AGENT_PREPARED_BRANCH_SOURCE: String(gitPreparation?.branchSource || ''),
  });

  if (config.unsetCursorApiKey && String(process.env.CURSOR_API_KEY || '').trim()) {
    print(
      'MONDAY_AGENT_UNSET_CURSOR_API_KEY: omitting CURSOR_API_KEY for cursor-agent (use login session).',
      colors.dim,
    );
  }

  print(`Dispatching agent command: ${command}`, colors.cyan);
  if (config.agentHeadlessPrint && /\s--print\b/.test(command)) {
    print(
      'Headless mode: output stays in this terminal. For a visible Cursor Agent chat, set MONDAY_AGENT_HEADLESS_PRINT=false and run from a desktop terminal (see scripts/MONDAY_AGENT_INTAKE.md).',
      colors.dim,
    );
  }

  await new Promise((resolve, reject) => {
    const child = spawn('bash', ['-lc', command], {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Agent command terminated by signal: ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Agent command failed with exit code: ${code}`));
        return;
      }
      resolve();
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

function printUsage() {
  print('');
  print('monday ticket -> agent intake', colors.cyan);
  print('');
  print('Usage:');
  print('  node scripts/monday-agent-intake.js --item-id <id> [--dispatch]');
  print('');
  print('Options:');
  print('  --workspace <path>');
  print('  --item-id <id> (required)');
  print('  --max-updates <n>');
  print('  --output-dir <dir>');
  print('  --handoff-dir <dir>');
  print('  --handoff-alias-file <path|false> (default monday-handoff.md)');
  print('  --handoff-retrigger-latest-only true|false (default true)');
  print('  --handoff-append-last-update-on-retrigger true|false (legacy alias)');
  print('  --rules-file <path>');
  print('  --branch-prefix <prefix>');
  print('  --branch-prefix-rules "id:bugs=fix,id:epics_backlog=feat,bugs=fix,epics backlog=feat"');
  print('  --branch-include-ticket-id true|false');
  print('  --git-prepare-branch true|false');
  print('  --git-base-branch <branch>');
  print('  --git-remote <remote>');
  print('  --git-require-clean-worktree true|false');
  print('  --agent-create-chat true|false');
  print('  --agent-create-chat-command "<shell command>"');
  print('  --unset-cursor-api-key true|false (default true: use cursor-agent login, not CURSOR_API_KEY)');
  print('  --agent-headless-print true|false (default true: terminal-only --print; false: try IDE Agent UI)');
  print('  --ide-handoff true|false (default true: write <branch>.agent-handoff.md for @ in IDE Agent)');
  print('  --dispatch');
  print('  --agent-command "<shell command>"');
  print('  --env-file <path>');
  print('');
  print('Environment (optional):');
  print('  MONDAY_AGENT_COMMAND');
  print('  MONDAY_AGENT_OUTPUT_DIR');
  print('  MONDAY_AGENT_HANDOFF_DIR');
  print('  MONDAY_AGENT_HANDOFF_ALIAS_FILE');
  print('  MONDAY_AGENT_HANDOFF_RETRIGGER_LATEST_ONLY');
  print('  MONDAY_AGENT_HANDOFF_APPEND_LAST_UPDATE_ON_RETRIGGER (legacy alias)');
  print('  MONDAY_AGENT_RULES_FILE');
  print('  MONDAY_AGENT_BRANCH_PREFIX');
  print('  MONDAY_AGENT_BRANCH_PREFIX_RULES');
  print('  MONDAY_AGENT_BRANCH_INCLUDE_TICKET_ID');
  print('  MONDAY_AGENT_GIT_PREPARE_BRANCH');
  print('  MONDAY_AGENT_GIT_BASE_BRANCH');
  print('  MONDAY_AGENT_GIT_REMOTE');
  print('  MONDAY_AGENT_GIT_REQUIRE_CLEAN_WORKTREE');
  print('  MONDAY_AGENT_CREATE_CHAT');
  print('  MONDAY_AGENT_CREATE_CHAT_COMMAND');
  print('  MONDAY_AGENT_UNSET_CURSOR_API_KEY');
  print('  MONDAY_AGENT_HEADLESS_PRINT');
  print('  MONDAY_AGENT_IDE_HANDOFF');
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
  print(`item: ${config.itemId}`, colors.dim);
  print(`dispatch: ${config.dispatch ? 'yes' : 'no'}`, colors.dim);
  if (config.dispatch) {
    print(
      `git prep: ${config.gitPrepareBranch ? 'enabled' : 'disabled'} (base=${config.gitBaseBranch}, remote=${config.gitRemote})`,
      colors.dim,
    );
    print(`cursor chat creation: ${config.agentCreateChat ? 'enabled' : 'disabled'}`, colors.dim);
    print(
      `cursor-agent env: ${config.unsetCursorApiKey ? 'CURSOR_API_KEY omitted (login session)' : 'CURSOR_API_KEY passed through if set'}`,
      colors.dim,
    );
    print(
      `cursor-agent UI: ${config.agentHeadlessPrint ? 'headless (--print) unless removed from MONDAY_AGENT_COMMAND' : 'interactive (no --print in command after adaptation)'}`,
      colors.dim,
    );
  }

  const item = await getItemDetails(config);
  const columnMap = buildColumnMap(item);
  const statusText = getStatusTextFromColumns(columnMap);
  const sectionContext = resolveSectionContext(item);
  const branchResolution = buildBranchCandidate(
    config.branchPrefix,
    item,
    sectionContext,
    config.branchPrefixRules,
    config.branchIncludeTicketId,
  );
  const branchCandidate = branchResolution.branchCandidate;
  const resolvedPrefix = branchResolution.resolvedPrefix;
  const matchedBranchRule = branchResolution.matchedRule;
  const branchIncludeTicketId = branchResolution.includeTicketId;
  let gitPreparation = null;

  if (config.dispatch && config.gitPrepareBranch) {
    gitPreparation = await prepareGitBranch(config, branchCandidate);
    const branchMode = gitPreparation.reusedExistingBranch
      ? `reused existing (${gitPreparation.branchSource})`
      : `created from ${gitPreparation.remote}/${gitPreparation.baseBranch}`;
    print(
      `Git prepared: base=${gitPreparation.baseBranch} remote=${gitPreparation.remote} branch=${gitPreparation.preparedBranch} @ ${gitPreparation.headSha} [${branchMode}]`,
      colors.green,
    );
  } else if (config.dispatch && !config.gitPrepareBranch) {
    print('Git branch preparation disabled (MONDAY_AGENT_GIT_PREPARE_BRANCH=false).', colors.yellow);
  }

  const rulesText = await readRulesText(config.rulesFile);

  const promptText = buildPrompt({
    item,
    statusText,
    branchCandidate,
    rulesText,
    sectionContext,
    resolvedPrefix,
    gitPreparation,
  });
  const context = buildContextObject({
    item,
    statusText,
    branchCandidate,
    rulesText,
    sectionContext,
    resolvedPrefix,
    branchPrefixRules: config.branchPrefixRules,
    matchedBranchRule,
    branchIncludeTicketId,
    gitPreparation,
  });
  const files = await writeIntakeFiles(config, context, promptText);

  print(`Prompt file: ${files.promptPath}`, colors.green);
  print(`Context file: ${files.contextPath}`, colors.green);
  if (files.handoffPath) {
    print(
      `IDE handoff (@ this file in Cursor Agent): ${resolveRepoRelativePath(files.handoffPath)}`,
      colors.green,
    );
  }
  if (files.handoffAliasPath) {
    print(
      `Stable handoff alias (@ this file in Cursor Agent): ${resolveRepoRelativePath(files.handoffAliasPath)}`,
      colors.green,
    );
  }
  if (files.handoffWriteMode === 'retrigger-latest-only') {
    print(
      'Retrigger mode: handoff rewritten to latest monday update only (full ticket context intentionally omitted).',
      colors.yellow,
    );
    if (files.retriggerUpdate) {
      print(
        `Latest monday update: id=${files.retriggerUpdate.id} at ${files.retriggerUpdate.createdAt} by ${files.retriggerUpdate.author}`,
        colors.dim,
      );
    }
    if (files.retriggerUpdate && !files.retriggerUpdate.found) {
      print('No monday updates found; handoff contains minimal retrigger metadata only.', colors.dim);
    }
  }
  print(
    `Section: ${sectionContext.sectionTitle || '(unknown)'} [id=${sectionContext.sectionId || '(none)'}] (${sectionContext.source}) -> prefix ${resolvedPrefix}`,
    colors.green,
  );
  print(`Branch includes ticket ID: ${branchIncludeTicketId ? 'yes' : 'no'}`, colors.green);
  if (matchedBranchRule) {
    print(
      `Matched branch rule: ${matchedBranchRule.matchType}:${matchedBranchRule.match} => ${matchedBranchRule.prefix}`,
      colors.green,
    );
  } else {
    print('Matched branch rule: fallback prefix (no section rule matched)', colors.yellow);
  }
  print(`Branch candidate: ${branchCandidate}`, colors.green);
  if (gitPreparation) {
    const preparedSource = gitPreparation.reusedExistingBranch
      ? gitPreparation.branchSource === 'remote-existing'
        ? `existing remote branch ${gitPreparation.remote}/${gitPreparation.preparedBranch}`
        : 'existing local branch'
      : `${gitPreparation.remote}/${gitPreparation.baseBranch}`;
    print(
      `Prepared git branch: ${gitPreparation.preparedBranch} (from ${preparedSource})`,
      colors.green,
    );
  }

  if (config.dispatch) {
    await dispatchAgent(config, files, context, gitPreparation);
    print('Agent dispatch completed.', colors.green);
  } else {
    print('Dispatch skipped (use --dispatch to run agent command).', colors.yellow);
  }

  return 0;
}

main().catch((error) => {
  print(`Error: ${error?.message || String(error)}`, colors.red);
  process.exit(1);
});
