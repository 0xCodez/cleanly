import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IconName, ScanProgress, SpaceNode } from '../../shared/types';
import { getDisk } from './disk';
import { DAY_MS, displayPath, knownFolders, samePath, walk } from './walk';

type Progress = (p: ScanProgress) => void;

const MAX_ENTRIES = 2_000_000;
const MAX_CHILDREN = 12;
const LOOSE_FILE_MIN = 256 * 1024 * 1024;
const OLD_MS = 90 * DAY_MS;
// Path segments that mark regenerable data inside AppData / Library (approximate on purpose).
const CACHE_SEGMENT =
  /(^|[\\/])(cache|caches|code cache|gpucache|cache_data|cache2|cachestorage|scriptcache|shadercache|grshadercache|temp|tmp|crashdumps|logs|npm-cache|deriveddata)([\\/]|$)/i;

const CODE_NAMES = /^(source|src|dev|develop|development|projects?|code|repos?|git|github|workspace|workspaces)$/i;

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

/** Breaks down the home folder (plus "System & apps") by size, two levels deep. */
export async function scanSpaces(progress: Progress): Promise<SpaceNode> {
  const home = os.homedir();
  const known = knownFolders();
  const cutoff = Date.now() - OLD_MS;

  const folders: string[] = [];
  const loose: { name: string; size: number }[] = [];
  try {
    for (const d of await fsp.readdir(home, { withFileTypes: true })) {
      const p = path.join(home, d.name);
      if (d.isDirectory()) {
        folders.push(d.name);
        continue;
      }
      // lstat everything else so junctions such as "My Documents" are never followed
      try {
        const st = await fsp.lstat(p);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) folders.push(d.name);
        else if (st.isFile()) loose.push({ name: d.name, size: st.size });
      } catch {
        // unreadable
      }
    }
  } catch {
    // home unreadable: fall through with an empty tree
  }

  const children: SpaceNode[] = [];
  let budget = MAX_ENTRIES;
  let last = 0;

  for (let i = 0; i < folders.length; i++) {
    const name = folders[i];
    const dir = path.join(home, name);
    const label = displayName(name);
    progress({ task: 'spaces', phase: `Measuring ${label}`, done: i, total: folders.length });

    const isDownloads = samePath(dir, known.downloads);
    const isAppData = /^(appdata|library)$/i.test(name);
    const buckets = new Map<string, Bucket>();
    const prefix = dir.length + 1;

    const stats = await walk(dir, {
      maxEntries: Math.max(1, budget),
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
        if (isDownloads && Math.max(f.mtimeMs, f.birthtimeMs || 0) < cutoff) b.reclaimable += f.size;
        else if (isAppData && CACHE_SEGMENT.test(rel)) b.reclaimable += f.size;
      },
      onTick: (_n, current) => {
        const now = Date.now();
        if (now - last < 120) return;
        last = now;
        progress({ task: 'spaces', phase: `Measuring ${label}`, done: i, total: folders.length, current: displayPath(current) });
      },
    });
    budget -= stats.files + stats.dirs;

    let reclaimable = 0;
    for (const b of buckets.values()) reclaimable += b.reclaimable;
    if (stats.bytes <= 0) continue;
    children.push({
      name: label,
      path: dir,
      size: stats.bytes,
      kind: 'folder',
      icon: iconFor(name, true, dir),
      reclaimable,
      children: toChildren(dir, buckets),
    });
  }

  const looseSmall = loose.filter((f) => f.size < LOOSE_FILE_MIN);
  for (const f of loose.filter((x) => x.size >= LOOSE_FILE_MIN)) {
    children.push({ name: f.name, path: path.join(home, f.name), size: f.size, kind: 'file', icon: 'file', reclaimable: 0 });
  }
  const looseTotal = looseSmall.reduce((s, f) => s + f.size, 0);
  if (looseTotal > 0) {
    const buckets = new Map(looseSmall.map((f): [string, Bucket] => [f.name, { size: f.size, reclaimable: 0, isDir: false }]));
    children.push({
      name: 'Loose files',
      path: home,
      size: looseTotal,
      kind: 'file',
      icon: 'file',
      reclaimable: 0,
      children: toChildren(home, buckets),
    });
  }

  const homeSize = children.reduce((s, c) => s + c.size, 0);
  try {
    const disk = await getDisk();
    const other = disk.used - homeSize;
    if (other > 0) {
      children.push({ name: 'System & apps', path: disk.mount, size: other, kind: 'other', icon: 'chip', reclaimable: 0 });
    }
  } catch {
    // disk info is a nice-to-have here
  }

  children.sort((a, b) => b.size - a.size);
  progress({ task: 'spaces', phase: 'Done', done: folders.length, total: folders.length });
  return {
    name: 'Home',
    path: home,
    size: children.reduce((s, c) => s + c.size, 0),
    kind: 'folder',
    icon: 'user',
    reclaimable: children.reduce((s, c) => s + c.reclaimable, 0),
    children,
  };
}
