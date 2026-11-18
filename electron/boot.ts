// Imported first by main.ts so it runs before any fs call: scans are bound by libuv's threadpool (4 threads by default).
process.env.UV_THREADPOOL_SIZE ??= '16';

// Optional startup profiling. Enable with CLEANLY_PERF=1 to log timestamps (ms since process start)
// to stderr. Disabled by default; a no-op for normal users.
const PERF = process.env.CLEANLY_PERF === '1';
const T0 = Date.now();
export const perfMark = (label: string) => {
  if (PERF) process.stderr.write(`[cleanly-perf] ${label}: ${Date.now() - T0}ms\n`);
};

export {};
