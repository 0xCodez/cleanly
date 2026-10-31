import { shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InstalledApp } from '../../shared/types';
import { appliesHere, execProgram, isTrue, readDesktopEntry, resolveIcon, xdgDataDirs } from './desktopEntry';
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

function expandEnv(p: string): string {
  return p.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase());
    return (key && process.env[key]) || whole;
  });
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** `"C:\X\x.exe",0` -> `C:\X\x.exe`; DLL icons are skipped because only their generic icon can be shown. */
async function fromDisplayIcon(raw?: string): Promise<string | undefined> {
  if (!raw) return undefined;
  let p = raw.trim().replace(/,\s*-?\d+$/, '').trim();
  const quoted = /^"([^"]+)"$/.exec(p);
  if (quoted) p = quoted[1].trim();
  p = expandEnv(p);
  if (!/^[a-zA-Z]:\\/.test(p) || !/\.(exe|ico|png)$/i.test(p)) return undefined;
  return (await isFile(p)) ? p : undefined;
}

const NOT_MAIN_EXE = /unins|uninst|setup|install|update|crash|helper|elevat|notif|squirrel|reporter|launcher_?stub|vcredist|dotnet/i;
const GENERIC_WORDS = new Set([
  'microsoft', 'windows', 'runtime', 'redistributable', 'tools', 'update', 'driver', 'support', 'software', 'edition',
  'version', 'application', 'desktop', 'client', 'the', 'for', 'and', 'x64', 'x86', 'bit', 'app', 'service', 'services',
]);
const squash = (s: string) =>s.toLowerCase().replace(/[^a-z0-9]/g, '');

async function exesIn(dir: string): Promise<{ file: string; size: number }[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { file: string; size: number }[] = [];
  for (const e of entries) {
    if (!e.isFile() || !/\.exe$/i.test(e.name) || NOT_MAIN_EXE.test(e.name)) continue;
    const file = path.join(dir, e.name);
    try {
      out.push({ file, size: (await fs.stat(file)).size });
    } catch {
      // vanished or unreadable
    }
  }
  return out;
}

/** The app's own exe in its install folder (or one level below), matched by name, largest first. */
async function mainExe(location: string | undefined, appName: string): Promise<string | undefined> {
  if (!location || !/^[a-zA-Z]:\\/.test(location)) return undefined;
  const dir = path.resolve(location);
  const top = await exesIn(dir);
  let all = top;
  if (path.parse(dir).root !== dir) {
    try {
      const subs = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).slice(0, 12);
      for (const s of subs) all = all.concat(await exesIn(path.join(dir, s.name)));
    } catch {
      // top level only
    }
  }
  const words = appName.split(/[\s\-_.()]+/).map(squash).filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !GENERIC_WORDS.has(w));
  const full = squash(appName);
  const matches = all.filter(({ file }) => {
    const base = squash(path.basename(file, path.extname(file)));
    if (base.length < 3) return false;
    return full.includes(base) || (full.length >= 3 && base.includes(full)) || words.some((w) => base.includes(w));
  });
  const pick = (list: typeof all) => list.sort((a, b) => b.size - a.size)[0]?.file;
  if (matches.length) return pick(matches);
  return top.length === 1 ? top[0].file : undefined;
}

async function listWindows(): Promise<InstalledApp[]> {
  winCommands.clear();
  const byKey = new Map<string, { app: InstalledApp; command?: string; displayIcon?: string; score: number }>();
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
    if (!prev || score > prev.score) byKey.set(dedupe, { app, command, displayIcon: str(key, 'DisplayIcon'), score });
  }
  const entries = [...byKey.values()];
  await mapLimit(entries, 8, async (e) => {
    try {
      e.app.iconPath = (await fromDisplayIcon(e.displayIcon)) ?? (await mainExe(e.app.path, e.app.name));
    } catch {
      e.app.iconPath = undefined;
    }
  });
  const apps: InstalledApp[] = [];
  for (const { app, command } of entries) {
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
      iconPath: b.path,
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

/* ---------- Linux ---------- */

interface LinuxTarget {
  kind: 'flatpak' | 'snap' | 'appimage';
  /** flatpak app id, snap name or AppImage path */
  ref: string;
  installation?: 'user' | 'system';
}

const linuxTargets = new Map<string, LinuxTarget>();
const FLATPAK_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{1,254}$/;
const SNAP_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const UNIT: Record<string, number> = { bytes: 1, byte: 1, b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
/** Plain env for helper tools: C locale so numbers and sizes parse the same everywhere. */
const C_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };

function runC(file: string, args: string[], timeout = 15000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, env: C_ENV, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, stdout: String(stdout ?? '') });
    });
  });
}

