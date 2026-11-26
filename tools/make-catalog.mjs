#!/usr/bin/env node
// Publishes one release's images for the page's firmware choice: checks each
// one as the page does, copies it to OUT/<release>/<name it is sent as>, and
// adds the release to OUT/catalog.json after those already there (call it
// newest release first). The page reads firmware/catalog.json next to index.html.
//   node tools/make-catalog.mjs --release 2026.10.beta5 [--out firmware] [--every-board] IMAGE...
// The Pages deploy runs it on every fpvOS release's files: a browser cannot
// download them from the release page itself (no CORS on GitHub's asset host).
// The newest release is the page's one-click Install, so only the devices
// whose install is proven on hardware are listed (PROVEN); the rest stay a
// chosen file or a test build. A stock-to-fpvOS VRX bundle would be offered to
// stock VRXs too (the page uploads the RAM updater first, as for a chosen
// file) once both are listed. Each device's image goes in a folder of its own:
// every .fwu is sent as fpvos.fwu. A device with a bundle per unit (the P1
// ground units: the parser names the unit, parsed.unit) gets one image per
// unit, each in its own folder and listed with the unit's id and name.
import fs from 'node:fs';
import path from 'node:path';
import { prepareFirmware } from '../flasher.js';

// The Lite's: the fpvOS beta3 air image and stock upgrades flashed on real
// units (README). Not yet: the VRX's AR9311 recovery install and the
// stock-to-fpvOS bootstrap (not power-loss atomic, no backup), the P1's.
const PROVEN = new Set(['ascent-air']);
// --every-board: every device this page has an image for, proven or not - the
// preview page's release candidate (tools/preview-firmware.json), there to
// be validated on hardware before it is released.

const args = process.argv.slice(2);
const everyBoard = args.includes('--every-board');
if (everyBoard) args.splice(args.indexOf('--every-board'), 1);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const [, value] = args.splice(i, 2);
  return value;
};
const release = option('--release');
const out = option('--out', 'firmware');
if (!release || !/^[\w.+-]+$/.test(release) || !args.length) {
  console.error('usage: make-catalog.mjs --release VERSION [--out DIR] [--every-board] IMAGE...');
  process.exit(2);
}

const images = [];
for (const source of args) {
  const bytes = fs.readFileSync(source);
  const image = await prepareFirmware(new File([bytes], path.basename(source)));
  const { parsed } = image;
  if (!image.md5 || !parsed.profileId) {   // a release also carries images this page does not flash
    console.log(`${source}: skipped, ${parsed.errors.join(' ') || 'not a supported image'}`);
    continue;
  }
  const all = [parsed.profileId];
  if (parsed.profileId === 'fpvos-ar9311' && parsed.kind === 0) all.push('ascent-vrx');
  const devices = all.filter((d) => everyBoard || PROVEN.has(d));
  if (!devices.length) {
    console.log(`${source}: not listed, ${all.join(', ')} installs are not proven on hardware yet`);
    continue;
  }
  const unit = parsed.unit ?? null;
  if (images.some((i) => i.devices.some((d) => devices.includes(d)) && (!unit || !i.unit || i.unit === unit.id))) {
    throw new Error(`${source}: a second image for ${devices.join(', ')}${unit ? ` (${unit.name})` : ''}`);
  }
  const name = parsed.remoteName ?? path.basename(source);
  const folder = unit ? `${release}/${parsed.profileId}/${unit.id}` : `${release}/${parsed.profileId}`;
  const file = `${folder}/${name}`;
  fs.mkdirSync(path.join(out, folder), { recursive: true });
  fs.writeFileSync(path.join(out, file), bytes);
  images.push({ devices, ...(unit && { unit: unit.id, unitName: unit.name }), file, name, size: bytes.length, md5: image.md5 });
  console.log(`${file}: ${devices.join(', ')}${unit ? ` (${unit.name})` : ''}, ${bytes.length} bytes, md5 ${image.md5}`);
}
if (!images.length) {
  console.log(`${release}: no image this page can flash, not listed`);
  process.exit(0);
}
const list = path.join(out, 'catalog.json');
const catalog = fs.existsSync(list) ? JSON.parse(fs.readFileSync(list, 'utf8')) : { releases: [] };
catalog.releases = [...catalog.releases.filter((r) => r.release !== release), { release, images }];
fs.writeFileSync(list, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`${list}: ${catalog.releases.map((r) => r.release).join(', ')}`);
