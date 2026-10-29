import { shell } from 'electron';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StartupItem } from '../../shared/types';

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function run(file: string, args: string[], timeout = 15000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
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
    execFile('chcp.com', [], { timeout: 5000, windowsHide: true }, (_err, stdout) => {
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

const VALUE_LINE = /^ {4}(.+?) {4}(REG_[A-Z0-9_]+)(?: {4}(.*))?$/;

/** Runs `reg query` and parses keys with their values. Missing keys yield []. */
export async function regQuery(key: string, recursive = false): Promise<RegKey[]> {
  if (process.platform !== 'win32') return [];
  const decoder = await getOemDecoder();
  const args = ['query', key];
  if (recursive) args.push('/s');
  const raw = await new Promise<Buffer | null>((resolve) => {
    execFile('reg.exe', args, { timeout: 30000, windowsHide: true, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
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
  return !name.includes('\uFFFD') && !name.includes('?') && !/^\(.*\)$/.test(name) && name.trim() === name;
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
  /\btray\b/i,/launchd?helper/i, /keystone/i, /bluetooth/i, /audio/i, /realtek/i, /synaptics/i,
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
  writable: boolean;
}

const WIN_SOURCES: WinSource[] = [
  { prefix: 'hkcu-run', runKey: `HKCU\\${RUN}`, approvedKey: `HKCU\\${APPROVED}\\Run`, location: 'Registry (current user)', writable: true },
  { prefix: 'hklm-run', runKey: `HKLM\\${RUN}`, approvedKey: `HKLM\\${APPROVED}\\Run`, location: 'Registry (all users)', writable: false },
  { prefix: 'hklm-run32', runKey: `HKLM\\${RUN32}`, approvedKey: `HKLM\\${APPROVED}\\Run32`, location: 'Registry (all users)', writable: false },
];

/** What setStartup needs to flip an entry; never derived from renderer input. */
interface WinTarget {
  approvedKey: string;
  valueName: string;
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
  return p.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole);
}

async function listFolder(
  dir: string, approvedKey: string, prefix: string, location: string, writable: boolean, items: StartupItem[],
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
    const canToggle = writable && isLossless(file);
    if (canToggle) winTargets.set(id, { approvedKey, valueName: file });
    items.push({
      id, name, command, location,
      enabled: states.get(file.toLowerCase()) ?? true,
      impact: impactOf(name, command),
      canToggle,
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
      const canToggle = src.writable && isLossless(valueName);
      if (canToggle) winTargets.set(id, { approvedKey: src.approvedKey, valueName });
      items.push({
        id,
        name: prettyName(valueName, command),
        command,
        location: src.location,
        enabled: states.get(valueName.toLowerCase()) ?? true,
        impact: impactOf(valueName, command),
        canToggle,
      });
    }
  }));

  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  const programData = process.env.ProgramData ?? 'C:\\ProgramData';
  const folderTail = path.join('Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  await listFolder(path.join(appData, folderTail), `HKCU\\${APPROVED}\\StartupFolder`, 'folder', 'Startup folder', true, items);
  await listFolder(path.join(programData, folderTail), `HKLM\\${APPROVED}\\StartupFolder`, 'folder-all', 'Startup folder (all users)', false, items);
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

async function setWindows(id: string, enabled: boolean): Promise<void> {
  if (winTargets.size === 0) await listWindows();
  const target = winTargets.get(id);
  if (!target) throw new Error('This item cannot be changed from Cleanly');
  // Same 12-byte value Task Manager writes; deleting it would also mean "enabled".
  const data = (enabled ? '02' : '03') + '0'.repeat(22);
  const res = await run('reg.exe', ['add', target.approvedKey, '/v', target.valueName, '/t', 'REG_BINARY', '/d', data, '/f']);
  if (!res.ok) throw new Error('Windows did not allow this change');
}

/* ---------- macOS ---------- */

interface MacTarget {
  label: string;
  plist: string;
}

const macTargets = new Map<string, MacTarget>();

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
  dir: string, prefix: string, location: string, writable: boolean,
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
    if (writable) macTargets.set(id, { label, plist: full });
    items.push({
      id,
      name: macName(label, program),
      command,
      location,
      enabled,
      impact: impactOf(label, command),
      canToggle: writable,
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
  await listMacDir(path.join(os.homedir(), 'Library', 'LaunchAgents'), 'user', 'LaunchAgents', true, loaded, overrides, items);
  await listMacDir('/Library/LaunchAgents', 'system', 'LaunchAgents (all users)', false, loaded, overrides, items);
  return items;
}

async function setMac(id: string, enabled: boolean): Promise<void> {
  if (macTargets.size === 0) await listMac();
  const target = macTargets.get(id);
  if (!target) throw new Error('This item cannot be changed from Cleanly');
  const domain = `gui/${uid()}`;
  // enable/disable persists across logins; bootstrap/bootout applies it right now.
  if (enabled) {
    const res = await run('/bin/launchctl', ['enable', `${domain}/${target.label}`]);
    if (!res.ok) throw new Error('macOS did not allow this change');
    await run('/bin/launchctl', ['bootstrap', domain, target.plist]);
  } else {
    const res = await run('/bin/launchctl', ['disable', `${domain}/${target.label}`]);
    if (!res.ok) throw new Error('macOS did not allow this change');
    await run('/bin/launchctl', ['bootout', domain, target.plist]);
  }
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

export async function setStartup(id: string, enabled: boolean): Promise<StartupItem[]> {
  if (typeof id !== 'string' || typeof enabled !== 'boolean') throw new Error('Invalid request');
  if (process.platform === 'win32') await setWindows(id, enabled);
  else if (process.platform === 'darwin') await setMac(id, enabled);
  else throw new Error('Startup items are not supported on this system');
  return listStartup();
}