function parseHumanSize(s: string): number | undefined {
  const m = /^([\d.]+)\s*([a-zA-Z]+)$/.exec(s.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = UNIT[m[2].toLowerCase()];
  return Number.isFinite(n) && unit ? Math.round(n * unit) : undefined;
}

const has = (file: string) => existsSync(file);

async function birth(p: string): Promise<number | undefined> {
  try {
    const st = await fs.stat(p);
    return Math.round(st.birthtimeMs || st.mtimeMs) || undefined;
  } catch {
    return undefined;
  }
}

function flatpakRoot(installation: 'user' | 'system'): string {
  return installation === 'user' ? path.join(os.homedir(), '.local', 'share', 'flatpak') : '/var/lib/flatpak';
}

async function listFlatpaks(): Promise<InstalledApp[]> {
  const bin = ['/usr/bin/flatpak', '/bin/flatpak'].find(has);
  if (!bin) return [];
  const res = await runC(bin, ['list', '--app', '--columns=application,name,version,installation,size'], 30000);
  const apps: InstalledApp[] = [];
  for (const line of res.stdout.split('\n')) {
    const [appId, name, version, inst, size] = line.split('\t').map((s) => s?.trim());
    if (!appId || !FLATPAK_ID.test(appId) || (inst !== 'user' && inst !== 'system')) continue;
    const root = flatpakRoot(inst);
    const id = `flatpak:${inst}:${appId}`;
    linuxTargets.set(id, { kind: 'flatpak', ref: appId, installation: inst });
    const exports = path.join(root, 'exports', 'share');
    apps.push({
      id,
      name: name || appId,
      version: version || undefined,
      publisher: inst === 'user' ? 'Flatpak (your account)' : 'Flatpak',
      size: size ? parseHumanSize(size) : undefined,
      installed: await birth(path.join(root, 'app', appId)),
      path: path.join(root, 'app', appId),
      iconPath: await resolveIcon(appId, [exports]),
      canUninstall: true,
    });
  }
  return apps;
}

async function listSnaps(): Promise<InstalledApp[]> {
  const bin = ['/usr/bin/snap', '/bin/snap'].find(has);
  if (!bin) return [];
  const res = await runC(bin, ['list'], 20000);
  const desktopDir = '/var/lib/snapd/desktop/applications';
  let desktopFiles: string[] = [];
  try {
    desktopFiles = await fs.readdir(desktopDir);
  } catch {
    desktopFiles = [];
  }
  const apps: InstalledApp[] = [];
  for (const line of res.stdout.split('\n').slice(1)) {
    const [name, version, rev, , publisher, notes] = line.trim().split(/\s+/);
    if (!name || !SNAP_NAME.test(name) || /\b(base|core|snapd|gadget|kernel)\b/.test(notes ?? '')) continue;
    // Only snaps with a launcher are apps; the rest are runtimes and content packs.
    const launcher = desktopFiles.find((f) => f.startsWith(`${name}_`) && f.endsWith('.desktop'));
    if (!launcher) continue;
    const entry = await readDesktopEntry(path.join(desktopDir, launcher));
    const snapFile = `/var/lib/snapd/snaps/${name}_${rev}.snap`;
    let size: number | undefined;
    try {
      size = (await fs.stat(snapFile)).size;
    } catch {
      size = undefined;
    }
    const id = `snap:${name}`;
    linuxTargets.set(id, { kind: 'snap', ref: name });
    const icon = entry?.get('Icon');
    apps.push({
      id,
      name: entry?.get('Name') || name,
      version,
      publisher: publisher && publisher !== '-' ? `${publisher.replace(/\*$|✓$/u, '')} (Snap)` : 'Snap',
      size,
      installed: await birth(snapFile),
      path: `/snap/${name}`,
      iconPath: icon && path.isAbsolute(icon) ? icon : await resolveIcon(icon),
      canUninstall: true,
    });
  }
  return apps;
}

const APPIMAGE_DIRS = () => ['Applications', 'AppImages', 'Apps', '.local/bin', 'bin'].map((d) => path.join(os.homedir(), d));

async function findAppImages(): Promise<string[]> {
  const found: string[] = [];
  for (const dir of APPIMAGE_DIRS()) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) if (e.isFile() && /\.appimage$/i.test(e.name)) found.push(path.join(dir, e.name));
  }
  return found;
}

