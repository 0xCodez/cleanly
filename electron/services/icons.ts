import { app, nativeImage, shell, type NativeImage } from 'electron';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listDisks } from './disk';

const MAX_PATHS = 200;
const MAX_CACHE = 3000;
const SIZE = 64;
const CONCURRENCY = 6;
const TIMEOUT_MS = 8000;
const IMAGE_EXT = new Set(['.ico', '.png']);
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
/**
 * The shell reads these files' icon location from inside the file, and that location may be
 * \\host\share: just drawing the icon would make Windows contact the host and send the user's credentials.
 */
const INDIRECT_EXT = new Set([
  '.url', '.website', '.scf', '.library-ms', '.searchconnector-ms', '.appref-ms', '.application', '.theme',
  '.themepack', '.deskthemepack', '.desktop', '.ini', '.inf',
]);

/** candidate key -> data URL, or null when the system had no icon for it */
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null | undefined>>();

function expandEnv(p: string): string {
  return p.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase());
    return (key && process.env[key]) || whole;
  });
}

function absoluteLocal(p: string): string | null {
  if (isWin) {
    const e = expandEnv(p.trim());
    // drive-letter paths only; a second ':' would name an alternate data stream
    if (!/^[a-zA-Z]:[\\/]/.test(e) || /%[^%\\]+%/.test(e) || e.includes('"') || e.indexOf(':', 2) !== -1) return null;
    return path.resolve(e);
  }
  let e = p;
  if (e === '~' || e.startsWith('~/')) e = path.join(os.homedir(), e.slice(1));
  if (!path.isAbsolute(e) || e.startsWith('//')) return null;
  return path.resolve(e);
}

/**
 * Paths to try for one requested string, best first. Besides plain paths this understands Windows
 * DisplayIcon values (`"C:\X\x.exe",0`, `%SystemRoot%\x.exe,-101`) and commands (`"C:\X\x.exe" --tray`).
 * UNC, device and relative paths are never returned.
 */
function candidates(raw: string): string[] {
  if (raw.length === 0 || raw.length > 4096 || raw.includes('\0')) return [];
  const p = raw.trim();
  const forms = [p];
  if (process.platform === 'win32') {
    const noIndex = p.replace(/,\s*-?\d+$/, '').trim();
    const quoted = /^"([^"]+)"/.exec(noIndex);
    if (quoted) forms.push(quoted[1]);
    else {
      forms.push(noIndex);
      const exe = /^(.+?\.(?:exe|com|lnk|ico|png))(?=\s|$)/i.exec(noIndex);
      if (exe) forms.push(exe[1]);
    }
  } else {
    const quoted = /^"([^"]+)"$/.exec(p);
    if (quoted) forms.push(quoted[1]);
  }
  const out: string[] = [];
  for (const f of forms) {
    const abs = absoluteLocal(f);
    if (abs && !out.includes(abs)) out.push(abs);
  }
  return out;
}

function withTimeout<T>(job: Promise<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), TIMEOUT_MS);
    job.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(undefined); },
    );
  });
}

function resized(img: NativeImage): NativeImage {
  const { width, height } = img.getSize();
  if (width <= SIZE && height <= SIZE) return img;
  const scale = SIZE / Math.max(width, height);
  return img.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'best' });
}

/** Mounts of the fixed local drives; mapped network drives, removable and optical drives are not among them. */
async function localMounts(): Promise<string[]> {
  try {
    return (await listDisks()).map((d) => d.mount);
  } catch {
    return [];
  }
}

const AUTOFS = /^\/(net|Network|home)(\/|$)/;

/**
 * The same path with every link on the way resolved, or null when it leaves the fixed local drives.
 * Each step is an lstat, which never follows a link, so a symlink to \\host\share is caught before
 * anything opens it.
 */
