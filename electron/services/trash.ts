import { shell } from 'electron';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CleanResult } from '../../shared/types';
import { dataDriveMounts } from './disk';
import { dirSize, isInside, knownFolders, mapLimit, samePath, walk } from './walk';

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function systemRoots(): string[] {
  if (isWin) {
    const env = process.env;
    const drive = path.parse(os.homedir()).root || 'C:\\';
    return [
      env.SystemRoot || env.windir || path.join(drive, 'Windows'),
      env.ProgramFiles || path.join(drive, 'Program Files'),
      env['ProgramFiles(x86)'] || path.join(drive, 'Program Files (x86)'),
      env.ProgramW6432 || path.join(drive, 'Program Files'),
      env.ProgramData || path.join(drive, 'ProgramData'),
      path.join(drive, '$Recycle.Bin'),
      path.join(drive, 'System Volume Information'),
      path.join(drive, 'Recovery'),
    ];
  }
  if (isMac) return ['/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/etc', '/var', '/private', '/opt', '/cores', '/dev', '/Volumes'];
  // Fedora Atomic keeps homes in /var/home: a root that holds the home folder cannot be off limits as a whole.
  const home = os.homedir();
  return ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/etc', '/var', '/opt', '/dev', '/proc', '/sys', '/run', '/boot', '/efi', '/root', '/srv', '/snap', '/nix']
    .filter((r) => !(home === r || home.startsWith(`${r}/`)));
}

/** Top-level user folders that must never be trashed as a whole. */
const PROTECTED_TOP = [
  'Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Movies', 'Music', 'AppData', 'Library', 'Applications',
  'OneDrive', 'iCloud Drive', 'Public', 'Favorites', 'Contacts', 'Links', 'Saved Games', 'Searches', '3D Objects',
  'iCloudDrive', 'Dropbox', 'Google Drive', 'Creative Cloud Files', '.Trash', '.local', '.config',
  // Linux: Flatpak and Snap app data, the cache root, browser profiles, the Templates folder
  '.var', 'snap', '.cache', '.mozilla', 'Templates',
];

/** Places inside home that hold keys and credentials: nothing in or under them is ever touched. */
const SECRET_DIRS = [
  '.ssh', '.gnupg', path.join('Library', 'Keychains'),
  path.join('.local', 'share', 'keyrings'), path.join('.local', 'share', 'kwalletd'), '.password-store', '.pki',
  path.join('AppData', 'Roaming', 'Microsoft', 'Protect'),
  path.join('AppData', 'Roaming', 'Microsoft', 'Credentials'),
  path.join('AppData', 'Local', 'Microsoft', 'Credentials'),
];

/** Top-level entries of a data drive (D:, /Volumes/Data) that belong to the OS or to app installers. */
const DRIVE_PROTECTED_TOP = new Set(
  (isWin
    ? [
        'Windows', 'Windows.old', 'Program Files', 'Program Files (x86)', 'ProgramData', 'Recovery', 'Boot', 'EFI',
        'System Volume Information', 'Users', 'Documents and Settings', 'PerfLogs', 'Config.Msi', 'MSOCache',
        'WindowsApps', 'WpSystem', 'XboxGames', 'OneDriveTemp', 'bootmgr', 'BOOTNXT', 'BOOTSECT.BAK', 'pagefile.sys',
        'hiberfil.sys', 'swapfile.sys', 'DumpStack.log', 'DumpStack.log.tmp', 'desktop.ini', 'autorun.inf',
      ]
    : ['System', 'Library', 'Applications', 'Users', 'private', 'Backups.backupdb', 'cores', 'usr', 'bin', 'sbin', 'etc', 'var', 'opt', 'lost+found', 'home', 'timeshift']
  ).map((n) => n.toLowerCase()),
);

const CLOUD_TOP = /^(OneDrive( - .+)?|Dropbox|Google Drive|My Drive|iCloud ?Drive|Creative Cloud Files|Yandex\.?Disk)$/i;