function appImageName(file: string): { name: string; version?: string } {
  const base = path.basename(file).replace(/\.appimage$/i, '').replace(/[-_.](x86[-_]64|amd64|aarch64|arm64|i[36]86|armhf)$/i, '');
  const m = /^(.*?)[-_ ]v?(\d+(?:\.\d+)+[\w.+-]*)$/.exec(base);
  return m ? { name: m[1].replace(/[-_]+/g, ' '), version: m[2] } : { name: base.replace(/[-_]+/g, ' ') };
}

async function listAppImages(): Promise<InstalledApp[]> {
  const apps: InstalledApp[] = [];
  for (const file of await findAppImages()) {
    let st: import('node:fs').Stats;
    try {
      st = await fs.stat(file);
    } catch {
      continue;
    }
    const { name, version } = appImageName(file);
    const id = `appimage:${shortHash(file)}`;
    linuxTargets.set(id, { kind: 'appimage', ref: file });
    apps.push({
      id,
      name,
      version,
      publisher: 'AppImage',
      size: st.size,
      installed: Math.round(st.birthtimeMs || st.mtimeMs) || undefined,
      path: file,
      canUninstall: true,
    });
  }
  return apps;
}

interface PackageInfo {
  version?: string;
  size?: number;
  installed?: number;
  manager: string;
}

/** Owning distro package of a file, through rpm or dpkg. */
async function ownerPackage(file: string): Promise<PackageInfo | null> {
  if (has('/usr/bin/rpm') && (has('/var/lib/rpm') || has('/usr/lib/sysimage/rpm'))) {
    const res = await runC('/usr/bin/rpm', ['-qf', '--qf', '%{VERSION}\\t%{SIZE}\\t%{INSTALLTIME}\\n', file], 8000);
    const line = res.ok ? res.stdout.split('\n')[0] : '';
    const [version, size, time] = line.split('\t');
    if (version && size !== undefined) return { version, size: Number(size) || undefined, installed: Number(time) * 1000 || undefined, manager: 'rpm' };
  }
  if (has('/usr/bin/dpkg-query') && has('/var/lib/dpkg/status')) {
    const owner = await runC('/usr/bin/dpkg-query', ['-S', file], 8000);
    const pkg = owner.ok ? /^([^:,\s]+)(?::[^:\s]+)?:\s/.exec(owner.stdout)?.[1] : undefined;
    if (pkg) {
      const res = await runC('/usr/bin/dpkg-query', ['-W', '-f=${Version}\\t${Installed-Size}\\n', pkg], 8000);
      const [version, kb] = res.stdout.trim().split('\t');
      if (version) return { version, size: Number(kb) * 1024 || undefined, manager: 'dpkg' };
    }
  }
  return null;
}

/** Launchers installed by the distro or by other tools: listed for the full picture, removed with the system's software center. */
async function listDesktopApps(skipPrograms: Set<string>): Promise<InstalledApp[]> {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const d of xdgDataDirs()) {
    if (/flatpak\/exports|snapd\/desktop/.test(d)) continue;
    const dir = path.join(d, 'applications');
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.desktop') || seen.has(n)) continue;
      seen.add(n);
      files.push(path.join(dir, n));
    }
  }
  const home = os.homedir();
  const rows = await mapLimit(files, 8, async (file): Promise<InstalledApp | null> => {
    const e = await readDesktopEntry(file);
    if (!e || (e.get('Type') ?? 'Application') !== 'Application') return null;
    if (isTrue(e.get('NoDisplay')) || isTrue(e.get('Hidden')) || !appliesHere(e)) return null;
    if (e.has('X-Flatpak') || e.has('X-SnapInstanceName')) return null;
    const program = execProgram(e.get('Exec'));
    if (!program || skipPrograms.has(program)) return null;
    const pkg = file.startsWith(home + path.sep) ? null : await ownerPackage(file);
    return {
      id: `desktop:${shortHash(file)}`,
      name: e.get('Name') || path.basename(file, '.desktop'),
      version: pkg?.version,
      publisher: pkg ? 'System package' : undefined,
      size: pkg?.size,
      installed: pkg?.installed,
      path: path.isAbsolute(program) ? program : undefined,
      iconPath: await resolveIcon(e.get('Icon')),
      canUninstall: false,
    };
  });
  return rows.filter((r): r is InstalledApp => r !== null);
}

