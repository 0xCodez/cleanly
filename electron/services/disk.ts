import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DiskInfo } from '../../shared/types';

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
/** Full System32 paths: a bare name would also be looked up in the current folder. */
const sys32 = (...p: string[]) => path.join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', ...p);

interface Volume {
  mount: string;
  label: string;
  system: boolean;
  /** sizes reported by the OS inventory, used when statfs fails */
  total?: number;
  free?: number;
}

function run(file: string, args: string[], timeout = 15000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout ?? ''));
    });
  });
}

/** "C:\\" for the drive Windows runs from (falls back to the home folder's drive). */
function windowsSystemMount(): string {
  const env = (process.env.SystemDrive ?? '').trim();
  if (/^[a-zA-Z]:$/.test(env)) return `${env.toUpperCase()}\\`;
  const root = path.parse(os.homedir()).root;
  return /^[a-zA-Z]:\\$/.test(root) ? root.toUpperCase() : 'C:\\';
}

export function systemMount(): string {
  return isWin ? windowsSystemMount() : '/';
}

/** Mounts compare case-insensitively on Windows ("d:\\" is "D:\\"), exactly elsewhere. */
export function sameMount(a: string, b: string): boolean {
  return isWin ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function sizes(mount: string, statPath = mount): Promise<{ total: number; free: number } | null> {
  try {
    const s = await fsp.statfs(statPath);
    return { total: Number(s.blocks) * Number(s.bsize), free: Number(s.bavail) * Number(s.bsize) };
  } catch {
    return null;
  }
}

const GENERIC_NAMES = /^(new volume|local disk|новый том|локальный диск|windows|os)$/i;

function windowsLabel(letter: string, volumeName: string): string {
  const name = volumeName.trim();
  if (!name || GENERIC_NAMES.test(name)) return `Disk ${letter}:`;
  return `${name} (${letter}:)`;
}

interface WinRow {
  DeviceID?: unknown;
  Size?: unknown;
  FreeSpace?: unknown;
  VolumeName?: unknown;
}

const WIN_SCRIPT =
  "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
  "@(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,Size,FreeSpace,VolumeName) | ConvertTo-Json -Compress";

async function windowsVolumes(): Promise<Volume[]> {
  const sys = windowsSystemMount();
  const out = await run(sys32('WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_SCRIPT]);
  let rows: WinRow[] | null = null;
  if (out !== null) {
    try {
      const parsed = JSON.parse(out.trim() || '[]') as unknown;
      rows = (Array.isArray(parsed) ? parsed : [parsed]).filter((r): r is WinRow => !!r && typeof r === 'object');
    } catch {
      rows = null;
    }
  }

  const vols: Volume[] = [];
  if (rows) {
    for (const r of rows) {
      const id = typeof r.DeviceID === 'string' ? r.DeviceID.trim() : '';
      if (!/^[a-zA-Z]:$/.test(id)) continue;
      const letter = id.charAt(0).toUpperCase();
      const mount = `${letter}:\\`;
      const total = Number(r.Size);
      const free = Number(r.FreeSpace);
      vols.push({
        mount,
        label: windowsLabel(letter, typeof r.VolumeName === 'string' ? r.VolumeName : ''),
        system: sameMount(mount, sys),
        total: Number.isFinite(total) ? total : undefined,
        free: Number.isFinite(free) ? free : undefined,
      });
    }
  } else {
    // No PowerShell / WMI: probe every letter and keep the ones Windows calls fixed drives.
    for (let c = 67; c <= 90; c++) {
      const letter = String.fromCharCode(c);
      const mount = `${letter}:\\`;
      if (!(await sizes(mount))) continue;
      const type = await run(sys32('fsutil.exe'), ['fsinfo', 'drivetype', `${letter}:`], 5000);
      const fixed = type !== null ? /fixed/i.test(type) : sameMount(mount, sys);
      if (fixed) vols.push({ mount, label: `Disk ${letter}:`, system: sameMount(mount, sys) });
    }
  }

  // A SUBST drive is a folder in disguise: its real path is not the drive root.
  const real: Volume[] = [];
  for (const v of vols) {
    try {
      if (!sameMount(await fsp.realpath(v.mount), v.mount)) continue;
    } catch {
      // locked or unreadable volume; sizes decide below
    }
    real.push(v);
  }
  if (!real.some((v) => v.system)) real.push({ mount: sys, label: `Disk ${sys.charAt(0)}:`, system: true });
  return real;
}

const present = (p: string) => fsp.lstat(p).then(() => true, () => false);

const SKIP_FS =/^(smbfs|nfs|afpfs|webdav|cifs|ftp|autofs|devfs|fdesc|nullfs|osxfuse|macfuse|lifs)$/i;

async function macVolumes(): Promise<Volume[]> {
  const vols: Volume[] = [{ mount: '/', label: 'Macintosh HD', system: true }];
  const mounts = await run('/sbin/mount', [], 5000);
  if (mounts === null) return vols;

  const images = new Set<string>();
  const hd = await run('/usr/bin/hdiutil', ['info'], 5000);
  if (hd) {
    for (const line of hd.split('\n')) {
      const m = /\t(\/Volumes\/[^\t]+)\s*$/.exec(line);
      if (m) images.add(m[1]);
    }
  }

  for (const line of mounts.split('\n')) {
    const m = /^(.+?) on (\/Volumes\/[^/]+) \(([^)]*)\)$/.exec(line.trim());
    if (!m) continue;
    const [, device, mount, optText] = m;
    const opts = optText.split(',').map((o) => o.trim().toLowerCase());
    const fsType = opts[0] ?? '';
    const name = path.basename(mount);
    if (!device.startsWith('/dev/') || SKIP_FS.test(fsType)) continue;
    if (!opts.includes('local') || opts.includes('read-only') || opts.includes('nobrowse') || opts.includes('quarantine')) continue;
    if (images.has(mount) || name.startsWith('.') || /time machine|backups? of |com\.apple\.timemachine/i.test(name)) continue;
    try {
      const st = await fsp.lstat(mount);
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
    } catch {
      continue;
    }
    if (await present(path.join(mount, 'Backups.backupdb'))) continue;
    vols.push({ mount, label: name, system: false });
  }
  return vols;
}

/* ---------- Linux ---------- */

export interface MountEntry {
  mount: string;
  /** "/dev/nvme0n1p3", "tmpfs", "portal" … */
  source: string;
  fsType: string;
  readOnly: boolean;
}

const unescapeMount = (s: string) => s.replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)));

