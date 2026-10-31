import { shell } from 'electron';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StartupItem } from '../../shared/types';

interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(file: string, args: string[], timeout = 15000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0;
      resolve({ ok: !err, code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/* ---------- Windows registry helpers (also used by apps.ts) ---------- */

const CODEPAGE_LABELS: Record<number, string> = {
  866: 'ibm866', 874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5',
  1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253',
  1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257',
  1258: 'windows-1258', 20866: 'koi8-r', 28591: 'iso-8859-1', 65001: 'utf-8',
};

let oemDecoder: Promise<TextDecoder> | null = null;

/** reg.exe prints in the console's OEM code page (866 on Russian Windows), not UTF-8. */
function getOemDecoder(): Promise<TextDecoder> {
  oemDecoder ??= new Promise((resolve) => {
    execFile(path.join(systemRoot(), 'System32', 'chcp.com'), [], { timeout: 5000, windowsHide: true }, (_err, stdout) => {
      const cp = Number(/(\d{3,5})\s*$/.exec(String(stdout ?? '').trim())?.[1] ?? 0);
      const label = CODEPAGE_LABELS[cp] ?? 'windows-1252';
      try {
        resolve(new TextDecoder(label));
      } catch {
        resolve(new TextDecoder('windows-1252'));
      }
    });
  });
  return oemDecoder;
}

export interface RegValue {
  type: string;
  data: string;
}

export interface RegKey {
  path: string;
  values: Map<string, RegValue>;
}

/** A 32-bit build on 64-bit Windows would otherwise read and write the redirected registry view. */
const REG_VIEW = process.env.PROCESSOR_ARCHITEW6432 ? ['/reg:64'] : [];

const VALUE_LINE = /^ {4}(.+?) {4}(REG_[A-Z0-9_]+)(?: {4}(.*))?$/;

/** Runs `reg query` and parses keys with their values. Missing keys yield []. */
export async function regQuery(key: string, recursive = false): Promise<RegKey[]> {
  if (process.platform !== 'win32') return [];
  const decoder = await getOemDecoder();
  const args = ['query', key, ...REG_VIEW];
  if (recursive) args.push('/s');
  const raw = await new Promise<Buffer | null>((resolve) => {
    execFile(path.join(systemRoot(), 'System32', 'reg.exe'), args, { timeout: 30000, windowsHide: true, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout));
  });
  if (!raw) return [];
  const keys: RegKey[] = [];
  let current: RegKey | null = null;
  for (const line of decoder.decode(raw).split(/\r?\n/)) {
    if (line.startsWith('HKEY_')) {
      current = { path: line.trim(), values: new Map() };
      keys.push(current);
      continue;
    }
    const m = VALUE_LINE.exec(line);
    if (m && current) current.values.set(m[1], { type: m[2], data: (m[3] ?? '').trim() });
  }
  return keys;
}

/** A name decoded from the OEM code page may have lost characters; writing it back would hit the wrong value. */
function isLossless(name: string): boolean {
  // reg.exe prints the unnamed default value as a localized "(Default)" placeholder, not a real name.
  return !name.includes('\uFFFD') && !name.includes('?') && !/^\(.*\)$/.test(name) && name.trim() === name
    && !/[\0-\x1f]/.test(name);
}

/* ---------- Impact heuristics ---------- */

const HEAVY = [
  /\bteams\b/i, /msteams/i, /discord/i, /spotify/i, /steam/i, /epic ?games/i, /\bEA(desktop| app)?\b/, /\borigin\b/i,
  /battle\.net/i, /onedrive/i, /dropbox/i, /google ?drive/i, /googledrivefs/i, /adobe/i, /creative ?cloud/i, /\bzoom\b/i,
  /slack/i, /skype/i, /\bopera\b/i, /edgeautolaunch/i, /msedge/i, /docker/i, /ubisoft/i, /riot/i, /telegram/i, /whatsapp/i,
  /icloud/i, /nvidia ?broadcast/i, /razer/i, /logi ?options/i,
];
const LIGHT = [
  /update/i, /updater/i, /helper/i, /crashpad/i, /notifier/i, /securityhealth/i, /\bctfmon\b/i, /\bagent\b/i,
  /\btray\b/i, /launchd?helper/i, /keystone/i, /bluetooth/i, /audio/i, /realtek/i, /synaptics/i,
];

function impactOf(name: string, command: string): StartupItem['impact'] {
  const hay = `${name} ${command}`;
  if (HEAVY.some((r) => r.test(hay))) return 'high';
  if (LIGHT.some((r) => r.test(hay))) return 'low';
  return 'medium';
}

/* ---------- Windows ---------- */

const RUN = 'Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN32 = 'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run';
const APPROVED = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved';

interface WinSource {
  prefix: string;
  runKey: string;
  approvedKey: string;
  location: string;
  /** all-users entries live under HKLM, so changing them needs a UAC prompt */
  elevated: boolean;
}

const WIN_SOURCES: WinSource[] = [
  { prefix: 'hkcu-run', runKey: `HKCU\\${RUN}`, approvedKey: `HKCU\\${APPROVED}\\Run`, location: '注册表（当前用户）', elevated: false },
  { prefix: 'hklm-run', runKey: `HKLM\\${RUN}`, approvedKey: `HKLM\\${APPROVED}\\Run`, location: '注册表（所有用户）', elevated: true },
  { prefix: 'hklm-run32', runKey: `HKLM\\${RUN32}`, approvedKey: `HKLM\\${APPROVED}\\Run32`, location: '注册表（所有用户）', elevated: true },
];

/** What setStartup needs to flip an entry; never derived from renderer input. */
interface WinTarget {
  approvedKey: string;
  valueName: string;
  elevated: boolean;
}

const winTargets = new Map<string, WinTarget>();

async function approvedStates(key: string): Promise<Map<string, boolean>> {
  const states = new Map<string, boolean>();
  const [k] = await regQuery(key);
  for (const [name, v] of k?.values ?? []) {
    if (v.type !== 'REG_BINARY' || v.data.length < 2) continue;
    const first = parseInt(v.data.slice(0, 2), 16);
    // 02/06 = enabled, 03/07 = disabled: the low bit means "off".
    states.set(name.toLowerCase(), (first & 1) === 0);
  }
  return states;
}

function expandEnv(p: string): string {
  return p.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase());
    return (key && process.env[key]) || whole;
  });
}