async function listLinux(): Promise<InstalledApp[]> {
  linuxTargets.clear();
  const [flatpaks, snaps, appImages] = await Promise.all([
    listFlatpaks().catch(() => []),
    listSnaps().catch(() => []),
    listAppImages().catch(() => []),
  ]);
  // A launcher an AppImage integration tool wrote should not list the AppImage twice.
  const skip = new Set(appImages.map((a) => a.path!).filter(Boolean));
  const desktop = await listDesktopApps(skip).catch(() => []);
  return [...flatpaks, ...snaps, ...appImages, ...desktop];
}

async function uninstallLinux(id: string): Promise<{ ok: boolean; message: string }> {
  if (linuxTargets.size === 0) await listLinux();
  const t = linuxTargets.get(id);
  if (!t) return { ok: false, message: 'This app cannot be removed from Cleanly. Use your software center' };

  if (t.kind === 'appimage') {
    if (!/\.appimage$/i.test(t.ref) || !APPIMAGE_DIRS().includes(path.dirname(t.ref))) return { ok: false, message: 'This app cannot be removed from Cleanly' };
    try {
      await fs.lstat(t.ref);
    } catch {
      return { ok: false, message: 'The app is already gone' };
    }
    try {
      await shell.trashItem(t.ref);
      linuxTargets.delete(id);
      return { ok: true, message: 'Moved to Trash. You can put it back from there' };
    } catch {
      return { ok: false, message: 'Could not move the AppImage to the Trash' };
    }
  }

  if (t.kind === 'flatpak') {
    if (!FLATPAK_ID.test(t.ref)) return { ok: false, message: 'This app cannot be removed from Cleanly' };
    const bin = ['/usr/bin/flatpak', '/bin/flatpak'].find(has);
    if (!bin) return { ok: false, message: 'Flatpak is not available' };
    // System-wide apps make flatpak ask for the password through polkit.
    const res = await runC(bin, ['uninstall', `--${t.installation ?? 'system'}`, '--noninteractive', '-y', t.ref], 300000);
    if (res.ok) linuxTargets.delete(id);
    return res.ok ? { ok: true, message: 'Uninstalled' } : { ok: false, message: 'Flatpak did not remove the app. The password prompt may have been cancelled' };
  }

  if (!SNAP_NAME.test(t.ref)) return { ok: false, message: 'This app cannot be removed from Cleanly' };
  const bin = ['/usr/bin/snap', '/bin/snap'].find(has);
  if (!bin) return { ok: false, message: 'Snap is not available' };
  // snapd asks for the password through polkit.
  const res = await runC(bin, ['remove', t.ref], 300000);
  if (res.ok) linuxTargets.delete(id);
  return res.ok ? { ok: true, message: 'Uninstalled' } : { ok: false, message: 'Snap did not remove the app. The password prompt may have been cancelled' };
}

/* ---------- Public API ---------- */

export async function listApps(): Promise<InstalledApp[]> {
  let apps: InstalledApp[] = [];
  try {
    if (process.platform === 'win32') apps = await listWindows();
    else if (process.platform === 'darwin') apps = await listMac();
    else apps = await listLinux();
  } catch {
    apps = [];
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export async function uninstallApp(id: string): Promise<{ ok: boolean; message: string }> {
  if (typeof id !== 'string') return { ok: false, message: 'Invalid request' };
  if (process.platform === 'win32') return uninstallWindows(id);
  if (process.platform === 'darwin') return uninstallMac(id);
  return uninstallLinux(id);
}
