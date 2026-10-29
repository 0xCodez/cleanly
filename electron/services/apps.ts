import { shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InstalledApp } from '../../shared/types';
import { regQuery, type RegKey } from './startup';

interface RunResult {
  ok: boolean;
  stdout: string;
}

function run(file: string, args: string[], timeout = 15000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      // On timeout execFile still hands back whatever was printed so far.
      resolve({ ok: !err, stdout: String(stdout ?? '') });
    });
  });
}

const shortHash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/* ---------- Windows ---------- */

const UNINSTALL = 'Microsoft\\Windows\\CurrentVersion\\Uninstall';
const WIN_ROOTS = [
  `HKLM\\SOFTWARE\\${UNINSTALL}`,
  `HKLM\\SOFTWARE\\WOW6432Node\\${UNINSTALL}`,
  `HKCU\\Software\\${UNINSTALL}`,
];

/** id -> uninstall command read from the registry. The renderer only ever sends ids. */
const winCommands = new Map<string, string>();
/** id -> .app path for macOS. */
const macPaths = new Map<string, string>();

function str(key: RegKey, name: string): string | undefined {
  const v = key.values.get(name)?.data.trim();
  return v ? v : undefined;
}

function dword(key: RegKey, name: string): number | undefined {
  const v = key.values.get(name);
  if (!v || !/^REG_(D|Q)WORD$/.test(v.type)) return undefined;
  const n = parseInt(v.data, 16);
  return Number.isFinite(n) ? n : undefined;
}

function parseInstallDate(s?: string): number | undefined {
  const m = s && /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) return undefined;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isFinite(t) && t > 0 ? t : undefined;
}

async function listWindows(): Promise<InstalledApp[]> {
  winCommands.clear();
  const byKey = new Map<string, { app: InstalledApp; command?: string; score: number }>();
  const all = await Promise.all(WIN_ROOTS.map((root) => regQuery(root, true)));
  for (const key of all.flat()) {
    const name = str(key, 'DisplayName');
    if (!name) continue;
    if (dword(key, 'SystemComponent') === 1) continue;
    if (str(key, 'ParentKeyName')) continue;
    const release = str(key, 'ReleaseType');
    if (release && /update|hotfix/i.test(release)) continue;

    const command = str(key, 'UninstallString') ?? str(key, 'QuietUninstallString');
    const kb = dword(key, 'EstimatedSize');
    const location = str(key, 'InstallLocation')?.replace(/^"|"$/g, '');
    const app: InstalledApp = {
      id: `win:${shortHash(key.path.toLowerCase())}`,
      name,
      version: str(key, 'DisplayVersion'),
      publisher: str(key, 'Publisher'),
      size: kb ? kb * 1024 : undefined,
      installed: parseInstallDate(str(key, 'InstallDate')),
      path: location,
      canUninstall: Boolean(command) && dword(key, 'NoRemove') !== 1,
    };
    const score = (app.size ? 2 : 0) + (command ? 4 : 0) + (app.publisher ? 1 : 0);
    const dedupe = `${name.toLowerCase()}|${app.version ?? ''}`;
    const prev = byKey.get(dedupe);
    if (!prev || score > prev.score) byKey.set(dedupe, { app, command, score });
  }
  const apps: InstalledApp[] = [];
  for (const { app, command } of byKey.values()) {
    if (app.canUninstall && command) winCommands.set(app.id, command);
    apps.push(app);
  }
  return apps;
}

/** Makes a registry uninstall string runnable through cmd.exe. */
function normalizeCommand(raw: string): string {
  let cmd = raw.trim();
  // MsiExec /I opens the repair/modify wizard; /X is the actual uninstall.
  cmd = cmd.replace(/^(\S*msiexec(?:\.exe)?\s+)\/I(\s*\{)/i, '$1/X$2');
  if (!cmd.startsWith('"')) {
    // Unquoted "C:\Program Files\Foo\uninst.exe /S" would split at the first space.
    const exe = /^(.+?\.exe)(\s|$)/i.exec(cmd);
    if (exe && exe[1].includes(' ') && existsSync(exe[1])) cmd = `"${exe[1]}"${cmd.slice(exe[1].length)}`;
  }
  return cmd;
}

async function uninstallWindows(id: string): Promise<{ ok: boolean; message: string }> {
  if (winCommands.size === 0) await listWindows();
  const command = winCommands.get(id);
  if (!command) return { ok: false, message: 'This app has no uninstaller' };
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: { ok: boolean; message: string }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    try {
      // shell:true is limited to this registry-sourced string; renderer input never reaches it.
      const child = spawn(normalizeCommand(command), { shell: true, detached: true, stdio: 'ignore', windowsHide: false });
      child.once('error', () => done({ ok: false, message: 'Could not start the uninstaller' }));
      child.once('spawn', () => {
        child.unref();
        done({ ok: true, message: 'The uninstaller is open' });
      });
    } catch {
      done({ ok: false, message: 'Could not start the uninstaller' });
    }
  });
}

/* ---------- macOS ---------- */

interface MacBundle {
  path: string;
  name: string;
  bundleId?: string;
  version?: string;
}

