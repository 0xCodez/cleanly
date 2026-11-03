import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({
  stdin: {
    contents: `export { deleteCacheEntry, isSafeUserPath } from './electron/services/trash.ts';
      export { cleanJunk } from './electron/services/junk.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  plugins: [{
    name: 'no-desktop-side-effects',
    setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
        contents: `export const app = { getPath() { throw new Error('Not running in Electron'); } };
          export const shell = { trashItem() { throw new Error('Real Recycle Bin access is forbidden in tests'); } };`,
        loader: 'js',
      }));
    },
  }],
});
const { deleteCacheEntry, isSafeUserPath, cleanJunk } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`
);

async function fixture(t) {
  const temporaryDir = await fs.realpath(os.tmpdir());
  const base = await fs.mkdtemp(path.join(temporaryDir, 'cleanly-security-'));
  t.after(async () => {
    const resolved = path.resolve(base);
    assert.equal(path.dirname(resolved).toLowerCase(), temporaryDir.toLowerCase());
    assert.ok(path.basename(resolved).startsWith('cleanly-security-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return base;
}

test('ordinary cache entries are removed inside their root', async (t) => {
  const base = await fixture(t);
  const root = path.join(base, 'cache');
  const entry = path.join(root, 'entry');
  await fs.mkdir(entry, { recursive: true });
  await fs.writeFile(path.join(entry, 'data'), 'cache');
  const result = await deleteCacheEntry(entry, root);
  assert.equal(result.removed, 1);
  assert.equal(result.freed, 5);
  await assert.rejects(fs.stat(entry), { code: 'ENOENT' });
});

test('a cache root reached through a parent junction cannot erase unrelated files', async (t) => {
  const base = await fixture(t);
  const personal = path.join(base, 'personal');
  const alias = path.join(base, 'vendor');
  const realCache = path.join(personal, 'profile', 'Cache');
  await fs.mkdir(realCache, { recursive: true });
  await fs.writeFile(path.join(realCache, 'keep.txt'), 'personal data');
  await fs.symlink(personal, alias, 'junction');
  const root = path.join(alias, 'profile', 'Cache');
  const result = await deleteCacheEntry(path.join(root, 'keep.txt'), root);
  assert.equal(result.refused, true);
  assert.equal(await fs.readFile(path.join(realCache, 'keep.txt'), 'utf8'), 'personal data');
});

test('App caches cleanup preserves data reached through a redirected app folder', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const base = await fixture(t);
  const previous = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.APPDATA = path.join(base, 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = path.join(base, 'AppData', 'Local');
  const personal = path.join(base, 'Documents', 'project');
  const protectedFile = path.join(personal, 'Cache', 'keep.txt');
  await fs.mkdir(path.dirname(protectedFile), { recursive: true });
  await fs.mkdir(process.env.APPDATA, { recursive: true });
  await fs.mkdir(process.env.LOCALAPPDATA, { recursive: true });
  await fs.writeFile(protectedFile, 'personal data');
  await fs.symlink(personal, path.join(process.env.APPDATA, 'discord'), 'junction');

  const result = await cleanJunk(['app-cache'], () => {});

  assert.equal(await fs.readFile(protectedFile, 'utf8'), 'personal data');
  assert.equal(result.removed, 0);
  assert.equal(result.freed, 0);
  assert.ok(result.skipped.some((message) => message.includes('skipped for safety')));
});

test('a junction inside a cache is skipped while ordinary cache files are removed', async (t) => {
  const base = await fixture(t);
  const personal = path.join(base, 'personal');
  const root = path.join(base, 'cache');
  const entry = path.join(root, 'entry');
  await fs.mkdir(personal);
  await fs.mkdir(entry, { recursive: true });
  await fs.writeFile(path.join(personal, 'keep.txt'), 'personal data');
  await fs.writeFile(path.join(entry, 'data'), 'cache');
  await fs.symlink(personal, path.join(entry, 'linked'), 'junction');
  const result = await deleteCacheEntry(entry, root);
  assert.equal(result.removed, 1);
  assert.equal(await fs.readFile(path.join(personal, 'keep.txt'), 'utf8'), 'personal data');
  assert.equal((await fs.lstat(path.join(entry, 'linked'))).isSymbolicLink(), true);
});

test('direct junction targets are refused', async (t) => {
  const base = await fixture(t);
  const root = path.join(base, 'cache');
  const personal = path.join(base, 'personal');
  await fs.mkdir(root);
  await fs.mkdir(personal);
  await fs.writeFile(path.join(personal, 'keep.txt'), 'personal data');
  const target = path.join(root, 'linked');
  await fs.symlink(personal, target, 'junction');
  assert.equal((await deleteCacheEntry(target, root)).refused, true);
  assert.equal(await fs.readFile(path.join(personal, 'keep.txt'), 'utf8'), 'personal data');
});

test('fresh temporary files and the cache root itself are preserved', async (t) => {
  const base = await fixture(t);
  const root = path.join(base, 'cache');
  await fs.mkdir(root);
  const target = path.join(root, 'fresh.txt');
  await fs.writeFile(target, 'still in use');
  assert.equal((await deleteCacheEntry(target, root, { modifiedBefore: Date.now() - 86_400_000 })).removed, 0);
  assert.equal(await fs.readFile(target, 'utf8'), 'still in use');
  assert.equal((await deleteCacheEntry(root, root)).refused, true);
});

test('user-file guard blocks roots, protected folders, keys, and malformed input', () => {
  const home = os.homedir();
  for (const target of [home, path.parse(home).root, path.join(home, 'Documents'),
    path.join(home, '.ssh', 'id_ed25519'), 'relative.txt', '', null]) {
    assert.equal(isSafeUserPath(target), false, String(target));
  }
  assert.equal(isSafeUserPath(path.join(home, 'Downloads', 'old-installer.exe')), true);
});
