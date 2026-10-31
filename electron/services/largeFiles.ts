import os from 'node:os';
import path from 'node:path';
import type { LargeFile, ScanProgress } from '../../shared/types';
import { dataDriveMounts, listDisks } from './disk';
import { displayPath, isInside, localAppData, samePath, walk, type WalkFile } from './walk';

type Progress = (p: ScanProgress) => void;
type Kind = LargeFile['kind'];

const MAX_RESULTS = 300;
const MAX_ENTRIES = 2_000_000;
const MB = 1024 * 1024;

const KINDS: Record<Exclude<Kind, 'other'>, string[]> = {
  video: ['mp4', 'mkv', 'mov', 'avi', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp', 'm2ts', 'mts', 'vob', 'prproj'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'lz', 'lzma', 'cab'],
  'disk-image': ['iso', 'img', 'dmg', 'vhd', 'vhdx', 'vmdk', 'vdi', 'qcow2', 'wim', 'esd', 'sparseimage', 'hdd'],
  installer: ['exe', 'msi', 'msix', 'msixbundle', 'appx', 'appxbundle', 'pkg', 'mpkg', 'deb', 'rpm', 'apk', 'xapk', 'appimage'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'wma', 'aiff', 'aif', 'opus', 'alac', 'mid'],
  photo: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'psd', 'psb', 'webp', 'avif', 'orf', 'rw2', 'raf'],
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'txt', 'csv', 'epub', 'mobi', 'pages', 'numbers', 'key', 'indd', 'ai', 'sketch', 'fig'],
};

const EXT_KIND = new Map<string, Kind>();
for (const [kind, exts] of Object.entries(KINDS) as [Kind, string[]][]) for (const e of exts) EXT_KIND.set(e, kind);

export function kindOf(name: string): Kind {
  return EXT_KIND.get(path.extname(name).slice(1).toLowerCase()) ?? 'other';
}

// Regenerable caches are the junk scanner's job; they only add noise here.
const CACHE_DIRS = new Set([
  'cache', 'caches', 'code cache', 'gpucache', 'cache_data', 'cache2', 'cachestorage', 'scriptcache', 'shadercache', 'grshadercache',
]);

const isWin = process.platform === 'win32';

/** Top-level folders of a data drive that hold the OS, installed apps or volume metadata. */
const DRIVE_SKIP_TOP = new Set(
  (isWin
    ? [
        'Windows', 'Windows.old', 'Program Files', 'Program Files (x86)', 'ProgramData', 'System Volume Information', 'Recovery',
        'Boot', 'EFI', 'PerfLogs', 'WindowsApps', 'WpSystem', 'Config.Msi', 'MSOCache', 'OneDriveTemp',
      ]
    : ['System', 'Library', 'private', 'usr', 'bin', 'sbin', 'cores', 'opt', 'etc', 'var', 'Backups.backupdb']
  ).map((s) => s.toLowerCase()),
);
const SYSTEM_FILES = /^(pagefile\.sys|hiberfil\.sys|swapfile\.sys|dumpstack\.log(\.tmp)?)$/i;
const TOTAL_ENTRIES = 4_000_000;

/** Biggest files under the home folder and on every other fixed drive, at least minBytes each. */
export async function scanLargeFiles(minBytes: unknown, progress: Progress): Promise<LargeFile[]> {
  const n = Number(minBytes);
  const min = Number.isFinite(n) && n >= MB ? n : 100 * MB;
  const home = os.homedir();
  const appData = process.platform === 'darwin' ? path.join(home, 'Library') : path.join(home, 'AppData');
  const skipExact = [
    path.join(localAppData(), 'Temp'),
    os.tmpdir(),
    path.join(home, 'Library', 'Caches'),
    path.join(home, '.Trash'),
    path.join(home, '.cache'),
  ];

  // walk hands out resolved paths, so a lowercase lookup is enough on the case-insensitive desktop file systems
  const skipSet = new Set(skipExact.map((s) => path.resolve(s).toLowerCase()));

  let found: LargeFile[] = [];
  const trim = () => {
    found.sort((a, b) => b.size - a.size);
    found = found.slice(0, MAX_RESULTS);
  };
  let last = 0;
  let seen = 0;
  const homePhase = '正在查找大文件';
  progress({ task: 'large', phase: homePhase, done: 0, total: 0 });

  const collect = (f: WalkFile) => {
    if (f.size < min) return;
    found.push({ path: f.path, name: f.name, size: f.size, modified: f.mtimeMs, accessed: f.atimeMs, kind: kindOf(f.name) });
    if (found.length > MAX_RESULTS * 10) trim();
  };
  const ticker = (phase: string) => (entries: number, current: string) => {
    const now = Date.now();
    if (now - last < 120) return;
    last = now;
    progress({ task: 'large', phase, done: seen + entries, total: 0, current: displayPath(current) });
  };

  const homeStats = await walk(home, {
    maxEntries: MAX_ENTRIES,
    skipDir: (p, name) =>
      skipSet.has(p.toLowerCase()) || (CACHE_DIRS.has(name.toLowerCase()) && isInside(appData, p)),
    onFile: collect,
    onTick: ticker(homePhase),
  });
  seen += homeStats.files + homeStats.dirs;

  let drives: { mount: string; label: string }[] = [];
  try {
    const mounts = await dataDriveMounts();
    drives = (await listDisks()).filter((d) => mounts.includes(d.mount));
  } catch {
    // home only
  }
  for (const d of drives) {
    const budget = Math.min(MAX_ENTRIES, TOTAL_ENTRIES - seen);
    if (budget <= 0) break;
    const phase = `正在查找 ${d.label}`;
    progress({ task: 'large', phase, done: seen, total: 0 });
    const stats = await walk(d.mount, {
      maxEntries: budget,
      skipDir: (p, name, depth) =>
        isInside(home, p) || samePath(home, p) ||
        (depth === 1 && (DRIVE_SKIP_TOP.has(name.toLowerCase()) || name.startsWith(isWin ? '$' : '.'))),
      onFile: (f) => {
        if (f.depth === 1 && SYSTEM_FILES.test(f.name)) return;
        collect(f);
      },
      onTick: ticker(phase),
    });
    seen += stats.files + stats.dirs;
  }

  trim();
  progress({ task: 'large', phase: '完成', done: found.length, total: found.length });
  return found;
}
