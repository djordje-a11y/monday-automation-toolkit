#!/usr/bin/env node
/**
 * monday automation stop helper
 *
 * Stops monday automation processes started manually or by monday:automation:start:
 * - bridge: scripts/monday-webhook-bridge.js
 * - tunnel: ngrok http <bridgePort> (optional)
 *
 * Strategy:
 * 1) Prefer PIDs from runtime file when available.
 * 2) Fallback to process-table discovery for stale/reused processes.
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

const DEFAULT_LOCAL_ENV_FILES = ['.monday.local', '.env.local', 'scripts/.monday.local'];
const DEFAULT_BRIDGE_PORT = 8787;
const DEFAULT_RUNTIME_FILE = '.monday/runtime.json';
const DEFAULT_WAIT_MS = 2500;

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
  const keys = ['MONDAY_WEBHOOK_PORT', 'MONDAY_AUTOMATION_RUNTIME_FILE', 'MONDAY_ENV_FILE'];
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
      const next = String(parsed[key] || '').trim();
      if (!next) continue;
      values[key] = next;
    }
  }

  return {
    values,
    source,
  };
}

function buildRuntimeConfig(args, envValues) {
  const bridgePort = parseInteger(
    getOptionalArg(
      args,
      'bridge-port',
      process.env.MONDAY_WEBHOOK_PORT || envValues.MONDAY_WEBHOOK_PORT || String(DEFAULT_BRIDGE_PORT),
    ),
    DEFAULT_BRIDGE_PORT,
  );
  const runtimeFile = getOptionalArg(
    args,
    'runtime-file',
    process.env.MONDAY_AUTOMATION_RUNTIME_FILE ||
      envValues.MONDAY_AUTOMATION_RUNTIME_FILE ||
      DEFAULT_RUNTIME_FILE,
  );
  return {
    bridgePort,
    runtimeFile: path.isAbsolute(runtimeFile) ? runtimeFile : path.resolve(process.cwd(), runtimeFile),
    killTunnel: parseBoolean(
      getOptionalArg(
        args,
        'kill-tunnel',
        process.env.MONDAY_AUTOMATION_STOP_KILL_TUNNEL || 'true',
      ),
      true,
    ),
    waitMs: Math.max(
      250,
      parseInteger(getOptionalArg(args, 'wait-ms', String(DEFAULT_WAIT_MS)), DEFAULT_WAIT_MS),
    ),
    force: parseBoolean(getOptionalArg(args, 'force', 'false'), false) || Boolean(args.force),
    dryRun: parseBoolean(getOptionalArg(args, 'dry-run', 'false'), false) || Boolean(args['dry-run']),
  };
}

function printUsage() {
  print('');
  print('monday automation stop helper', colors.cyan);
  print('');
  print('Usage:');
  print('  node scripts/monday-automation-stop.js');
  print('');
  print('Options:');
  print('  --workspace <path>');
  print('  --env-file <path>');
  print('  --runtime-file <path>');
  print('  --bridge-port <port>');
  print('  --kill-tunnel true|false (default true)');
  print('  --wait-ms <ms> (default 2500)');
  print('  --force (send SIGKILL to survivors after wait)');
  print('  --dry-run');
  print('');
}

async function runBash(command) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-lc', command], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
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

    child.on('exit', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr || `command failed with exit code ${code}`));
    });
    child.on('error', (error) => reject(error));
  });
}

async function listProcesses() {
  const out = await runBash('ps -eo pid=,args=');
  const rows = [];
  for (const rawLine of String(out || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.match(/^(\d+)\s+(.+)$/);
    if (!parts) continue;
    rows.push({
      pid: Number(parts[1]),
      command: String(parts[2] || ''),
    });
  }
  return rows;
}

async function readRuntimeProcessHints(runtimeFile) {
  try {
    const raw = await fs.readFile(runtimeFile, 'utf8');
    const payload = JSON.parse(raw);
    const bridgePid = Number(payload?.bridge?.pid || 0);
    const tunnelPid = Number(payload?.tunnel?.pid || 0);
    return {
      runtimeFileExists: true,
      bridgePid: Number.isFinite(bridgePid) && bridgePid > 0 ? bridgePid : 0,
      tunnelPid: Number.isFinite(tunnelPid) && tunnelPid > 0 ? tunnelPid : 0,
    };
  } catch {
    return {
      runtimeFileExists: false,
      bridgePid: 0,
      tunnelPid: 0,
    };
  }
}

function discoverBridgePids(processes) {
  return processes
    .filter((proc) => proc.command.includes('scripts/monday-webhook-bridge.js'))
    .map((proc) => proc.pid);
}

function discoverTunnelPids(processes, bridgePort) {
  const tunnelPattern = new RegExp(`\\bngrok\\b.*\\bhttp\\b.*\\b${bridgePort}\\b`);
  return processes
    .filter((proc) => tunnelPattern.test(proc.command))
    .map((proc) => proc.pid);
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trySignal(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help || args.h || args._[0] === 'help') {
    printUsage();
    return 0;
  }

  const loadedEnv = await loadMondayEnvValues(args);
  const config = buildRuntimeConfig(args, loadedEnv.values);
  const runtimeHints = await readRuntimeProcessHints(config.runtimeFile);
  const processes = await listProcesses();

  if (loadedEnv.source) {
    print(`monday env source: ${loadedEnv.source}`, colors.dim);
  }
  print(`workspace: ${process.cwd()}`, colors.dim);

  const candidates = new Set();
  if (runtimeHints.bridgePid > 0) candidates.add(runtimeHints.bridgePid);
  if (config.killTunnel && runtimeHints.tunnelPid > 0) candidates.add(runtimeHints.tunnelPid);
  for (const pid of discoverBridgePids(processes)) candidates.add(pid);
  if (config.killTunnel) {
    for (const pid of discoverTunnelPids(processes, config.bridgePort)) candidates.add(pid);
  }

  candidates.delete(process.pid);
  const orderedCandidates = Array.from(candidates).filter((pid) => Number.isFinite(pid) && pid > 0);

  print(
    `Stop scan: bridgePort=${config.bridgePort} killTunnel=${config.killTunnel ? 'yes' : 'no'} runtimeFile=${config.runtimeFile}`,
    colors.dim,
  );
  if (!runtimeHints.runtimeFileExists) {
    print(`Runtime file not found: ${config.runtimeFile} (using process discovery only)`, colors.dim);
  }

  if (orderedCandidates.length === 0) {
    print('No matching monday bridge/tunnel processes found.', colors.yellow);
    return 0;
  }

  const alive = orderedCandidates.filter((pid) => isPidAlive(pid));
  if (alive.length === 0) {
    print('No alive matching processes found (stale PIDs only).', colors.yellow);
    return 0;
  }

  if (config.dryRun) {
    print(`Dry run: would stop PIDs [${alive.join(', ')}]`, colors.cyan);
    return 0;
  }

  const signaled = [];
  for (const pid of alive) {
    const ok = trySignal(pid, 'SIGTERM');
    if (ok) {
      signaled.push(pid);
      print(`Sent SIGTERM to pid ${pid}`, colors.green);
    } else {
      print(`Could not signal pid ${pid}`, colors.yellow);
    }
  }

  if (signaled.length === 0) {
    print('No processes were signaled.', colors.yellow);
    return 0;
  }

  await sleep(config.waitMs);
  let survivors = signaled.filter((pid) => isPidAlive(pid));
  if (survivors.length > 0 && config.force) {
    print(`Force enabled: sending SIGKILL to survivors [${survivors.join(', ')}]`, colors.yellow);
    for (const pid of survivors) {
      trySignal(pid, 'SIGKILL');
    }
    await sleep(300);
    survivors = survivors.filter((pid) => isPidAlive(pid));
  }

  if (survivors.length > 0) {
    print(`Some processes are still alive: [${survivors.join(', ')}]`, colors.red);
    print('Re-run with --force or stop them manually.', colors.yellow);
    return 1;
  }

  print('monday automation processes stopped.', colors.green);
  return 0;
}

main()
  .then((code) => {
    process.exit(code || 0);
  })
  .catch((error) => {
    print(`Error: ${error?.message || String(error)}`, colors.red);
    process.exit(1);
  });