function cloudRoots(): string[] {
  const env = process.env;
  return [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].filter((p): p is string => !!p && path.isAbsolute(p));
}

/** Strictly inside a data drive and outside its OS / installer folders. `mount` comes from listDisks(). */
function isSafeDrivePath(raw: string, abs: string, mount: string): boolean {
  if (isWin) {
    // drive-letter paths only: no UNC / \\?\ device paths, no alternate data streams ("file:stream")
    if (!/^[a-zA-Z]:[\\/]/.test(raw) || !/^[a-zA-Z]:\\$/.test(mount) || abs.indexOf(':', 2) !== -1) return false;
  }
  if (!isInside(mount, abs)) return false;
  const parts = path.relative(mount, abs).split(path.sep);
  const top = parts[0];
  if (!top) return false;
  // "$Recycle.Bin", "$WinREAgent" on Windows; ".Trashes", ".Spotlight-V100", ".fseventsd" on macOS
  if (top.startsWith(isWin ? '$' : '.')) return false;
  if (DRIVE_PROTECTED_TOP.has(top.toLowerCase())) return false;
  // Windows quietly drops trailing dots and spaces, so "Windows." would name the Windows folder
  if (isWin && parts.some((s) => /[. ]$/.test(s))) return false;
  if (isWin) for (const sys of systemRoots()) if (samePath(abs, sys) || isInside(sys, abs)) return false;
  // Documents, Desktop & co. are often redirected to a data drive: never trash them or a folder holding them
  for (const k of Object.values(knownFolders())) if (samePath(abs, k) || isInside(abs, k)) return false;
  // a sync root moved to a data drive: trashing it would delete everything in the cloud too
  if (parts.length === 1 && CLOUD_TOP.test(top)) return false;
  for (const c of cloudRoots()) if (samePath(abs, c) || isInside(abs, c)) return false;
  return true;
}

/**
 * Lexical guard for anything the renderer asks to move to the Trash.
 * Allows only paths strictly inside the home folder that are not OS folders, user root folders or key stores,
 * or (when `drives` lists them) paths on another fixed data drive outside its system folders.
 */
export function isSafeUserPath(p: unknown, home: string = os.homedir(), drives: readonly string[] = []): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096 || p.includes('\0')) return false;
  if (!path.isAbsolute(p)) return false;
  const abs = path.resolve(p);
  if (path.parse(abs).root === abs) return false;
  if (isSafeHomePath(abs, home)) return true;
  return drives.some((m) => !isInside(home, m) && !samePath(home, m) && !isInside(m, home) && isSafeDrivePath(p, abs, m));
}

function isSafeHomePath(abs: string, home: string): boolean {
  if (samePath(abs, home) || !isInside(home, abs)) return false;
  for (const sys of systemRoots()) if (samePath(abs, sys) || isInside(sys, abs)) return false;
  if (isMac && /^\/Applications\/?$/i.test(abs)) return false;

  const rel = path.relative(home, abs);
  const parts = rel.split(path.sep);
  if (parts.length === 1 && PROTECTED_TOP.some((n) => n.toLowerCase() === parts[0].toLowerCase())) return false;
  if (parts.length === 1 && /^OneDrive( - .+)?$/i.test(parts[0])) return false;
  // AppData\Local, AppData\Roaming, Library/Application Support and friends; ~/.local/share, ~/.var/app
  if (parts.length === 2 && /^(AppData|Library|\.local|\.var)$/i.test(parts[0])) return false;
  for (const s of SECRET_DIRS) {
    const sp = path.join(home, s);
    if (samePath(abs, sp) || isInside(sp, abs)) return false;
  }
  for (const k of Object.values(knownFolders())) if (samePath(abs, k)) return false;
  return true;
}

type Verdict = { kind: 'ok'; real: string } | { kind: 'blocked' } | { kind: 'gone' };

