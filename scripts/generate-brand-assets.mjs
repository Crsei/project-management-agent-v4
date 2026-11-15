import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Prerequisites: Node 24.21.0 and the frozen workspace install, including Astro's
// locked Sharp 0.34.5/native libvips. No ImageMagick, fonts, iconutil or downloads.
// Run from any directory: node scripts/generate-brand-assets.mjs [--check].
// --check renders in memory and compares every output without writing files.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check"))
  throw new Error("Usage: node scripts/generate-brand-assets.mjs [--check]");
const check = args[0] === "--check";
const provenance = JSON.parse(await readFile(join(root, "apps/desktop/assets/brand-source.json"), "utf8"));
const master = await readFile(join(root, provenance.master), "utf8");
if (createHash("sha256").update(master).digest("hex") !== provenance.masterSha256)
  throw new Error("Approved brand master differs from its provenance record; review the artwork before changing the recorded digest.");
const marketingRequire = createRequire(join(root, "apps/marketing/package.json"));
const astroRequire = createRequire(marketingRequire.resolve("astro"));
let sharp;
try {
  sharp = astroRequire("sharp");
} catch (cause) {
  throw new Error("Brand export requires the existing frozen marketing/Astro install and Sharp native libraries for this platform. No dependencies are installed by this command.", { cause });
}
if (sharp.versions.sharp !== provenance.toolchain.sharp)
  throw new Error(`Brand export requires locked Sharp ${provenance.toolchain.sharp}; found ${sharp.versions.sharp}.`);
sharp.concurrency(1);

function section(name) {
  const opening = name === "defs" ? "<defs>" : `<g id="${name}">`;
  const start = master.indexOf(opening);
  const closing = name === "defs" ? "</defs>" : "</g>";
  const end = master.indexOf(closing, start);
  if (start < 0 || end < 0) throw new Error(`Approved master is missing ${name}.`);
  return master.slice(start, end + closing.length);
}
const definitions = section("defs");
const mark = section("mark");
function svg(body, title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" fill="none" role="img" aria-labelledby="brand-title">\n  <title id="brand-title">${title}</title>\n  ${body}\n</svg>\n`;
}
const transparent = svg(`${definitions}\n  ${mark}`, "Dovspace transparent mark");
function monochrome(color) {
  // A true one-ink silhouette: the approved letter and wing share one opaque fill.
  const paths = mark
    .replace('fill="url(#dovspace-letter)"', `fill="${color}"`)
    .replace('fill="url(#dovspace-wing)"', `fill="${color}"`)
    .replace(/<path id="wing-edge"[^>]+\/>/, "");
  return svg(paths, "Dovspace monochrome mark");
}
const pngOptions = { compressionLevel: 9, adaptiveFiltering: false, palette: false, effort: 10 };
const images = new Map();
async function icon(size) {
  if (!images.has(size)) images.set(size, await sharp(Buffer.from(master), { density: 144 }).resize(size, size).png(pngOptions).toBuffer());
  return images.get(size);
}
async function ico(sizes) {
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  const chunks = [];
  let offset = header.length;
  for (const [index, size] of sizes.entries()) {
    const image = await icon(size);
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    chunks.push(image);
    offset += image.length;
  }
  return Buffer.concat([header, ...chunks]);
}
async function icns() {
  const chunks = [];
  for (const [type, size] of [["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024]]) {
    const image = await icon(size);
    const header = Buffer.alloc(8);
    header.write(type, 0, "ascii");
    header.writeUInt32BE(image.length + 8, 4);
    chunks.push(header, image);
  }
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}
async function bmp(width, height, size, left, top, background) {
  const pixels = await sharp({ create: { width, height, channels: 3, background } })
    .composite([{ input: await icon(size), left, top }]).removeAlpha().raw().toBuffer();
  const stride = Math.ceil(width * 3 / 4) * 4;
  const result = Buffer.alloc(54 + stride * height);
  result.write("BM", 0, "ascii");
  result.writeUInt32LE(result.length, 2);
  result.writeUInt32LE(54, 10);
  result.writeUInt32LE(40, 14);
  result.writeInt32LE(width, 18);
  result.writeInt32LE(height, 22); // Positive height: NSIS bottom-up RGB24.
  result.writeUInt16LE(1, 26);
  result.writeUInt16LE(24, 28);
  result.writeUInt32LE(stride * height, 34);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const input = (y * width + x) * 3;
      const output = 54 + (height - 1 - y) * stride + x * 3;
      result[output] = pixels[input + 2];
      result[output + 1] = pixels[input + 1];
      result[output + 2] = pixels[input];
    }
  }
  return result;
}

const outputs = new Map([
  ["apps/desktop/src/dovspace.svg", Buffer.from(master)],
  ["apps/marketing/public/dovspace.svg", Buffer.from(master)],
  ["apps/marketing/public/favicon.svg", Buffer.from(master)],
  ["apps/web/public/dovspace-mark.svg", Buffer.from(transparent)],
  ["apps/web/public/dovspace-monochrome.svg", Buffer.from(monochrome("currentColor"))],
  ["apps/web/public/dovspace-monochrome-light.svg", Buffer.from(monochrome("#FFFFFF"))],
  ["apps/web/public/dovspace-mark.png", await sharp(Buffer.from(transparent)).resize(1024, 1024).png(pngOptions).toBuffer()],
  ["apps/web/public/favicon.ico", await ico([16, 24, 32, 48, 64, 128, 256])],
  ["apps/desktop/build/icon.png", await icon(1024)],
  ["apps/desktop/build/icon.ico", await ico([16, 24, 32, 48, 64, 128, 256])],
  ["apps/desktop/build/icon.icns", await icns()],
  ["apps/desktop/build/installerHeader.bmp", await bmp(150, 57, 48, 98, 4, "#FFFFFF")],
  ["apps/desktop/build/installerSidebar.bmp", await bmp(164, 314, 140, 12, 54, "#0D111B")],
]);
const mismatches = [];
for (const [path, bytes] of outputs) {
  const previous = await readFile(join(root, path)).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (previous?.equals(bytes)) continue;
  if (check) mismatches.push(path);
  else await writeFile(join(root, path), bytes);
}
if (mismatches.length) throw new Error(`Brand assets are missing or stale:\n${mismatches.join("\n")}\nRun node scripts/generate-brand-assets.mjs.`);
console.log(`${check ? "Checked" : "Generated"} ${outputs.size} brand assets from ${provenance.master}; Sharp ${sharp.versions.sharp}, libvips ${sharp.versions.vips}.`);
