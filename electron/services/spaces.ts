import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DiskInfo, IconName, ScanProgress, SpaceNode } from '../../shared/types';
import { getDisk, listDisks, sameMount } from './disk';
import { DAY_MS, displayPath, isInside, knownFolders, samePath, walk } from './walk';

type Progress = (p: ScanProgress) => void;

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const sys32 = (...p: string[]) => path.join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', ...p);

const MAX_ENTRIES = 2_000_000;
const MAX_CHILDREN = 12;
const LOOSE_FILE_MIN = 256 * 1024 * 1024;
const OLD_MS = 90 * DAY_MS;
// Path segments that mark regenerable data inside AppData / Library (approximate on purpose).
const CACHE_SEGMENT =
  /(^|[\\/])(cache|caches|code cache|gpucache|cache_data|cache2|cachestorage|scriptcache|shadercache|grshadercache|temp|tmp|crashdumps|logs|npm-cache|deriveddata)([\\/]|$)/i;

const CODE_NAMES = /^(source|src|dev|develop|development|projects?|code|repos?|git|github|workspace|workspaces)$/i;
const GAME_NAMES = /^(games?|xboxgames|steam|steamlibrary|epic games|gog games|riot games|ea games|ubisoft)$/i;

/** Top-level folders of a drive that belong to the OS or to installed apps. */
const SYSTEM_TOP = new Set(
  (isWin
    ? [
        'Windows', 'Windows.old', 'Program Files', 'Program Files (x86)', 'ProgramData', 'Recovery', 'Boot', 'EFI', 'PerfLogs',
        'WindowsApps', 'WpSystem', 'Config.Msi', 'MSOCache', 'OneDriveTemp', '$SysReset', '$WinREAgent', '$Windows.~BT',
        '$Windows.~WS', '$GetCurrent', 'inetpub', 'Intel', 'AMD', 'NVIDIA',
      ]
    : ['System', 'Library', 'private', 'usr', 'bin', 'sbin', 'cores', 'opt', 'etc', 'var', 'tmp']
  ).map((n) => n.toLowerCase()),
);
/** Never walked: recycle bins, volume metadata and (on macOS) mirrors of other volumes. */
const SKIP_TOP = new Set(
  (isWin
    ? ['$Recycle.Bin', 'System Volume Information', 'Documents and Settings']
    : ['.Trashes', '.Spotlight-V100', '.fseventsd', '.DocumentRevisions-V100', '.TemporaryItems', '.vol', '.MobileBackups', 'Volumes', 'dev', 'home', 'net', 'Network']
  ).map((n) => n.toLowerCase()),
);
const SYSTEM_FILES = /^(pagefile\.sys|hiberfil\.sys|swapfile\.sys|dumpstack\.log(\.tmp)?|bootmgr|bootnxt|bootsect\.bak)$/i;

function iconFor(name: string, isDir: boolean, absPath: string): IconName {
  if (!isDir) return 'file';
  const n = name.toLowerCase();
  const known = knownFolders();
  if (n === 'desktop' || samePath(absPath, known.desktop)) return 'folder';
  if (n === 'documents' || samePath(absPath, known.documents)) return 'doc';
  if (n === 'downloads' || samePath(absPath, known.downloads)) return 'down';
  if (n === 'pictures' || samePath(absPath, known.pictures)) return 'photo';
  if (n === 'videos' || n === 'movies' || samePath(absPath, known.videos)) return 'video';
  if (n === 'music' || samePath(absPath, known.music)) return 'music';
  if (n === 'appdata' || n === 'library') return 'layers';
  if (n.startsWith('onedrive') || n === 'icloud drive' || n === 'dropbox' || n === 'google drive') return 'cloud';
  if (CODE_NAMES.test(name)) return 'code';
  if (GAME_NAMES.test(name)) return 'game';
  return 'folder';
}

function displayName(name: string): string {
  if (name.toLowerCase() === 'appdata') return 'App data';
  return name;
}

interface Bucket {
  size: number;
  reclaimable: number;
  isDir: boolean;
}

