import { execFile } from 'node:child_process';
import { promises as fsp, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CleanResult, IconName, JunkCategory, ScanProgress } from '../../shared/types';
import { deleteCacheEntry, isSafeUserPath, trashPaths } from './trash';
import {
  DAY_MS,
  displayPath,
  isInside,
  isRealDir,
  knownFolder,
  knownFolders,
  localAppData,
  mapLimit,
  roamingAppData,
  samePath,
  walk,
} from './walk';

type Progress = (p: ScanProgress) => void;

interface Root {
  path: string;
  /** Entry names directly in this root that belong to another category. */
  exclude?: string[];
}

interface Def {
  id: string;
  name: string;
  description: string;
  icon: IconName;
  safe: boolean;
  kind: 'cache' | 'downloads' | 'recycle';
  roots?: () => Promise<Root[]>;
  /** Keep files modified after this moment (fresh temp files may belong to running apps). */
  keepNewerThanMs?: number;
  /** Shown when nothing could be removed because of permissions. */
  adminNote?: string;
}

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const OLD_DOWNLOAD_MS = 90 * DAY_MS;
const SCAN_CAP = 1_500_000;
const DOWNLOAD_IGNORE = new Set(['desktop.ini', 'thumbs.db', '.ds_store', '.localized']);

const home = () => os.homedir();
const lib = (...p: string[]) => path.join(home(), 'Library', ...p);

async function dirs(paths: string[], exclude?: (p: string) => string[] | undefined): Promise<Root[]> {
  const out: Root[] = [];
  for (const p of paths) {
    if (out.some((r) => samePath(r.path, p))) continue;
    if (await isRealDir(p)) out.push({ path: p, exclude: exclude?.(p) });
  }
  return out;
}

async function subdirs(p: string): Promise<string[]> {
  try {
    const list = await fsp.readdir(p, { withFileTypes: true });
    return list.filter((d) => d.isDirectory()).map((d) => path.join(p, d.name));
  } catch {
    return [];
  }
}

const PROFILE_CACHES = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  path.join('Service Worker', 'CacheStorage'),
  path.join('Service Worker', 'ScriptCache'),
];
const USER_DATA_CACHES = ['GrShaderCache', 'ShaderCache', 'GraphiteDawnCache'];
const isProfileName = (n: string) => /^(Default|Profile \d+|Guest Profile|System Profile)$/i.test(n);

/** Cache folders of every profile of a Chromium "User Data" folder. */
async function chromiumCaches(userData: string): Promise<string[]> {
  if (!(await isRealDir(userData))) return [];
  const out = USER_DATA_CACHES.map((c) => path.join(userData, c));
  for (const profile of await subdirs(userData)) {
    if (isProfileName(path.basename(profile))) out.push(...PROFILE_CACHES.map((c) => path.join(profile, c)));
  }
  return out;
}

/** Opera keeps a single profile directly in its folder. */
const profileCaches = (profileDir: string) => PROFILE_CACHES.map((c) => path.join(profileDir, c));

async function firefoxCaches(profilesDir: string): Promise<string[]> {
  return (await subdirs(profilesDir)).map((p) => path.join(p, 'cache2'));
}

/** %TEMP% only if it looks like a real temp folder, never a root, home or user folder. */
function userTempDir(): string {
  const fallback = path.join(localAppData(), 'Temp');
  const t = os.tmpdir();
  if (samePath(t, fallback)) return t;
  // A custom TEMP such as Documents\tmp or a project's tmp folder holds the user's own files.
  const bad =
    path.parse(t).root === path.resolve(t) ||
    samePath(t, home()) ||
    isInside(t, home()) ||
    Object.values(knownFolders()).some((k) => samePath(k, t) || isInside(t, k) || isInside(k, t)) ||
    (isInside(home(), t) && !isInside(localAppData(), t)) ||
    !/^te?mp$/i.test(path.basename(t));
  return bad ? fallback : t;
}

