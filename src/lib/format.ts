const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** 1536 -> { value: '1.5', unit: 'KB' } */
export function splitBytes(bytes: number): { value: string; unit: string } {
  if (!Number.isFinite(bytes) || bytes <= 0) return { value: '0', unit: 'GB' };
  let i = 0;
  let n = bytes;
  while (n >= 1000 && i < UNITS.length - 1) {
    n /= 1024;
    i++;
  }
  const value = n >= 100 || i === 0 ? Math.round(n).toString() : n.toFixed(1);
  return { value, unit: UNITS[i] };
}

export function formatBytes(bytes: number): string {
  const { value, unit } = splitBytes(bytes);
  return `${value} ${unit}`;
}

export function timeAgo(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return 'never';
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return 'just now';
  const steps: [number, string][] = [
    [60, 'minute'],
    [60, 'hour'],
    [24, 'day'],
    [30, 'month'],
    [12, 'year'],
  ];
  let v = s / 60;
  let label = 'minute';
  for (let i = 1; i < steps.length && v >= steps[i][0]; i++) {
    v /= steps[i][0];
    label = steps[i][1];
  }
  const n = Math.floor(v);
  return `${n} ${label}${n === 1 ? '' : 's'} ago`;
}

export function formatDate(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Replace the home directory with ~ and keep long paths readable. */
export function shortPath(p: string, home?: string): string {
  let out = p;
  if (home && out.toLowerCase().startsWith(home.toLowerCase())) out = '~' + out.slice(home.length);
  return out.replace(/\\/g, '/');
}

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
