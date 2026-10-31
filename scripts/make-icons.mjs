// Renders build/icon.svg to build/icon.png (1024px) and build/icons/<size>x<size>.png for Linux.
// electron-builder derives .ico and .icns from icon.png; Linux packages install the icons/ set into
// the hicolor theme, which has no 1024px size, so desktops would otherwise show no icon.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const file = (p) => fileURLToPath(new URL(`../build/${p}`, import.meta.url));
const svg = await readFile(file('icon.svg'), 'utf8');
const render = (size) =>
  new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0, 0, 0, 0)' }).render().asPng();

const png = render(1024);
await writeFile(file('icon.png'), png);
console.log(`icon: ${file('icon.png')} (${png.length} bytes)`);

await mkdir(file('icons'), { recursive: true });
for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
  await writeFile(file(`icons/${size}x${size}.png`), render(size));
}
console.log(`icons: ${file('icons')} (16-512px)`);
