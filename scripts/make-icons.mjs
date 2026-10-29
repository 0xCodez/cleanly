// Renders build/icon.svg to build/icon.png (1024px). electron-builder derives .ico and .icns from the PNG.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const svgPath = fileURLToPath(new URL('../build/icon.svg', import.meta.url));
const pngPath = fileURLToPath(new URL('../build/icon.png', import.meta.url));

const svg = await readFile(svgPath, 'utf8');
const png = new Resvg(svg, {
  fitTo: { mode: 'width', value: 1024 },
  background: 'rgba(0, 0, 0, 0)',
}).render().asPng();

await writeFile(pngPath, png);
console.log(`icon: ${pngPath} (${png.length} bytes)`);