interface Drives {
  lexical: string[];
  /** the same mounts after realpath, for the canonical re-check */
  real: string[];
}

/** Fixed data drives from listDisks(); removable, network and unknown drives never qualify. */
async function dataDrives(): Promise<Drives> {
  let lexical: string[] = [];
  try {
    lexical = await dataDriveMounts();
  } catch {
    // without a drive list only the home folder qualifies
  }
  const real: string[] = [];
  for (const m of lexical) {
    try {
      const r = await fsp.realpath(m);
      if (samePath(r, m)) real.push(r);
    } catch {
      // unreadable drive: nothing on it qualifies
    }
  }
  return { lexical: lexical.filter((m) => real.some((r) => samePath(r, m))), real };
}

/**
 * Same guard, re-run on the canonical path. Resolving the full path (not just the parent) also
 * expands Windows 8.3 short names and trailing dots, so "DOCUME~1" or "Documents." cannot slip past
 * the protected-folder check, and a junction in a parent folder cannot point outside home.
 */
async function resolveSafe(p: string, drives: Drives): Promise<Verdict> {
  if (!isSafeUserPath(p, os.homedir(), drives.lexical)) return { kind: 'blocked' };
  try {
    const st = await fsp.lstat(p);
    if (st.isSymbolicLink()) return { kind: 'blocked' };
    const [realHome, real] = await Promise.all([fsp.realpath(os.homedir()), fsp.realpath(path.resolve(p))]);
    return isSafeUserPath(real, realHome, drives.real) ? { kind: 'ok', real } : { kind: 'blocked' };
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'gone' } : { kind: 'blocked' };
  }
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** Moves the user's own files to the system Trash so they can be restored. */
export async function trashPaths(paths: unknown): Promise<CleanResult> {
  const result: CleanResult = { freed: 0, removed: 0, failed: 0, skipped: [] };
  if (!Array.isArray(paths)) return result;

  const unique: string[] = [];
  for (const p of paths) {
    if (typeof p !== 'string') continue;
    if (!unique.some((u) => samePath(u, p))) unique.push(p);
  }
  let blocked = 0;
  let gone = 0;
  let locked = 0;
  let errors = 0;

  const drives = unique.length > 0 ? await dataDrives() : { lexical: [], real: [] };
  const allowed: string[] = [];
  for (const p of unique) {
    const verdict = await resolveSafe(p, drives);
    if (verdict.kind === 'gone') gone++;
    else if (verdict.kind === 'blocked') blocked++;
    // Trash exactly the canonical path that passed the guard; two spellings of one file collapse here.
    else if (!allowed.some((a) => samePath(a, verdict.real))) allowed.push(verdict.real);
  }
  // A file inside a folder that is also selected goes with the folder.
  const list = allowed.filter((p) => !allowed.some((o) => o !== p && isInside(o, p)));

  for (const p of list) {
    const size = await dirSize(p);
    try {
      // Electron aborts (instead of deleting for good) when Windows cannot recycle an item,
      // e.g. it is bigger than the Recycle Bin or the bin is turned off; that lands in `errors`.
      await shell.trashItem(p);
      result.freed += size;
      result.removed++;
    } catch (err) {
      const msg = String((err as Error)?.message ?? err).toLowerCase();
      if (/in use|busy|being used|locked|sharing violation/.test(msg)) locked++;
      else errors++;
    }
  }

  result.failed = blocked + locked + errors;
  if (locked) result.skipped.push(`${plural(locked, 'item is', 'items are')} in use`);
  if (blocked) result.skipped.push(`${plural(blocked, 'item', 'items')} blocked for safety`);
  if (errors) result.skipped.push(`${plural(errors, 'item', 'items')} could not be moved to the Trash`);
  if (gone) result.skipped.push(`${plural(gone, 'item was', 'items were')} already gone`);
  return result;
}