/** Every mount of this process's namespace, from /proc/self/mountinfo (Linux only). */
export async function mountTable(): Promise<MountEntry[]> {
  if (isWin || isMac) return [];
  let text: string;
  try {
    text = await fsp.readFile('/proc/self/mountinfo', 'utf8');
  } catch {
    return [];
  }
  const out: MountEntry[] = [];
  for (const line of text.split('\n')) {
    const sep = line.indexOf(' - ');
    if (sep < 0) continue;
    const pre = line.slice(0, sep).split(' ');
    const post = line.slice(sep + 3).split(' ');
    if (pre.length < 6 || post.length < 2) continue;
    out.push({
      mount: unescapeMount(pre[4]),
      source: unescapeMount(post[1]),
      fsType: post[0],
      readOnly: pre[5].split(',').includes('ro'),
    });
  }
  return out;
}

/** The mount holding `p`: the longest mount point that is `p` or above it. */
export function mountFor(p: string, table: MountEntry[]): MountEntry | undefined {
  let best: MountEntry | undefined;
  for (const m of table) {
    const above = m.mount === '/' || p === m.mount || p.startsWith(`${m.mount}/`);
    if (above && (!best || m.mount.length >= best.mount.length)) best = m;
  }
  return best;
}

/**
 * Mount points strictly below `root` that hold a different file system than `root` itself:
 * /proc, tmpfs, network shares, other disks. Btrfs subvolumes of the same device count as the same file system.
 */
export async function foreignMounts(root: string): Promise<Set<string>> {
  const table = await mountTable();
  const own = mountFor(root, table)?.source;
  const out = new Set<string>();
  const prefix = root.endsWith('/') ? root : `${root}/`;
  for (const m of table) if (m.mount.startsWith(prefix) && m.source !== own) out.add(m.mount);
  return out;
}

const LINUX_DISK_FS = /^(ext[234]|xfs|btrfs|f2fs|bcachefs|zfs|jfs|reiserfs|ntfs3?|fuseblk|exfat|vfat|hfsplus)$/;
/** Where the OS keeps its own pieces: never offered as a drive. */
const LINUX_SYSTEM_MOUNT = /^\/(boot|efi|proc|sys|dev|tmp|var|usr|opt|snap|nix|gnu|etc|root|srv|run(?!\/media\/))(\/|$)/;

async function osName(): Promise<string> {
  try {
    const text = await fsp.readFile('/etc/os-release', 'utf8');
    const m = /^NAME=(?:"([^"]*)"|(.*))$/m.exec(text);
    // "Fedora Linux" -> "Fedora", "Debian GNU/Linux" -> "Debian": short enough for the sidebar
    const name = (m?.[1] ?? m?.[2] ?? '').trim().replace(/\s+(GNU\/)?Linux$/i, '');
    if (name) return name;
  } catch {
    // no os-release
  }
  return 'System';
}