async function localPath(abs: string, mounts: string[], hops = 0): Promise<string | null> {
  if (hops > 8) return null;
  if (isWin) {
    const root = path.parse(abs).root;
    if (!mounts.some((m) => m.toLowerCase() === root.toLowerCase())) return null;
  } else if (isMac) {
    if (AUTOFS.test(abs)) return null;
    if (abs.startsWith('/Volumes/') && !mounts.some((m) => m !== '/' && (abs === m || abs.startsWith(`${m}/`)))) return null;
    return abs;
  } else return abs;

  const root = path.parse(abs).root;
  const parts = abs.slice(root.length).split(path.sep).filter(Boolean);
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    const st = await fs.lstat(cur).catch(() => null);
    if (!st) return null;
    if (!st.isSymbolicLink()) {
      if (i === parts.length - 1 && st.isDirectory()) return null; // desktop.ini can name a remote icon
      continue;
    }
    let target = await fs.readlink(cur).catch(() => null);
    if (!target) return null;
    if (!/^[a-zA-Z]:[\\/]/.test(target)) {
      if (path.isAbsolute(target)) return null; // \\host\share or a rooted path without a drive
      target = path.resolve(path.dirname(cur), target);
    }
    return localPath(path.resolve(target, ...parts.slice(i + 1)), mounts, hops + 1);
  }
  return abs;
}

/** The file whose icon is safe to draw: local, not a folder, not a type that names its own icon location. */
async function safeIconFile(f: string): Promise<string | null> {
  const mounts = await localMounts();
  let file = await localPath(f, mounts);
  if (!file) return null;
  const ext = path.extname(file).toLowerCase();
  if (INDIRECT_EXT.has(ext)) return null;
  if (isWin && ext === '.lnk') {
    // a shortcut may carry its own (remote) icon location: draw its local target instead
    let target: string | null = null;
    try {
      target = absoluteLocal(shell.readShortcutLink(file).target ?? '');
    } catch {
      target = null;
    }
    if (!target || ['.lnk', ...INDIRECT_EXT].includes(path.extname(target).toLowerCase())) return null;
    file = await localPath(target, mounts);
  }
  return file;
}

/** undefined = timed out (worth retrying later), null = no icon */
async function loadIcon(files: string[]): Promise<string | null | undefined> {
  let file: string | undefined;
  for (const f of files) {
    const found = await withTimeout(safeIconFile(f));
    if (found === undefined) return undefined;
    if (found) {
      file = found;
      break;
    }
  }
  if (!file) return null;
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXT.has(ext)) {
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) return resized(img).toDataURL();
  }
  if (isMac && ext === '.app') {
    const thumb = await withTimeout(nativeImage.createThumbnailFromPath(file, { width: SIZE, height: SIZE }));
    if (thumb && !thumb.isEmpty()) return thumb.toDataURL();
  }
  // macOS has no "large" size; "normal" is its biggest.
  const img = await withTimeout(app.getFileIcon(file, { size: isMac ? 'normal' : 'large' }));
  if (img === undefined) return undefined;
  return img.isEmpty() ? null : img.toDataURL();
}

function remember(key: string, value: string | null) {
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

function iconFor(files: string[]): Promise<string | null | undefined> {
  const key = files.join('\n');
  if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null);
  let job = inflight.get(key);
  if (!job) {
    job = loadIcon(files)
      .catch(() => null)
      .then((v) => {
        if (v !== undefined) remember(key, v);
        inflight.delete(key);
        return v;
      });
    inflight.set(key, job);
  }
  return job;
}

/** Real system icons as PNG data URLs, keyed by the path exactly as requested. Unknown or invalid paths are left out. */
export async function getFileIcons(paths: unknown): Promise<Record<string, string>> {
  if (!Array.isArray(paths) || paths.length > MAX_PATHS) throw new Error('Invalid request');
  const wanted: { key: string; files: string[] }[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    if (typeof p !== 'string' || seen.has(p)) continue;
    seen.add(p);
    const files = candidates(p);
    if (files.length) wanted.push({ key: p, files });
  }
  const out: Record<string, string> = {};
  let next = 0;
  const worker = async () => {
    while (next < wanted.length) {
      const { key, files } = wanted[next++];
      const url = await iconFor(files);
      if (url) out[key] = url;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, worker));
  return out;
}
