import type { LargeFile } from '../../shared/types';

export const largeFileCache = new Map<string, LargeFile[]>();

export function cachedLargeFiles(): LargeFile[] {
  const files = new Map<string, LargeFile>();
  for (const results of largeFileCache.values()) for (const file of results) files.set(file.path, file);
  return [...files.values()].sort((a, b) => b.size - a.size).slice(0, 60);
}
