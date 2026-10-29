import { app } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DuplicateGroup, ScanProgress } from '../../shared/types';

type Progress = (p: ScanProgress) => void;

interface Entry {
  path: string;
  size: number;
  modified: number;
}

const MIN_SIZE = 1024 * 1024;
const EDGE = 64 * 1024;
const MAX_FILES = 400_000;
const MAX_GROUPS = 200;

// Hidden folders, dependency trees and macOS packages (Photos/Music libraries, apps)
// hold files the user does not manage directly; removing a "duplicate" inside them breaks the package.
const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information', '__pycache__', 'bower_components']);
const PACKAGE_EXT = /\.(app|photoslibrary|photolibrary|musiclibrary|tvlibrary|imovielibrary|fcpbundle|logicx|band|aplibrary|lrdata|lrlibrary|bundle|framework|plugin|kext|xcodeproj|xcworkspace|pkg|mpkg|sparsebundle|rtfd|pages|numbers|key|vmwarevm|pvm|utm)$/i;

function scanRoots(): string[] {
  const home = os.homedir();
  const names = ['Desktop', 'Documents', 'Downloads', 'Pictures', process.platform === 'darwin' ? 'Movies' : 'Videos', 'Music'];
  const candidates = names.map((n) => path.join(home, n));
  // Windows folders are often redirected (e.g. into OneDrive); Electron knows the real locations.
  for (const key of ['desktop', 'documents', 'downloads', 'pictures', 'videos', 'music'] as const) {
    try {
      candidates.push(app.getPath(key));
    } catch {
      // Unknown on this system.
    }
  }
  const norm = (p: string) => (process.platform === 'linux' ? path.resolve(p) : path.resolve(p).toLowerCase());
  const unique = [...new Map(candidates.map((p) => [norm(p), path.resolve(p)])).values()];
  // Drop roots that sit inside another root so nothing is walked twice.
  return unique.filter((p) => !unique.some((o) => o !== p && norm(p).startsWith(norm(o) + path.sep)));
}

function throttle(progress: Progress): Progress {
  let last = 0;
  return (p) => {
    const now = Date.now();
    if (now - last < 120 && p.done !== p.total) return;
    last = now;
    progress(p);
  };
}

async function walk(roots: string[], report: (seen: number, dir: string) => void): Promise<Entry[]> {
  const files: Entry[] = [];
  const seenInodes = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) {
    try {
      const st = await fs.lstat(root);
      if (st.isDirectory() && !st.isSymbolicLink()) queue.push(root);
    } catch {
      // Missing root.
    }
  }
  let seen = 0;
  let active = 0;

  await new Promise<void>((resolve) => {
    const pump = () => {
      if (queue.length === 0 && active === 0) {
        resolve();
        return;
      }
      while (active < 16 && queue.length > 0 && files.length < MAX_FILES) {
        const dir = queue.pop()!;
        active++;
        visit(dir).finally(() => {
          active--;
          pump();
        });
      }
      if (files.length >= MAX_FILES && active === 0) resolve();
    };

    const visit = async (dir: string) => {
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        return;
      }
      report(seen, dir);
      for (const name of names) {
        if (name.startsWith('.')) continue;
        const full = path.join(dir, name);
        // bigint keeps NTFS 64-bit file ids exact; as plain numbers distinct files could share an id.
        let st: import('node:fs').BigIntStats;
        try {
          st = await fs.lstat(full, { bigint: true });
        } catch {
          continue;
        }
        // lstat reports symlinks and Windows junctions as links; never follow them.
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          if (!SKIP_DIRS.has(name.toLowerCase()) && !PACKAGE_EXT.test(name)) queue.push(full);
          continue;
        }
        if (!st.isFile()) continue;
        seen++;
        const size = Number(st.size);
        if (size < MIN_SIZE) continue;
        // macOS iCloud "dataless" files have no local blocks; reading them would download them.
        if (process.platform === 'darwin' && st.blocks === 0n) continue;
        // Hard links, or one file reached through two scan roots, share storage: a second name is not a
        // real copy, and offering it for the Trash would remove the only copy.
        if (st.ino) {
          const key = `${st.dev}:${st.ino}`;
          if (seenInodes.has(key)) continue;
          seenInodes.add(key);
        }
        files.push({ path: full, size, modified: Math.round(Number(st.mtimeMs)) });
      }
    };

    pump();
  });
  return files;
}