async function findAppBundles(): Promise<string[]> {
  const roots = ['/Applications', path.join(os.homedir(), 'Applications')];
  const found: string[] = [];
  for (const root of roots) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const full = path.join(root, e.name);
      if (e.name.endsWith('.app')) {
        found.push(full);
        continue;
      }
      // Vendors often nest apps one level down, e.g. /Applications/Adobe Photoshop 2025/Adobe Photoshop 2025.app.
      if (e.name === 'Utilities') continue;
      try {
        for (const sub of await fs.readdir(full, { withFileTypes: true })) {
          if (sub.isDirectory() && sub.name.endsWith('.app')) found.push(path.join(full, sub.name));
        }
      } catch {
        // Unreadable folder: skip.
      }
    }
  }
  return found;
}

async function readBundle(appPath: string): Promise<MacBundle> {
  const fallback = path.basename(appPath, '.app');
  const res = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')], 8000);
  if (!res.ok) return { path: appPath, name: fallback };
  try {
    const info = JSON.parse(res.stdout) as Record<string, unknown>;
    const s = (k: string) => (typeof info[k] === 'string' && info[k] ? (info[k] as string) : undefined);
    return {
      path: appPath,
      name: s('CFBundleDisplayName') ?? fallback,
      bundleId: s('CFBundleIdentifier'),
      version: s('CFBundleShortVersionString') ?? s('CFBundleVersion'),
    };
  } catch {
    return { path: appPath, name: fallback };
  }
}

async function duSizes(paths: string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  const chunks: string[][] = [];
  for (let i = 0; i < paths.length; i += 25) chunks.push(paths.slice(i, i + 25));
  await mapLimit(chunks, 3, async (chunk) => {
    const res = await run('/usr/bin/du', ['-sk', ...chunk], 45000);
    for (const line of res.stdout.split('\n')) {
      const m = /^(\d+)\t(.+)$/.exec(line);
      if (m) sizes.set(m[2], Number(m[1]) * 1024);
    }
  });
  return sizes;
}

async function lastUsedDates(paths: string[]): Promise<Map<string, number>> {
  const dates = new Map<string, number>();
  const chunks: string[][] = [];
  for (let i = 0; i < paths.length; i += 50) chunks.push(paths.slice(i, i + 50));
  await mapLimit(chunks, 2, async (chunk) => {
    const res = await run('/usr/bin/mdls', ['-raw', '-name', 'kMDItemLastUsedDate', ...chunk], 20000);
    // With several files and -raw, mdls separates the values with NUL.
    const values = res.stdout.split('\0');
    if (values.length < chunk.length) return;
    chunk.forEach((p, i) => {
      // "2025-03-14 09:26:53 +0000"
      const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/.exec(values[i]?.trim() ?? '');
      if (!m) return;
      const t = Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
      if (Number.isFinite(t)) dates.set(p, t);
    });
  });
  return dates;
}

async function listMac(): Promise<InstalledApp[]> {
  macPaths.clear();
  const bundlePaths = await findAppBundles();
  const [bundles, sizes, used] = await Promise.all([
    mapLimit(bundlePaths, 8, readBundle),
    duSizes(bundlePaths),
    lastUsedDates(bundlePaths),
  ]);
  const apps: InstalledApp[] = [];
  for (const b of bundles) {
    const isApple = (b.bundleId ?? '').startsWith('com.apple.');
    const id = `mac:${shortHash(b.path)}`;
    let installed: number | undefined;
    try {
      installed = Math.round((await fs.stat(b.path)).birthtimeMs) || undefined;
    } catch {
      installed = undefined;
    }
    if (!isApple) macPaths.set(id, b.path);
    apps.push({
      id,
      name: b.name,
      version: b.version,
      publisher: isApple ? 'Apple' : undefined,
      size: sizes.get(b.path),
      installed,
      lastUsed: used.get(b.path),
      path: b.path,
      canUninstall: !isApple,
    });
  }
  return apps;
}

function isAllowedAppPath(p: string): boolean {
  const roots = ['/Applications/', path.join(os.homedir(), 'Applications') + '/'];
  const resolved = path.resolve(p);
  return resolved.endsWith('.app') && roots.some((r) => resolved.startsWith(r)) && !resolved.startsWith('/System/');
}

async function uninstallMac(id: string): Promise<{ ok: boolean; message: string }> {
  if (macPaths.size === 0) await listMac();
  const appPath = macPaths.get(id);
  if (!appPath || !isAllowedAppPath(appPath)) return { ok: false, message: 'This app cannot be removed from Cleanly' };
  try {
    await fs.lstat(appPath);
  } catch {
    return { ok: false, message: 'The app is already gone' };
  }
  try {
    await shell.trashItem(appPath);
    macPaths.delete(id);
    return { ok: true, message: 'Moved to Trash. You can put it back from there' };
  } catch {
    return { ok: false, message: 'macOS needs your permission. Drag the app to the Trash in Finder' };
  }
}

/* ---------- Public API ---------- */

export async function listApps(): Promise<InstalledApp[]> {
  let apps: InstalledApp[] = [];
  try {
    if (process.platform === 'win32') apps = await listWindows();
    else if (process.platform === 'darwin') apps = await listMac();
  } catch {
    apps = [];
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export async function uninstallApp(id: string): Promise<{ ok: boolean; message: string }> {
  if (typeof id !== 'string') return { ok: false, message: 'Invalid request' };
  if (process.platform === 'win32') return uninstallWindows(id);
  if (process.platform === 'darwin') return uninstallMac(id);
  return { ok: false, message: 'Uninstalling is not supported on this system' };
}