async function diskLabels(): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const dir = '/dev/disk/by-label';
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return labels;
  }
  for (const n of names) {
    try {
      const dev = await fsp.realpath(path.join(dir, n));
      labels.set(dev, n.replace(/\\x([0-9a-f]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))));
    } catch {
      // stale link
    }
  }
  return labels;
}

async function linuxVolumes(): Promise<Volume[]> {
  const [table, labels, rootName] = await Promise.all([mountTable(), diskLabels(), osName()]);
  const bySource = new Map<string, MountEntry>();
  for (const m of table) {
    if (!m.source.startsWith('/dev/') || m.source.startsWith('/dev/loop') || !LINUX_DISK_FS.test(m.fsType)) continue;
    if (m.readOnly || (m.mount !== '/' && LINUX_SYSTEM_MOUNT.test(m.mount))) continue;
    // One entry per device: btrfs mounts the same disk at /, /home …; the shortest mount point represents it.
    const prev = bySource.get(m.source);
    if (!prev || m.mount.length < prev.mount.length) bySource.set(m.source, m);
  }
  const vols: Volume[] = [{ mount: '/', label: rootName, system: true }];
  for (const m of bySource.values()) {
    if (m.mount === '/') continue;
    let real = m.source;
    try {
      real = await fsp.realpath(m.source);
    } catch {
      // keep the name from the table
    }
    const label = labels.get(real) ?? (m.mount === '/home' ? 'Home' : path.basename(m.mount) || m.mount);
    vols.push({ mount: m.mount, label, system: false });
  }
  return vols;
}

let inventory: { at: number; vols: Promise<Volume[]> } | null = null;
const INVENTORY_TTL = 30_000;

function volumes(): Promise<Volume[]> {
  const now = Date.now();
  if (inventory && now - inventory.at < INVENTORY_TTL) return inventory.vols;
  const probe = isWin ? windowsVolumes() : isMac ? macVolumes() : linuxVolumes();
  const vols = probe.catch((): Volume[] => {
    // do not cache a failure
    if (inventory?.vols === vols) inventory = null;
    const mount = systemMount();
    return [{ mount, label: isWin ? `Disk ${mount.charAt(0)}:` : isMac ? 'Macintosh HD' : '/', system: true }];
  });
  inventory = { at: now, vols };
  return vols;
}

async function measure(v: Volume): Promise<DiskInfo | null> {
  // On macOS the home folder lives on the Data volume, which shares the APFS container with "/".
  const s = await sizes(v.mount, isMac && v.system ? os.homedir() : v.mount);
  const total = s?.total ?? v.total ?? 0;
  const free = s?.free ?? v.free ?? 0;
  if (!(total > 0)) return null;
  return { mount: v.mount, label: v.label, total, free, used: Math.max(0, total - free), system: v.system };
}

/** Every fixed local drive (C:, D: … or Macintosh HD plus local volumes), system drive first. */
export async function listDisks(): Promise<DiskInfo[]> {
  const vols = await volumes();
  const seen = new Set<string>();
  const out: DiskInfo[] = [];
  for (const v of vols) {
    const key = isWin ? v.mount.toLowerCase() : v.mount;
    if (seen.has(key)) continue;
    seen.add(key);
    const d = await measure(v);
    if (d) out.push(d);
  }
  return out.sort((a, b) => Number(b.system) - Number(a.system) || a.mount.localeCompare(b.mount, 'en', { sensitivity: 'base' }));
}

/** Mounts of fixed drives other than the system one (and other than the one home lives on). */
export async function dataDriveMounts(): Promise<string[]> {
  const home = os.homedir();
  const homeRoot = path.parse(home).root;
  return (await listDisks())
    // a separate /home partition is not a data drive: the home folder is scanned on its own
    .filter((d) => !d.system && !(isWin && sameMount(d.mount, homeRoot)) && d.mount !== '/' && !(!isWin && (home === d.mount || home.startsWith(`${d.mount}/`))))
    .map((d) => d.mount);
}

/** The system drive. */
export async function getDisk(): Promise<DiskInfo> {
  const mount = systemMount();
  // macOS: the home folder lives on the Data volume; elsewhere "/" itself (a separate /home is its own disk)
  const s = await fsp.statfs(isMac ? os.homedir() : mount);
  const total = Number(s.blocks) * Number(s.bsize);
  const free = Number(s.bavail) * Number(s.bsize);
  let label = mount;
  if (isWin) {
    const known = (await volumes().catch((): Volume[] => [])).find((v) => sameMount(v.mount, mount));
    label = known?.label ?? `Disk ${mount.charAt(0)}:`;
  } else if (isMac) label = 'Macintosh HD';
  else label = (await volumes().catch((): Volume[] => [])).find((v) => v.system)?.label ?? mount;
  return { mount, label, total, free, used: Math.max(0, total - free), system: true };
}