export interface DeleteOutcome {
  freed: number;
  removed: number;
  /** Files held open by another app. */
  locked: number;
  /** Files we are not allowed to delete (usually needs admin). */
  denied: number;
  /** The target failed the realpath / symlink check and was left alone. */
  refused: boolean;
}

export interface DeleteOptions {
  /** Only delete files last modified before this epoch ms (keeps fresh temp files of running apps). */
  modifiedBefore?: number;
}

type UnlinkResult = 'ok' | 'gone' | 'locked' | 'denied';

async function unlinkFile(p: string): Promise<UnlinkResult> {
  try {
    await fsp.unlink(p);
    return 'ok';
  } catch (err) {
    let code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' && isWin) {
      // read-only attribute; clear it once and retry
      try {
        await fsp.chmod(p, 0o666);
        await fsp.unlink(p);
        return 'ok';
      } catch (err2) {
        code = (err2 as NodeJS.ErrnoException).code;
      }
    }
    if (code === 'ENOENT') return 'gone';
    if (code === 'EBUSY' || (code === 'EPERM' && isWin)) return 'locked';
    return 'denied';
  }
}

/**
 * Permanently deletes one cache entry (file or folder) that must live strictly inside `root`.
 * Never follows links: link entries inside are left in place. Locked files are skipped and counted.
 */
export async function deleteCacheEntry(target: string, root: string, opts: DeleteOptions = {}): Promise<DeleteOutcome> {
  const out: DeleteOutcome = { freed: 0, removed: 0, locked: 0, denied: 0, refused: false };
  try {
    const st = await fsp.lstat(target);
    if (st.isSymbolicLink() || !isInside(root, target)) {
      out.refused = true;
      return out;
    }
    const [realRoot, realTarget] = await Promise.all([fsp.realpath(root), fsp.realpath(target)]);
    if (!isInside(realRoot, realTarget)) {
      out.refused = true;
      return out;
    }

    const cutoff = opts.modifiedBefore;
    // Creation time counts too: files an installer just unpacked keep the archive's old mtime.
    const fresh = (s: { mtimeMs: number; birthtimeMs: number }) =>
      cutoff !== undefined && Math.max(s.mtimeMs, s.birthtimeMs || 0) >= cutoff;
    const tally = (r: UnlinkResult, size: number) => {
      if (r === 'ok') {
        out.freed += size;
        out.removed++;
      } else if (r === 'locked') out.locked++;
      else if (r === 'denied') out.denied++;
    };

    if (st.isFile()) {
      if (!fresh(st)) tally(await unlinkFile(target), st.size);
      return out;
    }
    if (!st.isDirectory()) return out;

    // Plain arrays instead of WalkFile objects: a single cache folder can hold a million files.
    const filePaths: string[] = [];
    const fileSizes: number[] = [];
    const dirs: { path: string; depth: number }[] = [];
    await walk(target, {
      onFile: (f) => {
        if (fresh(f)) return;
        filePaths.push(f.path);
        fileSizes.push(f.size);
      },
      onDir: (p, depth) => dirs.push({ path: p, depth }),
    });

    // Folders a running app created recently stay, even when empty. Checked before any unlink,
    // because deleting files bumps the folder's own mtime.
    const keepDirs = new Set<string>();
    if (cutoff !== undefined) {
      if (fresh(st)) keepDirs.add(target);
      await mapLimit(dirs, 16, async (d) => {
        try {
          if (fresh(await fsp.lstat(d.path))) keepDirs.add(d.path);
        } catch {
          // gone already
        }
      });
    }

    await mapLimit(filePaths, 16, async (p, i) => tally(await unlinkFile(p), fileSizes[i]));
    dirs.sort((a, b) => b.depth - a.depth);
    for (const d of dirs) if (!keepDirs.has(d.path)) await fsp.rmdir(d.path).catch(() => undefined);
    if (!keepDirs.has(target)) await fsp.rmdir(target).catch(() => undefined);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') out.denied++;
  }
  return out;
}