async function listFolder(
  dir: string, approvedKey: string, prefix: string, location: string, elevated: boolean, items: StartupItem[],
): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const states = await approvedStates(approvedKey);
  for (const file of names) {
    if (file.toLowerCase() === 'desktop.ini') continue;
    const full = path.join(dir, file);
    let command = full;
    if (file.toLowerCase().endsWith('.lnk')) {
      try {
        const link = shell.readShortcutLink(full);
        command = link.args ? `"${link.target}" ${link.args}` : link.target;
      } catch {
        // Unresolvable shortcut: show the .lnk itself.
      }
    }
    const name = file.replace(/\.(lnk|url|bat|cmd|exe)$/i, '');
    const id = `win:${prefix}:${file}`;
    const canToggle = isLossless(file);
    if (canToggle) winTargets.set(id, { approvedKey, valueName: file, elevated });
    items.push({
      id, name, command, location,
      enabled: states.get(file.toLowerCase()) ?? true,
      impact: impactOf(name, command),
      canToggle,
      needsAdmin: elevated,
    });
  }
}

async function listWindows(): Promise<StartupItem[]> {
  winTargets.clear();
  const items: StartupItem[] = [];
  await Promise.all(WIN_SOURCES.map(async (src) => {
    const [[runKey], states] = await Promise.all([regQuery(src.runKey), approvedStates(src.approvedKey)]);
    for (const [valueName, v] of runKey?.values ?? []) {
      if (!v.data) continue;
      const command = expandEnv(v.data);
      const id = `win:${src.prefix}:${valueName}`;
      const canToggle = isLossless(valueName);
      if (canToggle) winTargets.set(id, { approvedKey: src.approvedKey, valueName, elevated: src.elevated });
      items.push({
        id,
        name: prettyName(valueName, command),
        command,
        location: src.location,
        enabled: states.get(valueName.toLowerCase()) ?? true,
        impact: impactOf(valueName, command),
        canToggle,
        needsAdmin: src.elevated,
      });
    }
  }));

  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  const programData = process.env.ProgramData ?? 'C:\\ProgramData';
  const folderTail = path.join('Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  await listFolder(path.join(appData, folderTail), `HKCU\\${APPROVED}\\StartupFolder`, 'folder', '启动文件夹', false, items);
  await listFolder(path.join(programData, folderTail), `HKLM\\${APPROVED}\\StartupFolder`, 'folder-all', '启动文件夹（所有用户）', true, items);
  return items;
}

/** Turns "MicrosoftEdgeAutoLaunch_45AF..." or "electron.app.Notion" into something readable. */
function prettyName(valueName: string, command: string): string {
  let name = valueName.replace(/_[0-9A-F]{16,}$/i, '').replace(/^electron\.app\./i, '');
  if (/^MicrosoftEdgeAutoLaunch$/i.test(name)) name = 'Microsoft Edge';
  else if (/^GoogleChromeAutoLaunch$/i.test(name)) name = 'Google Chrome';
  if (!name.trim()) {
    const exe = /([^\\/"]+)\.exe/i.exec(command)?.[1];
    name = exe ?? valueName;
  }
  return name;
}

const systemRoot = () => process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';

/** Quotes one argument so CommandLineToArgvW reads it back unchanged. */
function winArg(a: string): string {
  if (a && !/[\s"]/.test(a)) return a;
  return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/** PowerShell single-quoted literal; PowerShell also treats typographic single quotes as quotes. */
const psLiteral = (s: string) => `'${s.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`;

const UAC_CANCELLED = 1223;

/**
 * Runs one program elevated (UAC prompt) and waits for it.
 * Exit codes of elevated children are unreliable in Windows PowerShell 5.1, so callers verify the effect themselves;
 * this only tells them whether the prompt was declined.
 */
async function runElevated(file: string, args: string[]): Promise<'done' | 'cancelled'> {
  const argLine = args.map(winArg).join(' ');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `try { $p = Start-Process -FilePath ${psLiteral(file)} -ArgumentList ${psLiteral(argLine)} -Verb RunAs -WindowStyle Hidden -PassThru } catch { exit ${UAC_CANCELLED} }`,
    // keep the process handle before it exits, otherwise ExitCode and WaitForExit can lose track of it
    '$null = $p.Handle',
    '$p.WaitForExit()',
    'exit 0',
  ].join('; ');
  const powershell = path.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const res = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], 180000);
  return res.code === UAC_CANCELLED ? 'cancelled' : 'done';
}

async function setWindows(id: string, enabled: boolean): Promise<void> {
  if (winTargets.size === 0) await listWindows();
  const target = winTargets.get(id);
  if (!target) throw new Error('此项目无法通过 Cleanly 修改');
  // Same 12-byte value Task Manager writes; deleting it would also mean "enabled".
  const data = (enabled ? '02' : '03') + '0'.repeat(22);
  const args = ['add', target.approvedKey, '/v', target.valueName, '/t', 'REG_BINARY', '/d', data, '/f', ...REG_VIEW];
  let outcome: 'done' | 'cancelled' = 'done';
  if (target.elevated) {
    outcome = await runElevated(path.join(systemRoot(), 'System32', 'reg.exe'), args);
  } else {
    await run(path.join(systemRoot(), 'System32', 'reg.exe'), args);
  }
  // the registry is the source of truth: whatever the exit codes said, check what is actually stored now
  const now = (await approvedStates(target.approvedKey)).get(target.valueName.toLowerCase()) ?? true;
  if (now === enabled) return;
  if (outcome === 'cancelled') throw new Error('未在 Windows 提示中授予权限，因此未做任何更改');
  throw new Error(target.elevated
    ? 'Windows 未允许此更改。请重试并在权限提示中选择“是”。'
    : 'Windows 未允许此更改');
}

/* ---------- macOS ---------- */

interface MacTarget {
  label: string;
  plist: string;
  /** /Library/LaunchAgents: may need the admin password */
  elevated: boolean;
}

const macTargets = new Map<string, MacTarget>();
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const SAFE_PLIST = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,200}\.plist$/;

async function readPlist(file: string): Promise<Record<string, unknown> | null> {
  const res = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], 8000);
  if (!res.ok) return null;
  try {
    return JSON.parse(res.stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function uid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : 501;
}

async function loadedLabels(): Promise<Set<string>> {
  const res = await run('/bin/launchctl', ['list']);
  const labels = new Set<string>();
  for (const line of res.stdout.split('\n').slice(1)) {
    const label = line.split('\t')[2]?.trim();
    if (label) labels.add(label);
  }
  return labels;
}

/** launchd's persistent enable/disable overrides for this user's GUI domain. */
async function disabledOverrides(): Promise<Map<string, boolean>> {
  const res = await run('/bin/launchctl', ['print-disabled', `gui/${uid()}`]);
  const map = new Map<string, boolean>();
  for (const m of res.stdout.matchAll(/"([^"]+)"\s*=>\s*(\w+)/g)) {
    map.set(m[1], m[2] === 'disabled' || m[2] === 'true');
  }
  return map;
}

async function listMacDir(
  dir: string, prefix: string, location: string, elevated: boolean,
  loaded: Set<string>, overrides: Map<string, boolean>, items: StartupItem[],
): Promise<void> {
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.plist'));
  } catch {
    return;
  }
  await Promise.all(names.map(async (file) => {
    const full = path.join(dir, file);
    try {
      if ((await fs.lstat(full)).isSymbolicLink()) return;
    } catch {
      return;
    }
    const plist = await readPlist(full);
    if (!plist) return;
    const label = typeof plist.Label === 'string' ? plist.Label : file.replace(/\.plist$/, '');
    const argv = Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments.map(String) : [];
    const program = typeof plist.Program === 'string' ? plist.Program : argv[0] ?? '';
    const command = argv.length ? argv.join(' ') : program;
    const override = overrides.get(label);
    const enabled = loaded.has(label) || (override !== undefined ? !override : plist.Disabled !== true);
    const id = `mac:${prefix}:${label}`;
    // Elevated commands are built from the label and file name, so only plain ones qualify.
    const canToggle = !elevated || (SAFE_LABEL.test(label) && SAFE_PLIST.test(file));
    if (canToggle) macTargets.set(id, { label, plist: full, elevated });
    items.push({
      id,
      name: macName(label, program),
      command,
      location,
      enabled,
      impact: impactOf(label, command),
      canToggle,
      needsAdmin: elevated,
    });
  }));
}

