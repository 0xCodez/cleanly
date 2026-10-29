import { useEffect, useState } from 'react';
import { api } from '../api';

// Icons never change while the app runs, so one cache serves every screen.
// null = asked (or loading) and nothing came back.
const cache = new Map<string, string | null>();
const listeners = new Set<() => void>();
const BATCH = 60;

const notify = () => listeners.forEach((fn) => fn());

async function load(wanted: string[]) {
  for (let i = 0; i < wanted.length; i += BATCH) {
    const chunk = wanted.slice(i, i + BATCH);
    try {
      const got = await api.fileIcons(chunk);
      for (const p of chunk) cache.set(p, typeof got?.[p] === 'string' ? got[p] : null);
    } catch {
      // a failed batch may be retried by a later mount
      for (const p of chunk) cache.delete(p);
    }
    notify();
  }
}

/**
 * Real system icons (PNG data URLs) for the given file, folder or app paths.
 * Returns what is known so far; missing entries mean "use the fallback glyph".
 */
export function useFileIcons(paths: (string | undefined | null)[]): Record<string, string> {
  const key = paths.filter(Boolean).join('\n');
  const [, setTick] = useState(0);

  useEffect(() => {
    const fn = () => setTick((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  useEffect(() => {
    const wanted = [...new Set(paths.filter((p): p is string => !!p))].filter((p) => !cache.has(p));
    if (!wanted.length) return;
    wanted.forEach((p) => cache.set(p, null));
    void load(wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const out: Record<string, string> = {};
  for (const p of paths) {
    const v = p ? cache.get(p) : null;
    if (p && v) out[p] = v;
  }
  return out;
}
