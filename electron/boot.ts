// Imported first by main.ts so it runs before any fs call: scans are bound by libuv's threadpool (4 threads by default).
process.env.UV_THREADPOOL_SIZE ??= '16';

export {};