function winDefs(): Def[] {
  const L = localAppData();
  const R = roamingAppData();
  const winDir = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const programData = process.env.ProgramData || 'C:\\ProgramData';
  const appCache = (base: string) => ['Cache', 'Code Cache', 'GPUCache', path.join('Service Worker', 'CacheStorage')].map((c) => path.join(base, c));

  return [
    {
      id: 'win-temp',
      name: '临时文件',
      description: '安装程序和应用留下的残余文件。最近一天内动过的文件会保留。',
      icon: 'file',
      safe: true,
      kind: 'cache',
      keepNewerThanMs: DAY_MS,
      roots: () => dirs([userTempDir()]),
    },
    {
      id: 'win-system-temp',
      name: 'Windows 临时文件',
      description: '系统范围的临时文件。Windows 仍在使用的文件会跳过。',
      icon: 'gear',
      safe: true,
      kind: 'cache',
      keepNewerThanMs: DAY_MS,
      roots: () => dirs([path.join(winDir, 'Temp')]),
    },
    {
      id: 'browser-cache',
      name: '浏览器缓存',
      description: 'Chrome、Edge、Firefox 等浏览器会在你浏览时重建这些缓存。登录状态和历史记录不受影响。',
      icon: 'globe',
      safe: true,
      kind: 'cache',
      roots: async () => {
        const userDatas = [
          path.join(L, 'Google', 'Chrome', 'User Data'),
          path.join(L, 'Microsoft', 'Edge', 'User Data'),
          path.join(L, 'BraveSoftware', 'Brave-Browser', 'User Data'),
          path.join(L, 'Vivaldi', 'User Data'),
        ];
        const paths: string[] = [];
        for (const u of userDatas) paths.push(...(await chromiumCaches(u)));
        for (const opera of ['Opera Stable', 'Opera GX Stable']) {
          paths.push(...profileCaches(path.join(L, 'Opera Software', opera)));
          paths.push(...profileCaches(path.join(R, 'Opera Software', opera)));
        }
        paths.push(...(await firefoxCaches(path.join(L, 'Mozilla', 'Firefox', 'Profiles'))));
        return dirs(paths);
      },
    },
    {
      id: 'app-cache',
      name: '应用缓存',
      description: 'Discord、Slack、Teams、Spotify、VS Code 和 Zoom 会自行重建这些缓存。',
      icon: 'apps',
      safe: true,
      kind: 'cache',
      roots: () => {
        const teamsNew = path.join(L, 'Packages', 'MSTeams_8wekyb3d8bbwe', 'LocalCache', 'Microsoft', 'MSTeams', 'EBWebView', 'Default');
        return dirs([
          ...appCache(path.join(R, 'discord')),
          ...appCache(path.join(R, 'Slack')),
          ...appCache(path.join(R, 'Microsoft', 'Teams')),
          path.join(R, 'Microsoft', 'Teams', 'tmp'),
          ...appCache(teamsNew),
          path.join(L, 'Spotify', 'Data'),
          path.join(L, 'Packages', 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0', 'LocalCache', 'Spotify', 'Data'),
          ...appCache(path.join(R, 'Code')),
          path.join(R, 'Code', 'CachedData'),
          path.join(R, 'Code', 'CachedExtensionVSIXs'),
          path.join(R, 'Zoom', 'logs'),
        ]);
      },
    },
    {
      id: 'crash-reports',
      name: '崩溃报告与错误报告',
      description: '应用崩溃后留下的内存转储和错误报告。',
      icon: 'warning',
      safe: true,
      kind: 'cache',
      roots: () =>
        dirs([
          path.join(L, 'CrashDumps'),
          path.join(L, 'Microsoft', 'Windows', 'WER', 'ReportArchive'),
          path.join(L, 'Microsoft', 'Windows', 'WER', 'ReportQueue'),
          path.join(programData, 'Microsoft', 'Windows', 'WER', 'ReportArchive'),
          path.join(programData, 'Microsoft', 'Windows', 'WER', 'ReportQueue'),
        ]),
    },
    {
      id: 'win-update',
      name: 'Windows 更新下载',
      description: 'Windows 已使用过的更新安装文件。删除它们需要管理员权限。',
      icon: 'history',
      safe: false,
      kind: 'cache',
      adminNote: 'Windows 更新文件需要管理员权限，已跳过',
      roots: () => dirs([path.join(winDir, 'SoftwareDistribution', 'Download')]),
    },
    {
      id: 'dev-cache',
      name: '开发者缓存',
      description: 'npm、pip、Yarn、pnpm 和 Gradle 的缓存。下次安装时会重新下载软件包。',
      icon: 'code',
      safe: false,
      kind: 'cache',
      roots: () =>
        dirs([
          path.join(L, 'npm-cache'),
          path.join(R, 'npm-cache'),
          path.join(L, 'pip', 'cache'),
          path.join(L, 'Yarn', 'Cache'),
          path.join(L, 'pnpm', 'store'),
          path.join(L, 'pnpm-store'),
          path.join(home(), '.gradle', 'caches'),
        ]),
    },
    {
      id: 'recycle-bin',
      name: '回收站',
      description: '你已经删除的文件。清空后将永久删除，无法恢复。',
      icon: 'trash',
      safe: false,
      kind: 'recycle',
    },
    oldDownloadsDef('回收站'),
  ];
}

const MAC_BROWSER_CACHES = [
  'Google',
  'BraveSoftware',
  'Microsoft Edge',
  'Arc',
  'company.thebrowser.Browser',
  'com.apple.Safari',
  'Firefox',
  'Vivaldi',
  'com.operasoftware.Opera',
];
const MAC_DEV_CACHES = ['Yarn', 'pip', 'pnpm'];
// Sync and transfer state rather than caches: iCloud Drive / CloudKit bookkeeping and background downloads in flight.
const MAC_KEEP_CACHES = ['com.apple.bird', 'CloudKit', 'com.apple.cloudd', 'com.apple.nsurlsessiond', 'com.apple.akd', 'FamilyCircle'];

function macDefs(): Def[] {
  const support = (...p: string[]) => lib('Application Support', ...p);
  return [
    {
      id: 'mac-caches',
      name: '用户缓存',
      description: '应用用这些缓存来加快加载速度，需要时会自行重建。',
      icon: 'layers',
      safe: true,
      kind: 'cache',
      roots: () => dirs([lib('Caches')], () => [...MAC_BROWSER_CACHES, ...MAC_DEV_CACHES, ...MAC_KEEP_CACHES]),
    },
    {
      id: 'mac-logs',
      name: '日志',
      description: '应用长期写入的诊断日志。应用运行并不需要它们。',
      icon: 'doc',
      safe: true,
      kind: 'cache',
      roots: () => dirs([lib('Logs')]),
    },
    {
      id: 'browser-cache',
      name: '浏览器缓存',
      description: 'Chrome、Safari、Firefox 等浏览器会在你浏览时重建这些缓存。登录状态和历史记录不受影响。',
      icon: 'globe',
      safe: true,
      kind: 'cache',
      roots: async () => {
        const paths = [
          lib('Caches', 'Google', 'Chrome'),
          lib('Caches', 'BraveSoftware', 'Brave-Browser'),
          lib('Caches', 'Microsoft Edge'),
          lib('Caches', 'Arc'),
          lib('Caches', 'company.thebrowser.Browser'),
          lib('Caches', 'com.apple.Safari'),
          lib('Caches', 'Vivaldi'),
          lib('Caches', 'com.operasoftware.Opera'),
        ];
        for (const u of [
          support('Google', 'Chrome'),
          support('BraveSoftware', 'Brave-Browser'),
          support('Microsoft Edge'),
          support('Arc', 'User Data'),
          support('Vivaldi'),
        ]) {
          paths.push(...(await chromiumCaches(u)));
        }
        paths.push(...(await firefoxCaches(lib('Caches', 'Firefox', 'Profiles'))));
        return dirs(paths);
      },
    },
    {
      id: 'xcode',
      name: 'Xcode 残余文件',
      description: 'DerivedData、旧设备支持文件和模拟器缓存。Xcode 需要时会重建它们。',
      icon: 'chip',
      safe: false,
      kind: 'cache',
      roots: () =>
        dirs([
          lib('Developer', 'Xcode', 'DerivedData'),
          lib('Developer', 'Xcode', 'iOS DeviceSupport'),
          lib('Developer', 'CoreSimulator', 'Caches'),
        ]),
    },
    {
      id: 'dev-cache',
      name: '开发者缓存',
      description: 'npm、Yarn、pnpm 和 pip 的缓存。下次安装时会重新下载软件包。',
      icon: 'code',
      safe: false,
      kind: 'cache',
      roots: () =>
        dirs([
          path.join(home(), '.npm', '_cacache'),
          lib('Caches', 'Yarn'),
          lib('pnpm', 'store'),
          lib('Caches', 'pnpm'),
          lib('Caches', 'pip'),
          path.join(home(), '.gradle', 'caches'),
        ]),
    },
    {
      id: 'trash',
      name: '废纸篓',
      description: '你已经删除的文件。清空后将永久删除，无法恢复。',
      icon: 'trash',
      safe: false,
      kind: 'cache',
      roots: () => dirs([path.join(home(), '.Trash')]),
    },
    oldDownloadsDef('废纸篓'),
  ];
}

function linuxDefs(): Def[] {
  return [
    {
      id: 'linux-cache',
      name: '用户缓存',
      description: '应用用这些缓存来加快加载速度，需要时会自行重建。',
      icon: 'layers',
      safe: true,
      kind: 'cache',
      roots: () => dirs([path.join(home(), '.cache')]),
    },
    {
      id: 'trash',
      name: '废纸篓',
      description: '你已经删除的文件。清空后将永久删除，无法恢复。',
      icon: 'trash',
      safe: false,
      kind: 'cache',
      // info/ holds the .trashinfo records; leaving them would show ghost items in the file manager.
      roots: () => dirs([path.join(home(), '.local', 'share', 'Trash', 'files'), path.join(home(), '.local', 'share', 'Trash', 'info')]),
    },
    oldDownloadsDef('废纸篓'),
  ];
}

function oldDownloadsDef(binName: string): Def {
  return {
    id: 'old-downloads',
    name: '旧下载文件',
    description: `下载文件夹中 90 天以上未动过的文件。它们会被移至${binName}，你可以从中恢复。`,
    icon: 'down',
    safe: false,
    kind: 'downloads',
  };
}

function platformDefs(): Def[] {
  if (isWin) return winDefs();
  if (isMac) return macDefs();
  return linuxDefs();
}

const lower = (s: string) => s.toLowerCase();
const newest = (f: { mtimeMs: number; birthtimeMs: number }) => Math.max(f.mtimeMs, f.birthtimeMs || 0);

interface Measured {
  size: number;
  count: number;
  locations: string[];
}

/** Sizes what a clean would remove: every entry inside each root, minus excluded and too-fresh files. */
async function measureCache(def: Def, roots: Root[], onTick: (current: string) => void): Promise<Measured> {
  const cutoff = def.keepNewerThanMs ? Date.now() - def.keepNewerThanMs : undefined;
  const out: Measured = { size: 0, count: 0, locations: [] };
  for (const root of roots) {
    const excluded = new Set((root.exclude ?? []).map(lower));
    const entries = new Set<string>();
    let bytes = 0;
    const top = (p: string) => lower(path.relative(root.path, p).split(path.sep)[0]);
    await walk(root.path, {
      maxEntries: SCAN_CAP,
      skipDir: (_p, name, depth) => depth === 1 && excluded.has(lower(name)),
      onDir: (p, depth) => {
        if (depth === 1 && cutoff === undefined) entries.add(top(p));
      },
      onFile: (f) => {
        if (f.depth === 1 && excluded.has(lower(f.name))) return;
        // Same freshness rule as deleteCacheEntry, so the size shown matches what a clean removes.
        if (cutoff !== undefined && newest(f) >= cutoff) return;
        bytes += f.size;
        entries.add(top(f.path));
      },
      onTick: (_n, current) => onTick(current),
    });
    if (bytes > 0) {
      out.size += bytes;
      out.count += entries.size;
      out.locations.push(displayPath(root.path));
    }
  }
  return out;
}

/** Last opened (where the OS tracks it), changed or created: any of them makes a download "recent". */
const touched = (f: { mtimeMs: number; birthtimeMs: number; atimeMs: number }) =>
  Math.max(f.mtimeMs, f.birthtimeMs || 0, f.atimeMs || 0);

/** Top-level entries of Downloads whose content was all last touched 90+ days ago. */
async function findOldDownloads(): Promise<{ paths: string[]; size: number; folder: string }> {
  const folder = knownFolder('downloads');
  const cutoff = Date.now() - OLD_DOWNLOAD_MS;
  const result = { paths: [] as string[], size: 0, folder };
  let list: Dirent[];
  try {
    list = await fsp.readdir(folder, { withFileTypes: true });
  } catch {
    return result;
  }
  const candidates = list.filter((d) => !DOWNLOAD_IGNORE.has(lower(d.name)) && (d.isFile() || d.isDirectory()));
  await mapLimit(candidates, 8, async (d) => {
    const p = path.join(folder, d.name);
    try {
      const st = await fsp.lstat(p);
      if (st.isSymbolicLink()) return;
      if (st.isFile()) {
        if (touched(st) < cutoff) {
          result.paths.push(p);
          result.size += st.size;
        }
        return;
      }
      if (!st.isDirectory()) return;
      let fresh = touched(st) >= cutoff;
      let size = 0;
      const ctrl = new AbortController();
      const stats = await walk(p, {
        signal: ctrl.signal,
        maxEntries: 200_000,
        onFile: (f) => {
          size += f.size;
          if (touched(f) >= cutoff) {
            fresh = true;
            ctrl.abort();
          }
        },
      });
      // A folder we could not fully check is treated as in use.
      if (stats.truncated) fresh = true;
      if (!fresh) {
        result.paths.push(p);
        result.size += size;
      }
    } catch {
      // unreadable: leave it alone
    }
  });
  result.paths = result.paths.filter((p) => isSafeUserPath(p));
  return result;
}

const RECYCLE_MEASURE = [
  "$ErrorActionPreference='SilentlyContinue'",
  '$n=0; $t=[double]0',
  'foreach($i in (New-Object -ComObject Shell.Application).NameSpace(10).Items()){',
  '  $n++',
  "  $v=$i.ExtendedProperty('System.Size')",
  '  if($v -and [double]$v -gt 0){ $t+=[double]$v }',
  '  else { $m=(Get-ChildItem -LiteralPath $i.Path -Recurse -Force -File | Measure-Object -Property Length -Sum).Sum; if($m){ $t+=[double]$m } }',
  '}',
  '"$n $t"',
].join('\n');

function powershell(script: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      path.join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    );
  });
}