/**
 * Cloud placeholders (OneDrive, Dropbox, iCloud for Windows) look like normal files but
 * reading them downloads the whole file. Windows marks them with recall/offline attributes.
 */
function windowsLocalOnly(entries: Entry[]): Promise<Entry[]> {
  if (process.platform !== 'win32' || entries.length === 0) return Promise.resolve(entries);
  const script = [
    '[Console]::InputEncoding = [Text.Encoding]::UTF8',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    '$paths = [Console]::In.ReadToEnd() -split "`n"',
    'foreach ($p in $paths) { if ($p) { try { [int][IO.File]::GetAttributes($p.TrimEnd("`r")) } catch { -1 } } }',
  ].join('; ');
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const attrs = out.split(/\r?\n/).filter((l) => l.trim() !== '').map(Number);
      // If we cannot tell, skip everything rather than risk pulling files from the cloud.
      if (!ok || attrs.length !== entries.length) {
        resolve([]);
        return;
      }
      const CLOUD = 0x1000 | 0x40000 | 0x400000; // OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS
      resolve(entries.filter((_, i) => attrs[i] >= 0 && (attrs[i] & CLOUD) === 0));
    };
    const child = spawn(path.join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, 60000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      out += d;
    });
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
    child.stdin.on('error', () => undefined);
    child.stdin.end(entries.map((e) => e.path).join('\n'), 'utf8');
  });
}

async function partialHash(e: Entry): Promise<string | null> {
  let fh: import('node:fs/promises').FileHandle | null = null;
  try {
    fh = await fs.open(e.path, 'r');
    const head = Buffer.alloc(EDGE);
    const tail = Buffer.alloc(EDGE);
    const a = await fh.read(head, 0, EDGE, 0);
    const b = await fh.read(tail, 0, EDGE, Math.max(0, e.size - EDGE));
    return createHash('sha1').update(head.subarray(0, a.bytesRead)).update(tail.subarray(0, b.bytesRead)).digest('hex');
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

function fullHash(e: Entry): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = createHash('sha256');
    const stream = createReadStream(e.path, { highWaterMark: 1024 * 1024 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', () => resolve(null));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

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

function groupBy<K>(entries: Entry[], keys: (K | null)[]): [K, Entry[]][] {
  const map = new Map<K, Entry[]>();
  entries.forEach((e, i) => {
    const k = keys[i];
    if (k === null) return;
    const list = map.get(k);
    if (list) list.push(e);
    else map.set(k, [e]);
  });
  return [...map.entries()].filter(([, g]) => g.length > 1);
}

export async function scanDuplicates(progress: Progress): Promise<DuplicateGroup[]> {
  const send = throttle(progress);
  send({ task: 'dupes', phase: 'Looking for files', done: 0, total: 0 });
  const files = await walk(scanRoots(), (seen, dir) =>
    send({ task: 'dupes', phase: 'Looking for files', done: seen, total: 0, current: dir }));

  // Only files sharing an exact size can be duplicates.
  const bySize = groupBy(files, files.map((f) => f.size));
  const sizeCandidates = await windowsLocalOnly(bySize.flatMap(([, g]) => g));

  let done = 0;
  const partialTotal = sizeCandidates.length;
  const partialKeys = await mapLimit(sizeCandidates, 6, async (e) => {
    const h = await partialHash(e);
    send({ task: 'dupes', phase: 'Comparing files', done: ++done, total: partialTotal, current: e.path });
    return h === null ? null : `${e.size}:${h}`;
  });
  const partialGroups = groupBy(sizeCandidates, partialKeys);

  const fullCandidates = partialGroups.flatMap(([, g]) => g);
  done = 0;
  const fullKeys = await mapLimit(fullCandidates, 4, async (e) => {
    const h = await fullHash(e);
    send({ task: 'dupes', phase: 'Checking contents', done: ++done, total: fullCandidates.length, current: e.path });
    return h;
  });

  // sha256 over the whole content: equal hashes with equal sizes are byte-identical files.
  const groups: DuplicateGroup[] = groupBy(fullCandidates, fullKeys).map(([hash, g]) => ({
    hash,
    size: g[0].size,
    files: g.map((f) => ({ path: f.path, modified: f.modified })).sort((a, b) => b.modified - a.modified),
  }));
  groups.sort((a, b) => b.size * (b.files.length - 1) - a.size * (a.files.length - 1));
  progress({ task: 'dupes', phase: 'Done', done: groups.length, total: groups.length });
  return groups.slice(0, MAX_GROUPS);
}
