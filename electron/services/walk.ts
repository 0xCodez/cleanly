import { promises as fsp, type Dirent, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

export interface WalkFile {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  atimeMs: number;
  birthtimeMs: number;
  /** 1 for direct children of the walk root. */
  depth: number;
}

export interface WalkOptions {
  /** Parallel fs operations, default 16. */
  concurrency?: number;
  /** Stop after this many files + folders have been seen. */
  maxEntries?: number;
  signal?: AbortSignal;
  onFile?: (file: WalkFile) => void;
  /** Called for every real (non-link) folder below the root, before its contents. */
  onDir?: (dirPath: string, depth: number) => void;
  /** Return true to leave a folder (and everything below it) out. */
  skipDir?: (dirPath: string, name: string, depth: number) => boolean;
  /** Throttled heartbeat, roughly every 2,000 entries. */
  onTick?: (entries: number, current: string) => void;
}

export interface WalkStats {
  bytes: number;
  files: number;
  dirs: number;
  /** maxEntries was reached before the walk finished. */
  truncated: boolean;
  aborted: boolean;
}

interface Item {
  path: string;
  depth: number;
  /** 'dir' = known real folder, 'stat' = needs lstat to learn what it is. */
  op: 'dir' | 'stat';
}

const TICK_EVERY = 2000;

/**
 * Walks a folder tree without ever following symlinks, junctions or other reparse points.
 * Unreadable entries are skipped silently. The root itself is not reported to onDir.
 */
export function walk(root: string, opts: WalkOptions = {}): Promise<WalkStats> {
  const concurrency = Math.max(1, opts.concurrency ?? 16);
  const maxEntries = opts.maxEntries ?? Number.POSITIVE_INFINITY;
  const stats: WalkStats = { bytes: 0, files: 0, dirs: 0, truncated: false, aborted: false };
  const stack: Item[] = [];
  let active = 0;
  let entries = 0;
  let nextTick = TICK_EVERY;

  const stopped = () => {
    if (opts.signal?.aborted) stats.aborted = true;
    return stats.aborted || stats.truncated;
  };

  const count = (p: string) => {
    entries++;
    if (entries >= maxEntries) stats.truncated = true;
    if (opts.onTick && entries >= nextTick) {
      nextTick = entries + TICK_EVERY;
      opts.onTick(entries, p);
    }
  };

  const enterDir = (p: string, name: string, depth: number) => {
    if (opts.skipDir?.(p, name, depth)) return;
    stats.dirs++;
    count(p);
    opts.onDir?.(p, depth);
    stack.push({ path: p, depth, op: 'dir' });
  };

  const addFile = (p: string, name: string, depth: number, st: Stats) => {
    stats.files++;
    stats.bytes += st.size;
    count(p);
    opts.onFile?.({
      path: p,
      name,
      size: st.size,
      mtimeMs: st.mtimeMs,
      atimeMs: st.atimeMs,
      birthtimeMs: st.birthtimeMs,
      depth,
    });
  };

  const readDir = async (item: Item) => {
    let list: Dirent[];
    try {
      list = await fsp.readdir(item.path, { withFileTypes: true });
    } catch {
      return;
    }
    const depth = item.depth + 1;
    for (const d of list) {
      if (stopped()) return;
      const p = path.join(item.path, d.name);
      // Dirent reports reparse points as links; those get an lstat to tell real links apart.
      if (d.isDirectory()) enterDir(p, d.name, depth);
      else if (d.isFile() || d.isSymbolicLink()) stack.push({ path: p, depth, op: 'stat' });
    }
  };

  const statEntry = async (item: Item) => {
    let st: Stats;
    try {
      st = await fsp.lstat(item.path);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    const name = path.basename(item.path);
    if (st.isDirectory()) enterDir(item.path, name, item.depth);
    else if (st.isFile()) addFile(item.path, name, item.depth, st);
  };

  return new Promise<WalkStats>((resolve) => {
    const finish = () => {
      if (active === 0 && (stack.length === 0 || stopped())) {
        stack.length = 0;
        resolve(stats);
        return true;
      }
      return false;
    };

    const pump = () => {
      while (active < concurrency && stack.length > 0 && !stopped()) {
        const item = stack.pop()!;
        active++;
        const job = item.op === 'dir' ? readDir(item) : statEntry(item);
        void job.finally(() => {
          active--;
          if (!finish()) pump();
        });
      }
      finish();
    };

    void (async () => {
      try {
        const st = await fsp.lstat(root);
        if (st.isDirectory() && !st.isSymbolicLink()) stack.push({ path: root, depth: 0, op: 'dir' });
      } catch {
        // missing or unreadable root: empty result
      }
      pump();
    })();
  });
}

/** Total bytes of a file or folder, links not followed. */
export async function dirSize(p: string, opts: Omit<WalkOptions, 'onFile'> = {}): Promise<number> {
  try {
    const st = await fsp.lstat(p);
    if (st.isSymbolicLink()) return 0;
    if (st.isFile()) return st.size;
  } catch {
    return 0;
  }
  return (await walk(p, opts)).bytes;
}

/** Runs fn over items with at most `limit` in flight. Results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Real (non-link) folder check. */
export async function isRealDir(p: string): Promise<boolean> {
  try {
    const st = await fsp.lstat(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

export const homeDir = () => os.homedir();

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p: string) => {
  const r = path.resolve(p);
  return caseInsensitive ? r.toLowerCase() : r;
};

export const samePath = (a: string, b: string) => norm(a) === norm(b);

/** True when child is strictly below parent (lexical, after resolve). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(norm(parent), norm(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Display form with ~ for the home folder. */
export function displayPath(p: string): string {
  const home = os.homedir();
  if (samePath(p, home)) return '~';
  if (isInside(home, p)) return `~${path.sep}${path.relative(home, p)}`;
  return p;
}

export type KnownFolder = 'desktop' | 'documents' | 'downloads' | 'pictures' | 'videos' | 'music';

const FALLBACK_NAMES: Record<KnownFolder, string> = {
  desktop: 'Desktop',
  documents: 'Documents',
  downloads: 'Downloads',
  pictures: 'Pictures',
  videos: process.platform === 'darwin' ? 'Movies' : 'Videos',
  music: 'Music',
};

/** Location of a user folder; honours Windows folder redirection (e.g. OneDrive) when Electron knows it. */
export function knownFolder(id: KnownFolder): string {
  try {
    const p = app?.getPath(id);
    if (p) return p;
  } catch {
    // app not ready or not running under Electron
  }
  return path.join(os.homedir(), FALLBACK_NAMES[id]);
}

export function knownFolders(): Record<KnownFolder, string> {
  return {
    desktop: knownFolder('desktop'),
    documents: knownFolder('documents'),
    downloads: knownFolder('downloads'),
    pictures: knownFolder('pictures'),
    videos: knownFolder('videos'),
    music: knownFolder('music'),
  };
}

/** Windows %LOCALAPPDATA% / %APPDATA%, with sane fallbacks. */
export const localAppData = () => process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
export const roamingAppData = () => process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Error codes that mean "in use or not allowed", which we skip and count rather than fail on. */
export function isLockError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY';
}
