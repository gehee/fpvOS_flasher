// A device with a bundle per unit (the P1 ground units): the parser names the
// unit from the bundle's device tree, and the catalog lists one image per unit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from '../transports/ascent.js';
import { parseP1GndBundle, P1_GND_UNITS } from '../devices/fpvos-p1-gnd.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
// a P1 ground bundle whose device tree names the board `compatible`
function bundle(compatible, release = '2026.11.alpha1') {
  const tree = Buffer.concat([Buffer.from('\xd0\x0d\xfe\xed', 'latin1'), Buffer.from(`${compatible}\0artosyn,proxima-9311\0`)]);
  const payloads = [Buffer.from('kernel'), tree, Buffer.from('root')];
  const h = Buffer.alloc(512);
  h.write('FPVOSUP1');
  [1, 1345406788, 512 + payloads.reduce((n, p) => n + p.length, 0), payloads.length].forEach((n, i) => h.writeUInt32LE(n, 8 + i * 4));
  h.write(release, 24);
  payloads.forEach((p, i) => {
    const o = 96 + 104 * i;
    h.write(['kernel.img', 'p1-gnd.dtb', 'rootfs.cpio.gz'][i], o);
    h.writeUInt32LE(p.length, o + 32); h.write(sha(p), o + 36);
  });
  h.writeUInt32LE(crc32(h), 508);
  return Buffer.concat([h, ...payloads]);
}

test('a P1 ground bundle names its unit from its device tree, a whole name', async () => {
  for (const u of P1_GND_UNITS) {
    const r = await parseP1GndBundle(bundle(u.compatible));
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.unit, { id: u.id, name: u.name }, u.compatible);
  }
  // the goggles' name starts the Pro's: each is its own
  assert.equal((await parseP1GndBundle(bundle('betafpv,p1-goggle-pro'))).unit.id, 'goggles-pro');
  assert.equal((await parseP1GndBundle(bundle('betafpv,p1-goggle'))).unit.id, 'goggles');
  // the recovery's tree, or one this page does not know: no unit claimed
  assert.equal((await parseP1GndBundle(bundle('betafpv,p1-gnd'))).unit, undefined);
  assert.equal((await parseP1GndBundle(bundle('betafpv,p1-goggle-x'))).unit, undefined);
});

test('the catalog lists one image per unit, each in its own folder; never two for one unit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-units-'));
  const tool = fileURLToPath(new URL('../tools/make-catalog.mjs', import.meta.url));
  const files = P1_GND_UNITS.map((u) => {
    const f = path.join(dir, `fpvos-p1-gnd-${u.id}-2026.11.alpha1.fwu`);
    fs.writeFileSync(f, bundle(u.compatible));
    return f;
  });
  const out = path.join(dir, 'firmware');
  const run = (...args) => execFileSync(process.execPath, [tool, '--release', '2026.11.alpha1', '--out', out, ...args], { stdio: 'pipe' });
  run('--every-board', ...files);
  const { releases } = JSON.parse(fs.readFileSync(path.join(out, 'catalog.json'), 'utf8'));
  assert.deepEqual(releases.map((r) => r.release), ['2026.11.alpha1']);
  assert.deepEqual(releases[0].images.map((i) => [i.devices, i.unit, i.unitName, i.file, i.name]),
    P1_GND_UNITS.map((u) => [['fpvos-p1-gnd'], u.id, u.name, `2026.11.alpha1/fpvos-p1-gnd/${u.id}/fpvos.fwu`, 'fpvos.fwu']));
  for (const [i, f] of files.entries()) {
    assert.ok(fs.readFileSync(path.join(out, releases[0].images[i].file)).equals(fs.readFileSync(f)));
  }
  // the same unit twice is a mistake, as two images for one device always were
  assert.throws(() => run('--every-board', files[0], files[0]), /a second image for fpvos-p1-gnd \(VR04 HD FPV Goggles\)/);
  // not proven on hardware: listed only where every board is (the preview and alpha pages)
  const proven = path.join(dir, 'proven');
  execFileSync(process.execPath, [tool, '--release', '2026.11.alpha1', '--out', proven, ...files], { stdio: 'pipe' });
  assert.ok(!fs.existsSync(path.join(proven, 'catalog.json')));
  fs.rmSync(dir, { recursive: true });
});
