import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DiskInfo } from '../../shared/types';

export async function getDisk(): Promise<DiskInfo> {
  const home = os.homedir();
  const isWin = process.platform === 'win32';
  const mount = isWin ? path.parse(home).root || 'C:\\' : '/';
  // On macOS the home folder lives on the Data volume, which shares the APFS container with "/".
  const s = await fsp.statfs(isWin ? mount : home);
  const total = Number(s.blocks) * Number(s.bsize);
  const free = Number(s.bavail) * Number(s.bsize);
  let label = mount;
  if (isWin) label = `Disk ${mount.charAt(0).toUpperCase()}:`;
  else if (process.platform === 'darwin') label = 'Macintosh HD';
  return { mount, label, total, free, used: Math.max(0, total - free) };
}