function macName(label: string, program: string): string {
  const app = /\/([^/]+)\.app\//.exec(program)?.[1];
  if (app) return app;
  const parts = label.split('.');
  return parts.length > 2 ? parts.slice(2).join(' ') || label : label;
}

async function listMac(): Promise<StartupItem[]> {
  macTargets.clear();
  const [loaded, overrides] = await Promise.all([loadedLabels(), disabledOverrides()]);
  const items: StartupItem[] = [];
  await listMacDir(path.join(os.homedir(), 'Library', 'LaunchAgents'), 'user', 'LaunchAgents', false, loaded, overrides, items);
  await listMacDir('/Library/LaunchAgents', 'system', 'LaunchAgents（所有用户）', true, loaded, overrides, items);
  return items;
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const appleScriptString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

async function setMac(id: string, enabled: boolean): Promise<void> {
  if (macTargets.size === 0) await listMac();
  const target = macTargets.get(id);
  if (!target) throw new Error('此项目无法通过 Cleanly 修改');
  // LaunchAgents (also the all-users ones) run in each user's GUI domain, not in "system".
  const domain = `gui/${uid()}`;
  const service = `${domain}/${target.label}`;
  // enable/disable persists across logins; bootstrap/bootout applies it right now.
  const persist = await run('/bin/launchctl', [enabled ? 'enable' : 'disable', service]);
  if (persist.ok) {
    await run('/bin/launchctl', enabled ? ['bootstrap', domain, target.plist] : ['bootout', domain, target.plist]);
    return;
  }
  if (!target.elevated) throw new Error('macOS 未允许此更改');
  if (!SAFE_LABEL.test(target.label) || !SAFE_PLIST.test(path.basename(target.plist))) {
    throw new Error('此项目无法通过 Cleanly 修改');
  }
  const cmd = enabled
    ? `/bin/launchctl enable ${shQuote(service)} && (/bin/launchctl bootstrap ${shQuote(domain)} ${shQuote(target.plist)} || true)`
    : `/bin/launchctl disable ${shQuote(service)} && (/bin/launchctl bootout ${shQuote(domain)} ${shQuote(target.plist)} || true)`;
  const res = await run('/usr/bin/osascript', ['-e', `do shell script ${appleScriptString(cmd)} with administrator privileges`], 180000);
  if (!res.ok) throw new Error('macOS 未允许此更改');
}

/* ---------- Public API ---------- */

export async function listStartup(): Promise<StartupItem[]> {
  let items: StartupItem[] = [];
  try {
    if (process.platform === 'win32') items = await listWindows();
    else if (process.platform === 'darwin') items = await listMac();
  } catch {
    items = [];
  }
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return items.sort((a, b) => rank[a.impact] - rank[b.impact] || a.name.localeCompare(b.name));
}

export async function setStartup(id: unknown, enabled: unknown): Promise<StartupItem[]> {
  if (typeof id !== 'string' || id.length > 600 || typeof enabled !== 'boolean') throw new Error('请求无效');
  if (process.platform === 'win32') await setWindows(id, enabled);
  else if (process.platform === 'darwin') await setMac(id, enabled);
  else throw new Error('此系统不支持管理启动项');
  return listStartup();
}