function toChildren(parent: string, buckets: Map<string, Bucket>): SpaceNode[] {
  const all = [...buckets.entries()]
    .map(([name, b]): SpaceNode => {
      const p = path.join(parent, name);
      return { name, path: p, size: b.size, kind: b.isDir ? 'folder' : 'file', icon: iconFor(name, b.isDir, p), reclaimable: b.reclaimable };
    })
    .filter((n) => n.size > 0)
    .sort((a, b) => b.size - a.size);
  const shown = all.slice(0, MAX_CHILDREN);
  const rest = all.slice(MAX_CHILDREN);
  if (rest.length > 0) {
    shown.push({
      name: `${rest.length.toLocaleString('en-US')} more items`,
      path: parent,
      size: rest.reduce((s, n) => s + n.size, 0),
      kind: 'other',
      icon: 'more',
      reclaimable: rest.reduce((s, n) => s + n.reclaimable, 0),
    });
  }
  return shown;
}

const sum = (nodes: SpaceNode[], key: 'size' | 'reclaimable') => nodes.reduce((s, n) => s + n[key], 0);

/** Shared state of one scan: entry budget, throttled progress and step counter. */
class Scan {
  budget = MAX_ENTRIES;
  done = 0;
  total = 0;
  private last = 0;
  readonly cutoff = Date.now() - OLD_MS;
  readonly known = knownFolders();

  constructor(private readonly progress: Progress) {}

  step(phase: string, current?: string) {
    this.progress({ task: 'spaces', phase, done: this.done, total: this.total, current });
  }

  tick(phase: string, current: string) {
    const now = Date.now();
    if (now - this.last < 120) return;
    this.last = now;
    this.step(phase, displayPath(current));
  }
}

interface MeasureOpts {
  label: string;
  icon: IconName;
  kind?: SpaceNode['kind'];
  /** a folder inside `dir` to leave out (the home folder when measuring C:\Users) */
  exclude?: string;
  /** extra subtrees to leave out entirely */
  skip?: (p: string) => boolean;
}

/** Walks one folder; its direct children become the drill-down level. Null when empty or out of budget. */
async function measure(scan: Scan, dir: string, opts: MeasureOpts): Promise<SpaceNode | null> {
  if (scan.budget <= 0) return null;
  const phase = `Measuring ${opts.label}`;
  scan.step(phase);
  const isDownloads = samePath(dir, scan.known.downloads);
  const isAppData = /^(appdata|library)$/i.test(path.basename(dir)) && isInside(os.homedir(), dir);
  const buckets = new Map<string, Bucket>();
  const prefix = dir.length + (dir.endsWith(path.sep) ? 0 : 1);

  const stats = await walk(dir, {
    maxEntries: scan.budget,
    skipDir: (p) => (!!opts.exclude && samePath(p, opts.exclude)) || !!opts.skip?.(p),
    onDir: (p, depth) => {
      if (depth === 1) buckets.set(path.basename(p), { size: 0, reclaimable: 0, isDir: true });
    },
    onFile: (f) => {
      const rel = f.path.slice(prefix);
      const cut = rel.indexOf(path.sep);
      const key = cut < 0 ? rel : rel.slice(0, cut);
      let b = buckets.get(key);
      if (!b) {
        b = { size: 0, reclaimable: 0, isDir: cut >= 0 };
        buckets.set(key, b);
      }
      b.size += f.size;
      if (isDownloads && Math.max(f.mtimeMs, f.birthtimeMs || 0) < scan.cutoff) b.reclaimable += f.size;
      else if (isAppData && CACHE_SEGMENT.test(rel)) b.reclaimable += f.size;
    },
    onTick: (_n, current) => scan.tick(phase, current),
  });
  scan.budget -= stats.files + stats.dirs;
  scan.done++;
  if (stats.bytes <= 0) return null;

  let reclaimable = 0;
  for (const b of buckets.values()) reclaimable += b.reclaimable;
  return {
    name: opts.label,
    path: dir,
    size: stats.bytes,
    kind: opts.kind ?? 'folder',
    icon: opts.icon,
    reclaimable,
    children: toChildren(dir, buckets),
  };
}

