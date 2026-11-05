// Renders build/icon.svg to build/icon.png (1024px) and build/icon.ico (Windows).
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const svgPath = fileURLToPath(new URL('../build/icon.svg', import.meta.url));
const pngPath = fileURLToPath(new URL('../build/icon.png', import.meta.url));
const icoPath = fileURLToPath(new URL('../build/icon.ico', import.meta.url));

const svg = await readFile(svgPath, 'utf8');

function render(size) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0, 0, 0, 0)',
  });
  const rendered = resvg.render();
  return {
    width: size,
    height: size,
    pixels: Buffer.from(rendered.pixels),
    png: Buffer.from(rendered.asPng()),
  };
}

const hiRes = render(1024);
await writeFile(pngPath, hiRes.png);
console.log(`icon: ${pngPath} (${hiRes.png.length} bytes)`);

function makeDIB(w, h, pixels) {
  const header = Buffer.alloc(40);
  const rowBytes = Math.ceil(w / 32) * 4;
  const andMaskSize = rowBytes * h;
  const xorSize = w * h * 4;

  header.writeUInt32LE(40, 0);
  header.writeInt32LE(w, 4);
  header.writeInt32LE(h * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(xorSize + andMaskSize, 20);

  const xor = Buffer.alloc(xorSize);
  for (let y = 0; y < h; y++) {
    const srcRow = y;
    const dstRow = h - 1 - y;
    for (let x = 0; x < w; x++) {
      const s = (srcRow * w + x) * 4;
      const d = (dstRow * w + x) * 4;
      xor[d] = pixels[s + 2];
      xor[d + 1] = pixels[s + 1];
      xor[d + 2] = pixels[s];
      xor[d + 3] = pixels[s + 3];
    }
  }

  const andMask = Buffer.alloc(andMaskSize, 0);
  return Buffer.concat([header, xor, andMask]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = [];

for (const s of sizes) {
  const img = render(s);
  const data = s <= 128 ? makeDIB(s, s, img.pixels) : img.png;
  images.push({ width: s, height: s, data });
}

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);

let offset = 6 + images.length * 16;
const entries = [];
const bodies = [];

for (const img of images) {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(img.width >= 256 ? 0 : img.width, 0);
  entry.writeUInt8(img.height >= 256 ? 0 : img.height, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(img.data.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  bodies.push(img.data);
  offset += img.data.length;
}

const ico = Buffer.concat([header, ...entries, ...bodies]);
await writeFile(icoPath, ico);
console.log(`icon: ${icoPath} (${ico.length} bytes)`);
