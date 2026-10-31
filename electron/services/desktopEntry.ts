import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Keys of the [Desktop Entry] group of a freedesktop .desktop file (unlocalized keys only). */
export type DesktopEntry = Map<string, string>;

const MAX_BYTES = 256 * 1024;

export function parseDesktopEntry(text: string): DesktopEntry {
  const out: DesktopEntry = new Map();
  let inMain = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inMain = line === '[Desktop Entry]';
      continue;
    }
    if (!inMain) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key.includes('[')) continue; // Name[de]=… and friends
    if (!out.has(key)) out.set(key, line.slice(eq + 1).trim());
  }
  return out;
}

export async function readDesktopEntry(file: string): Promise<DesktopEntry | null> {
  try {
    const st = await fs.lstat(file);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    return parseDesktopEntry(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export const isTrue = (v: string | undefined) => v?.toLowerCase() === 'true';
const list = (v: string | undefined) => (v ?? '').split(';').map((s) => s.trim()).filter(Boolean);

/** The desktops named in $XDG_CURRENT_DESKTOP ("KDE", "ubuntu:GNOME"). */
export function currentDesktops(): string[] {
  return (process.env.XDG_CURRENT_DESKTOP ?? '').split(':').map((s) => s.trim()).filter(Boolean);
}

/** OnlyShowIn / NotShowIn against the running desktop; with no desktop known, everything applies. */
export function appliesHere(e: DesktopEntry): boolean {
  const here = currentDesktops().map((d) => d.toLowerCase());
  if (here.length === 0) return true;
  const only = list(e.get('OnlyShowIn')).map((d) => d.toLowerCase());
  if (only.length && !only.some((d) => here.includes(d))) return false;
  const not = list(e.get('NotShowIn')).map((d) => d.toLowerCase());
  return !not.some((d) => here.includes(d));
}

/** Exec= without field codes (%f, %U …), as the user would read it. */
export function cleanExec(exec: string | undefined): string {
  return (exec ?? '').replace(/\s%[a-zA-Z]/g, '').replace(/%%/g, '%').trim();
}

/** First word of Exec=, unquoted, after any `env VAR=x` prefix. */
export function execProgram(exec: string | undefined): string {
  const words = (cleanExec(exec).match(/"[^"]*"|\S+/g) ?? []).map((w) => w.replace(/^"|"$/g, ''));
  let i = 0;
  if (words[i] === 'env' || words[i] === '/usr/bin/env') {
    i++;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  }
  return words[i] ?? '';
}

/** Data dirs per the XDG base-directory spec, user first. */
export function xdgDataDirs(): string[] {
  const home = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const sys = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter((p) => path.isAbsolute(p));
  return [...new Set([home, ...sys])];
}

export function xdgConfigHome(): string {
  const v = process.env.XDG_CONFIG_HOME;
  return v && path.isAbsolute(v) ? v : path.join(os.homedir(), '.config');
}

export function xdgConfigDirs(): string[] {
  return (process.env.XDG_CONFIG_DIRS || '/etc/xdg').split(':').filter((p) => path.isAbsolute(p));
}

const ICON_SIZES = ['256x256', '128x128', '96x96', '64x64', '512x512', '48x48', 'scalable'];
const iconCache = new Map<string, string | undefined>();

async function exists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * A PNG for a desktop entry's Icon= value: an absolute path as-is, otherwise a lookup in the
 * hicolor theme and pixmaps of every data dir. SVG-only icons yield nothing (nativeImage cannot draw them).
 */
export async function resolveIcon(icon: string | undefined, extraDataDirs: string[] = []): Promise<string | undefined> {
  if (!icon) return undefined;
  if (path.isAbsolute(icon)) return /\.png$/i.test(icon) && (await exists(icon)) ? icon : undefined;
  if (/[/\\]/.test(icon)) return undefined;
  const key = `${icon}\n${extraDataDirs.join(':')}`;
  if (iconCache.has(key)) return iconCache.get(key);
  let found: string | undefined;
  const dirs = [...extraDataDirs, ...xdgDataDirs()];
  search: for (const d of dirs) {
    for (const size of ICON_SIZES) {
      if (size === 'scalable') continue;
      const p = path.join(d, 'icons', 'hicolor', size, 'apps', `${icon}.png`);
      if (await exists(p)) {
        found = p;
        break search;
      }
    }
  }
  if (!found) {
    for (const d of dirs) {
      const p = path.join(d, 'pixmaps', `${icon}.png`);
      if (await exists(p)) {
        found = p;
        break;
      }
    }
  }
  iconCache.set(key, found);
  return found;
}