interface TopLevel {
  folders: string[];
  files: { name: string; size: number | null }[];
}

async function readTop(dir: string, isDriveRoot: boolean): Promise<TopLevel> {
  const out: TopLevel = { folders: [], files: [] };
  let list;
  try {
    list = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of list) {
    if (isDriveRoot && SKIP_TOP.has(d.name.toLowerCase())) continue;
    if (d.isDirectory()) {
      out.folders.push(d.name);
      continue;
    }
    // lstat everything else so junctions such as "My Documents" are never followed
    try {
      const st = await fsp.lstat(path.join(dir, d.name));
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) out.folders.push(d.name);
      else if (st.isFile()) out.files.push({ name: d.name, size: st.size });
    } catch {
      // hiberfil.sys and friends refuse to be opened; their size may still be listed by the OS
      if (d.isFile()) out.files.push({ name: d.name, size: null });
    }
  }
  return out;
}

/** Sizes of a Windows drive root's files that cannot be opened (hiberfil.sys, swapfile.sys). */
function rootFileSizes(mount: string): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  if (!isWin || !/^[A-Z]:\\$/.test(mount)) return Promise.resolve(sizes);
  const script =
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
    `@(Get-ChildItem -LiteralPath '${mount}' -Force -File -ErrorAction SilentlyContinue | Select-Object Name,Length) | ConvertTo-Json -Compress`;
  return new Promise((resolve) => {
    execFile(
      sys32('WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 10000, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (!err) {
          try {
            const parsed = JSON.parse(String(stdout).trim() || '[]') as unknown;
            for (const r of Array.isArray(parsed) ? parsed : [parsed]) {
              const row = r as { Name?: unknown; Length?: unknown };
              if (typeof row?.Name === 'string' && Number.isFinite(Number(row.Length))) sizes.set(row.Name.toLowerCase(), Number(row.Length));
            }
          } catch {
            // sizes stay unknown
          }
        }
        resolve(sizes);
      },
    );
  });
}

/** Big loose files stand alone; the rest are grouped as "Loose files". */
function looseNodes(dir: string, files: { name: string; size: number }[]): SpaceNode[] {
  const out: SpaceNode[] = [];
  for (const f of files.filter((x) => x.size >= LOOSE_FILE_MIN)) {
    out.push({ name: f.name, path: path.join(dir, f.name), size: f.size, kind: 'file', icon: 'file', reclaimable: 0 });
  }
  const small = files.filter((f) => f.size < LOOSE_FILE_MIN && f.size > 0);
  const total = small.reduce((s, f) => s + f.size, 0);
  if (total > 0) {
    const buckets = new Map(small.map((f): [string, Bucket] => [f.name, { size: f.size, reclaimable: 0, isDir: false }]));
    out.push({ name: 'Loose files', path: dir, size: total, kind: 'file', icon: 'file', reclaimable: 0, children: toChildren(dir, buckets) });
  }
  return out;
}

/** The home folder's own breakdown: one node per top-level folder plus loose files. */
async function homeChildren(scan: Scan, home: string, top: TopLevel): Promise<SpaceNode[]> {
  const children: SpaceNode[] = [];
  for (const name of top.folders) {
    const dir = path.join(home, name);
    const node = await measure(scan, dir, { label: displayName(name), icon: iconFor(name, true, dir) });
    if (node) children.push(node);
  }
  children.push(...looseNodes(home, top.files.filter((f): f is { name: string; size: number } => f.size !== null)));
  return children;
}

/** Whatever the walk could not see (OS metadata, recycle bin, protected folders) as one bubble. */
function remainderNode(disk: DiskInfo | null, measured: number, name: string): SpaceNode | null {
  if (!disk) return null;
  const other = disk.used - measured;
  if (other <= 0) return null;
  return { name, path: disk.mount, size: other, kind: 'other', icon: 'chip', reclaimable: 0 };
}