async function measureRecycleBin(): Promise<{ count: number; size: number }> {
  try {
    const out = (await powershell(RECYCLE_MEASURE, 90_000)).trim().split(/\s+/);
    const count = Number(out[out.length - 2]);
    const size = Number(out[out.length - 1]);
    return { count: Number.isFinite(count) ? count : 0, size: Number.isFinite(size) ? size : 0 };
  } catch {
    return { count: 0, size: 0 };
  }
}

async function measure(def: Def, onTick: (current: string) => void): Promise<Measured> {
  if (def.kind === 'recycle') {
    const r = await measureRecycleBin();
    return { size: r.size, count: r.count, locations: ['回收站'] };
  }
  if (def.kind === 'downloads') {
    const r = await findOldDownloads();
    return { size: r.size, count: r.paths.length, locations: r.paths.length ? [displayPath(r.folder)] : [] };
  }
  const roots = (await def.roots?.()) ?? [];
  return measureCache(def, roots, onTick);
}

export async function scanJunk(progress: Progress): Promise<JunkCategory[]> {
  const defs = platformDefs();
  const found: JunkCategory[] = [];
  for (let i = 0; i < defs.length; i++) {
    const def = defs[i];
    progress({ task: 'junk', phase: def.name, done: i, total: defs.length });
    let last = 0;
    const onTick = (current: string) => {
      const now = Date.now();
      if (now - last < 120) return;
      last = now;
      progress({ task: 'junk', phase: def.name, done: i, total: defs.length, current: displayPath(current) });
    };
    try {
      const m = await measure(def, onTick);
      if (m.size <= 0) continue;
      found.push({
        id: def.id,
        name: def.name,
        description: def.description,
        icon: def.icon,
        size: m.size,
        count: m.count,
        locations: m.locations.slice(0, 24),
        safe: def.safe,
      });
    } catch {
      // a category that cannot be measured is simply not offered
    }
  }
  progress({ task: 'junk', phase: '完成', done: defs.length, total: defs.length });
  return found.sort((a, b) => b.size - a.size);
}

