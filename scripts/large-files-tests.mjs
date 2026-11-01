import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: ['electron/services/largeFiles.ts'],
  bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{
    name: 'fixture-drive-inventory',
    setup(builder) {
      builder.onResolve({ filter: /^\.\/disk$/ }, () => ({ path: 'disk', namespace: 'test' }));
      builder.onResolve({ filter: /^node:os$/ }, () => ({ path: 'os', namespace: 'test' }));
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, ({ path: module }) => ({
        contents: module === 'disk' ? `
          export const listDisks = async () => {
            if (globalThis.cleanlyFixture.inventoryGate) await globalThis.cleanlyFixture.inventoryGate;
            return globalThis.cleanlyFixture.disks;
          };
          export const dataDriveMounts = async () => globalThis.cleanlyFixture.disks.filter(d => !d.system).map(d => d.mount);
          export const sameMount = (a, b) => a.toLowerCase() === b.toLowerCase();
        ` : module === 'os' ? `
          export default { homedir: () => globalThis.cleanlyFixture.home, tmpdir: () => globalThis.cleanlyFixture.temp };
        ` : `export const app = { getPath() { throw new Error('No desktop access in scanner tests'); } };`,
        loader: 'js',
      }));
    },
  }],
});
const { scanLargeFiles } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const MB = 1024 * 1024;

async function fixture(t) {
  const temporaryDir = await fs.realpath(os.tmpdir());
  const base = await fs.mkdtemp(path.join(temporaryDir, 'cleanly-drives-'));
  const mounts = ['C', 'D', 'E'].map((drive) => path.join(base, drive));
  globalThis.cleanlyFixture = {
    home: path.join(mounts[0], 'Users', 'test'),
    temp: path.join(base, 'temp'),
    disks: mounts.map((mount, index) => ({ mount, label: `Disk ${index}`, system: index === 0, total: 0, free: 0, used: 0 })),
  };
  const previousLocal = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(globalThis.cleanlyFixture.home, 'AppData', 'Local');
  t.after(async () => {
    if (previousLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocal;
    delete globalThis.cleanlyFixture;
    assert.equal(path.dirname(base).toLowerCase(), temporaryDir.toLowerCase());
    assert.ok(path.basename(base).startsWith('cleanly-drives-'));
    await fs.rm(base, { recursive: true, force: true });
  });
  const write = async (file, size = MB) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const handle = await fs.open(file, 'w');
    await handle.truncate(size);
    await handle.close();
    return file;
  };
  const homeFile = await write(path.join(globalThis.cleanlyFixture.home, 'video.mp4'));
  const cFile = await write(path.join(mounts[0], 'Projects', 'archive.zip'));
  const dFile = await write(path.join(mounts[1], 'movie.mp4'), 2 * MB);
  const eFile = await write(path.join(mounts[2], 'disk.iso'), 3 * MB);
  return { base, mounts, homeFile, cFile, dFile, eFile, write };
}

test('a selected data drive returns only its own files', async (t) => {
  const f = await fixture(t);
  const files = await scanLargeFiles(MB, () => {}, f.mounts[1]);
  assert.deepEqual(files.map((file) => file.path), [f.dFile]);
});

test('the selected system drive includes home and other user folders once', async (t) => {
  const f = await fixture(t);
  const files = await scanLargeFiles(MB, () => {}, f.mounts[0]);
  assert.deepEqual(files.map((file) => file.path).sort(), [f.homeFile, f.cFile].sort());
});

test('all-drives mode preserves the original home and other-drives scan', async (t) => {
  const f = await fixture(t);
  const files = await scanLargeFiles(MB, () => {});
  assert.deepEqual(files.map((file) => file.path), [f.eFile, f.dFile, f.homeFile]);
});

test('unknown drives and arbitrary folder paths are rejected', async (t) => {
  const f = await fixture(t);
  for (const root of [path.join(f.base, 'missing'), globalThis.cleanlyFixture.home, '', null, 42, '\\\\server\\share']) {
    await assert.rejects(scanLargeFiles(MB, () => {}, root), /That drive is not available/);
  }
});

test('the selected drive has its own 300-file budget', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 301; i++) await f.write(path.join(f.mounts[2], `bigger-${i}.zip`), 4 * MB);
  const all = await scanLargeFiles(MB, () => {});
  assert.equal(all.length, 300);
  assert.equal(all.some((file) => file.path === f.dFile), false);
  const selected = await scanLargeFiles(MB, () => {}, f.mounts[1]);
  assert.deepEqual(selected.map((file) => file.path), [f.dFile]);
});

test('switching drives replaces the old scan', async (t) => {
  const f = await fixture(t);
  const previous = scanLargeFiles(MB, () => {}, f.mounts[1]);
  const next = scanLargeFiles(MB, () => {}, f.mounts[2]);
  await assert.rejects(previous, /newer search replaced/);
  assert.deepEqual((await next).map((file) => file.path), [f.eFile]);
});

test('a pending drive lookup cannot replace a newer all-drives scan', async (t) => {
  const f = await fixture(t);
  let release;
  globalThis.cleanlyFixture.inventoryGate = new Promise((resolve) => { release = resolve; });
  const previous = scanLargeFiles(MB, () => {}, f.mounts[1]);
  const next = scanLargeFiles(MB, () => {});
  const outcomes = Promise.allSettled([previous, next]);
  release();
  const [oldResult, newResult] = await outcomes;
  assert.equal(oldResult.status, 'rejected');
  assert.match(oldResult.reason.message, /newer search replaced/);
  assert.equal(newResult.status, 'fulfilled');
  assert.deepEqual(newResult.value.map((file) => file.path), [f.eFile, f.dFile, f.homeFile]);
});

test('a selected drive does not traverse another drive mounted inside it', async (t) => {
  const f = await fixture(t);
  const mounted = path.join(f.mounts[0], 'Projects', 'mounted-drive');
  await f.write(path.join(mounted, 'external.zip'), 10 * MB);
  globalThis.cleanlyFixture.disks.push({ mount: mounted, label: 'Mounted drive', system: false, total: 0, free: 0, used: 0 });
  const files = await scanLargeFiles(MB, () => {}, f.mounts[0]);
  assert.deepEqual(files.map((file) => file.path).sort(), [f.homeFile, f.cFile].sort());
});

test('drive scans keep system folders and fresh temp folders out of results', async (t) => {
  const f = await fixture(t);
  await f.write(path.join(f.mounts[0], 'Windows', 'system.bin'), 10 * MB);
  await f.write(path.join(process.env.LOCALAPPDATA, 'Temp', 'active.tmp'), 10 * MB);
  const files = await scanLargeFiles(MB, () => {}, f.mounts[0]);
  assert.deepEqual(files.map((file) => file.path).sort(), [f.homeFile, f.cFile].sort());
});