async function scanHome(scan: Scan): Promise<SpaceNode> {
  const home = os.homedir();
  const top = await readTop(home, false);
  scan.total = top.folders.length;
  const children = await homeChildren(scan, home, top);

  const homeSize = sum(children, 'size');
  const disk = await getDisk().catch(() => null);
  const rest = remainderNode(disk, homeSize, 'System & apps');
  if (rest) children.push(rest);

  children.sort((a, b) => b.size - a.size);
  scan.done = scan.total;
  scan.step('Done');
  return { name: 'Home', path: home, size: sum(children, 'size'), kind: 'folder', icon: 'user', reclaimable: sum(children, 'reclaimable'), children };
}

async function scanDrive(scan: Scan, disk: DiskInfo): Promise<SpaceNode> {
  const mount = disk.mount;
  const home = os.homedir();
  const hasHome = isInside(mount, home);
  const top = await readTop(mount, true);
  const homeTop = hasHome ? await readTop(home, false) : null;
  scan.total = top.folders.length + (homeTop?.folders.length ?? 0);

  const children: SpaceNode[] = [];

  // the user's own files first, so a budget cut lands on system folders instead
  if (homeTop) {
    const kids = await homeChildren(scan, home, homeTop);
    const size = sum(kids, 'size');
    if (size > 0) {
      kids.sort((a, b) => b.size - a.size);
      children.push({ name: 'Your files', path: home, size, kind: 'folder', icon: 'user', reclaimable: sum(kids, 'reclaimable'), children: kids });
    }
  }

  const isSystemName = (n: string) => SYSTEM_TOP.has(n.toLowerCase()) || (isWin && n.startsWith('$'));
  const ordered = [...top.folders].sort((a, b) => Number(isSystemName(a)) - Number(isSystemName(b)));
  // macOS mirrors the Data volume under /System/Volumes; counting it again would double everything
  const macSkip = isMac && disk.system ? (p: string) => samePath(p, '/System/Volumes') : undefined;

  for (const name of ordered) {
    const dir = path.join(mount, name);
    const system = isSystemName(name);
    const holdsHome = hasHome && isInside(dir, home);
    const node = await measure(scan, dir, {
      label: name,
      icon: system ? 'chip' : isMac && name === 'Applications' ? 'apps' : holdsHome ? 'folder' : iconFor(name, true, dir),
      kind: system ? 'other' : 'folder',
      exclude: holdsHome ? home : undefined,
      skip: macSkip,
    });
    if (node) children.push(node);
  }

  const known = top.files.filter((f): f is { name: string; size: number } => f.size !== null);
  const unknown = top.files.filter((f) => f.size === null);
  if (unknown.length > 0) {
    const listed = await rootFileSizes(mount);
    for (const f of unknown) {
      const size = listed.get(f.name.toLowerCase());
      if (size !== undefined) known.push({ name: f.name, size });
    }
  }
  const sysFiles = known.filter((f) => SYSTEM_FILES.test(f.name));
  for (const f of sysFiles) {
    if (f.size > 0) children.push({ name: f.name, path: path.join(mount, f.name), size: f.size, kind: 'other', icon: 'chip', reclaimable: 0 });
  }
  children.push(...looseNodes(mount, known.filter((f) => !SYSTEM_FILES.test(f.name))));

  const rest = remainderNode(disk, sum(children, 'size'), disk.system ? 'System & hidden' : 'Hidden & reserved');
  if (rest) children.push(rest);

  children.sort((a, b) => b.size - a.size);
  scan.done = scan.total;
  scan.step('Done');
  return {
    name: disk.label,
    path: mount,
    size: sum(children, 'size'),
    kind: 'folder',
    icon: 'layers',
    reclaimable: sum(children, 'reclaimable'),
    children,
  };
}

/** Breaks down the home folder (root undefined) or a whole fixed drive by size, two levels deep. */
export async function scanSpaces(progress: Progress, root?: unknown): Promise<SpaceNode> {
  const scan = new Scan(progress);
  if (root === undefined || root === null) return scanHome(scan);
  if (typeof root !== 'string' || root.length === 0 || root.length > 260 || root.includes('\0')) {
    throw new Error('That drive is not available');
  }
  const disk = (await listDisks()).find((d) => sameMount(d.mount, root));
  if (!disk) throw new Error('That drive is not available');
  return scanDrive(scan, disk);
}