interface Tally {
  freed: number;
  removed: number;
  locked: number;
  denied: number;
  refused: number;
}

async function cleanCache(def: Def, tally: Tally): Promise<void> {
  const roots = (await def.roots?.()) ?? [];
  const modifiedBefore = def.keepNewerThanMs ? Date.now() - def.keepNewerThanMs : undefined;
  for (const root of roots) {
    const excluded = new Set((root.exclude ?? []).map(lower));
    let names: string[];
    try {
      names = (await fsp.readdir(root.path)).filter((n) => !excluded.has(lower(n)));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') tally.denied++;
      continue;
    }
    await mapLimit(names, 4, async (name) => {
      const r = await deleteCacheEntry(path.join(root.path, name), root.path, { modifiedBefore });
      tally.freed += r.freed;
      tally.removed += r.removed;
      tally.locked += r.locked;
      tally.denied += r.denied;
      if (r.refused) tally.refused++;
    });
  }
}

async function emptyRecycleBin(): Promise<{ freed: number; removed: number; ok: boolean }> {
  const before = await measureRecycleBin();
  try {
    await powershell("Clear-RecycleBin -Force -ErrorAction SilentlyContinue", 180_000);
  } catch {
    return { freed: 0, removed: 0, ok: false };
  }
  const after = await measureRecycleBin();
  return {
    freed: Math.max(0, before.size - after.size),
    removed: Math.max(0, before.count - after.count),
    ok: after.count === 0,
  };
}

