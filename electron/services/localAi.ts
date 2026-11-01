import { app } from 'electron';
import { execFile } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AiConnections, AiProvider, LocalAiStatus } from '../../shared/types';

const APP_NAMES: Record<AiProvider, string> = { claude: 'Claude Code', chatgpt: 'Codex' };
const isWin = process.platform === 'win32';

/** Keep authentication inside the installed tool; never copy its credential files. */
export function localAiEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|VITE_DEV_SERVER_URL|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_EFFORT_LEVEL|OPENAI_API_KEY|CODEX_API_KEY|CLAUDECODE)$/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

/** Reuse Claude Code's connection without loading its hooks, plugins, or instructions. */
export async function localClaudeEnvironment(): Promise<Record<string, string>> {
  const env = localAiEnvironment();
  env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  const names = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
  for (const name of names) if (process.env[name]) env[name] = process.env[name];
  const configured = process.env.CLAUDE_CONFIG_DIR;
  const dir = configured && localAbsolute(configured) ? configured : path.join(os.homedir(), '.claude');
  try {
    const settings: unknown = JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf8'));
    if (typeof settings !== 'object' || settings === null || !('env' in settings) || typeof settings.env !== 'object' || settings.env === null) return env;
    for (const name of names) {
      if (!(name in settings.env)) continue;
      const value: unknown = Reflect.get(settings.env, name);
      if (typeof value === 'string' && value) env[name] = process.env[name] || value;
    }
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw new Error('Could not read Claude Code connection settings. Check its settings.json file.');
  }
  return env;
}

function localAbsolute(p: string): boolean {
  return path.isAbsolute(p) && !/^[\\/]{2}/.test(p) && (!isWin || /^[a-z]:[\\/]/i.test(p));
}

/** Native executables only: npm's .cmd and .ps1 shims are never executed through a shell. */
export async function findLocalAi(provider: AiProvider): Promise<string | null> {
  const command = provider === 'claude' ? 'claude' : 'codex';
  const home = os.homedir();
  const dirs = [
    path.join(home, '.local', 'bin'),
    ...(isWin ? [path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'OpenAI', 'Codex', 'bin')] : []),
    ...(process.env.PATH || '').split(path.delimiter).map((p) => p.replace(/^"|"$/g, '')),
  ].filter((p) => localAbsolute(p) && path.resolve(p) !== path.resolve(process.cwd()));
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const target = isWin ? (arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc')
    : process.platform === 'darwin' ? (arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin')
    : (arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl');
  const platformName = isWin ? 'win32' : process.platform;
  const candidates = new Set<string>();
  for (const dir of dirs) {
    candidates.add(path.join(dir, command + (isWin ? '.exe' : '')));
    for (const modules of [path.join(dir, 'node_modules'), path.resolve(dir, '../lib/node_modules')]) {
      if (provider === 'claude') candidates.add(path.join(modules, '@anthropic-ai', 'claude-code', 'bin', command + (isWin ? '.exe' : '')));
      else {
        const pkg = path.join(modules, '@openai', 'codex');
        candidates.add(path.join(pkg, 'node_modules', '@openai', `codex-${platformName}-${arch}`, 'vendor', target, 'bin', command + (isWin ? '.exe' : '')));
        candidates.add(path.join(pkg, 'vendor', target, 'bin', command + (isWin ? '.exe' : '')));
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const real = await fs.realpath(candidate);
      if (!localAbsolute(real) || !(await fs.stat(real)).isFile()) continue;
      await fs.access(real, isWin ? constants.F_OK : constants.X_OK);
      return real;
    } catch {
      // Most candidates are optional install locations.
    }
  }
  return null;
}

function run(file: string, args: string[], timeout = 15_000): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024, env: localAiEnvironment() }, (error, stdout, stderr) => {
      resolve({ ok: !error, text: String(stdout || stderr).trim() });
    });
  });
}

async function status(provider: AiProvider): Promise<LocalAiStatus> {
  const appName = APP_NAMES[provider];
  const file = await findLocalAi(provider);
  if (!file) return { kind: 'not-installed', appName };
  if (provider === 'claude') {
    try {
      const env = await localClaudeEnvironment();
      if (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN) return { kind: 'ready', appName };
    } catch {
      return { kind: 'unavailable', appName };
    }
  }
  const result = await run(file, provider === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status']);
  if (provider === 'claude') {
    try {
      const parsed: unknown = JSON.parse(result.text);
      if (typeof parsed === 'object' && parsed !== null && 'loggedIn' in parsed && typeof parsed.loggedIn === 'boolean') {
        return { kind: parsed.loggedIn ? 'ready' : 'signed-out', appName };
      }
    } catch {
      // An older CLI may not support structured auth status.
    }
  } else {
    if (result.ok && /^Logged in using /im.test(result.text)) return { kind: 'ready', appName };
    if (/not logged in|not authenticated/i.test(result.text)) return { kind: 'signed-out', appName };
  }
  return { kind: 'unavailable', appName };
}

export async function getAiConnections(): Promise<AiConnections> {
  const [claude, chatgpt] = await Promise.all([status('claude'), status('chatgpt')]);
  return { claude, chatgpt };
}

export async function signInAi(provider: AiProvider): Promise<AiConnections> {
  if (provider !== 'claude' && provider !== 'chatgpt') throw new Error('Unknown assistant provider.');
  const file = await findLocalAi(provider);
  if (!file) throw new Error(`Install ${APP_NAMES[provider]} first, then check again.`);
  const result = await run(file, provider === 'claude' ? ['auth', 'login'] : ['login'], 180_000);
  if (!result.ok) throw new Error(`Sign-in did not finish. Open ${APP_NAMES[provider]}, sign in there, then choose Check again.`);
  return getAiConnections();
}

export async function localAiWorkingDirectory(): Promise<string> {
  const dir = path.join(app.getPath('userData'), 'assistant-runtime');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Use the SDK's pinned runtime when available, while retaining the user's normal login store. */
export async function codexSdkRuntime(): Promise<string | null> {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const target = isWin ? (arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc')
    : process.platform === 'darwin' ? (arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin')
    : (arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl');
  const platform = isWin ? 'win32' : process.platform;
  const vendor = app.isPackaged ? path.join(process.resourcesPath, 'codex-runtime')
    : path.join(app.getAppPath(), 'node_modules', '@openai', `codex-${platform}-${arch}`, 'vendor');
  const file = path.join(vendor, target, 'bin', isWin ? 'codex.exe' : 'codex');
  try {
    const real = await fs.realpath(file);
    return localAbsolute(real) && (await fs.stat(real)).isFile() ? real : null;
  } catch {
    return null;
  }
}
