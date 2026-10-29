// Bundles the Electron main process (ESM) and preload script (CJS, required for sandboxed preloads).
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  external: ['electron'],
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
};

const configs = [
  {
    ...common,
    entryPoints: ['electron/main.ts'],
    outfile: 'dist-electron/main.js',
    format: 'esm',
    // some bundled CJS dependencies call require(); give ESM output a real one
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  },
  { ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs', format: 'cjs' },
];

if (watch) {
  for (const c of configs) (await esbuild.context(c)).watch();
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