const fmt = (n: number) => n.toLocaleString('en-US');

/** Cleans the chosen categories. Locations are always re-derived here; the renderer only sends ids. */
export async function cleanJunk(ids: unknown, progress: Progress): Promise<CleanResult> {
  const wanted = new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []);
  // Old downloads go to the bin, so they must run after the bin is emptied or they would be erased for good.
  const binFirst = (d: Def) => (d.kind === 'downloads' ? 1 : 0);
  const defs = platformDefs()
    .filter((d) => wanted.has(d.id))
    .sort((a, b) => binFirst(a) - binFirst(b));
  const result: CleanResult = { freed: 0, removed: 0, failed: 0, skipped: [] };
  let locked = 0;
  let refused = 0;
  let deniedOther = 0;

  for (let i = 0; i < defs.length; i++) {
    const def = defs[i];
    progress({ task: 'clean', phase: def.name, done: i, total: defs.length });
    try {
      if (def.kind === 'recycle') {
        const r = await emptyRecycleBin();
        result.freed += r.freed;
        result.removed += r.removed;
        if (!r.ok) {
          result.failed++;
          result.skipped.push('回收站中有部分项目无法删除');
        }
        continue;
      }
      if (def.kind === 'downloads') {
        const { paths } = await findOldDownloads();
        const r = await trashPaths(paths);
        result.freed += r.freed;
        result.removed += r.removed;
        result.failed += r.failed;
        result.skipped.push(...r.skipped.map((s) => `旧下载文件：${s}`));
        if (r.removed > 0) result.skipped.push(`旧下载文件已移至${isWin ? '回收站' : '废纸篓'}，你可以从中恢复`);
        continue;
      }
      const tally: Tally = { freed: 0, removed: 0, locked: 0, denied: 0, refused: 0 };
      await cleanCache(def, tally);
      result.freed += tally.freed;
      result.removed += tally.removed;
      result.failed += tally.locked + tally.denied;
      locked += tally.locked;
      refused += tally.refused;
      if (tally.denied > 0 && def.adminNote) result.skipped.push(def.adminNote);
      else deniedOther += tally.denied;
    } catch {
      result.failed++;
      result.skipped.push(`${def.name} 无法清理`);
    }
  }

  if (locked) result.skipped.unshift(`${fmt(locked)} 个文件正在使用中`);
  if (deniedOther) result.skipped.push(`${fmt(deniedOther)} 个受保护文件已保留未动`);
  if (refused) result.skipped.push(`${fmt(refused)} 个链接项目出于安全考虑已跳过`);
  progress({ task: 'clean', phase: '完成', done: defs.length, total: defs.length });
  return result;
}
