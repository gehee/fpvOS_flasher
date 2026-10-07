// node --test test/archive.test.mjs
// Archives are made by the real tools (xz, gzip, tar, Python's zipfile) when
// they are installed. VENDOR_ZIP=path/to/Ascent_V18.21.10.zip also opens the
// vendor's own download.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { openFirmware, ArchiveError } from '../archive.js';
import { unxz } from '../xz.js';
import { crc64 } from '../checksum.js';

const dir = mkdtempSync(path.join(tmpdir(), 'flasher-archive-'));
const has = (cmd) => { try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } };
const HAS_XZ = has('xz'), HAS_TAR = has('tar'), HAS_PY = has('python3');
const wanted = (n) => /^Ascent_H_Sky_\d+_\d+_\d+\.img$/i.test(n);
const md5 = (b) => createHash('md5').update(b).digest('hex');
const file = (p) => new File([readFileSync(p)], path.basename(p));
const open = (p) => openFirmware(file(p), { wanted });

// compressible but not trivial, like a firmware image
function imageBytes(n) {
  const b = Buffer.alloc(n);
  const r = randomBytes(n >> 3);
  for (let i = 0; i < n; i++) b[i] = i % 4096 < 3000 ? (i * 7) & 0xff : r[(i * 13) % r.length];
  return b;
}
const IMG = imageBytes(3 << 20);
writeFileSync(path.join(dir, 'Ascent_H_Sky_18_21_10.img'), IMG);

function xz(args, input) { return execFileSync('xz', ['-c', ...args], { input, maxBuffer: 1 << 30 }); }

test('crc64 check value', () => {
  // CRC-64/XZ of "123456789" is 0x995dc9bbdf1939fa; xz stores it little-endian
  assert.equal(Buffer.from(crc64(Buffer.from('123456789'))).toString('hex'), 'fa3919dfbbc95d99');
});

test('xz: presets, checks, blocks, filters props', { skip: !HAS_XZ && 'no xz' }, async () => {
  const inputs = [Buffer.alloc(0), Buffer.from('x'), randomBytes(200000), IMG];
  const variants = [['-0'], ['-6'], ['-9e', '--check=sha256'], ['--check=crc32'], ['--check=none'],
    ['-T2', '--block-size=300KiB'], ['--lzma2=preset=6,lc=0,lp=2,pb=0'], ['--lzma2=preset=1,lc=4,lp=0,pb=4']];
  for (const input of inputs) {
    for (const v of variants) {
      const out = await unxz(new Uint8Array(xz(v, input)));
      assert.ok(Buffer.from(out).equals(input), `${input.length} bytes with ${v.join(' ')}`);
    }
  }
});

test('xz: concatenated streams and stream padding', { skip: !HAS_XZ && 'no xz' }, async () => {
  const a = randomBytes(5000), b = IMG.subarray(0, 100000);
  const both = Buffer.concat([xz(['-1'], a), Buffer.alloc(8), xz(['-6'], b)]);
  assert.ok(Buffer.from(await unxz(new Uint8Array(both))).equals(Buffer.concat([a, b])));
  await assert.rejects(unxz(new Uint8Array(Buffer.concat([xz([], a), Buffer.alloc(3)]))), /padding/);
});

test('xz: damage is caught, other filters refused', { skip: !HAS_XZ && 'no xz' }, async () => {
  const good = xz(['-6'], IMG);
  for (const at of [200, good.length >> 1, good.length - 40]) {
    const bad = Buffer.from(good);
    bad[at] ^= 0x10;
    await assert.rejects(unxz(new Uint8Array(bad)), /xz: /, `flip at ${at}`);
  }
  await assert.rejects(unxz(new Uint8Array(good.subarray(0, good.length - 100))), /xz: /);
  await assert.rejects(unxz(new Uint8Array(xz(['--x86', '--lzma2'], IMG.subarray(0, 50000)))), /not supported/);
});

test('a bare image passes through', async () => {
  const r = await open(path.join(dir, 'Ascent_H_Sky_18_21_10.img'));
  assert.equal(r.name, 'Ascent_H_Sky_18_21_10.img');
  assert.deepEqual(r.trail, []);
  assert.equal(md5(r.bytes), md5(IMG));
});

test('.img.xz and .img.gz', { skip: !HAS_XZ && 'no xz' }, async () => {
  writeFileSync(path.join(dir, 'Ascent_H_Sky_18_21_10.img.xz'), xz(['-6'], IMG));
  writeFileSync(path.join(dir, 'Ascent_H_Sky_18_21_10.img.gz'), gzipSync(IMG));
  for (const ext of ['xz', 'gz']) {
    const r = await open(path.join(dir, `Ascent_H_Sky_18_21_10.img.${ext}`));
    assert.equal(r.name, 'Ascent_H_Sky_18_21_10.img');
    assert.deepEqual(r.trail, [`Ascent_H_Sky_18_21_10.img.${ext}`]);
    assert.equal(md5(r.bytes), md5(IMG));
  }
});

test('tar, .tar.gz and .tar.xz, with long names', { skip: !(HAS_TAR && HAS_XZ) && 'no tar or xz' }, async () => {
  const deep = path.join(dir, 'src', 'a'.repeat(60), 'b'.repeat(60));
  mkdirSync(deep, { recursive: true });
  writeFileSync(path.join(deep, 'Ascent_H_Sky_18_21_10.img'), IMG);
  writeFileSync(path.join(deep, 'notes.txt'), 'hello');
  for (const [fmt, out, z] of [['gnu', 'gnu.tar', []], ['posix', 'pax.tar.gz', ['-z']], ['ustar', 'ustar.tar.xz', ['-J']]]) {
    execFileSync('tar', ['-c', `--format=${fmt}`, ...z, '-f', path.join(dir, out), '-C', path.join(dir, 'src'), '.']);
    const r = await open(path.join(dir, out));
    assert.equal(r.name, 'Ascent_H_Sky_18_21_10.img', out);
    assert.equal(md5(r.bytes), md5(IMG), out);
  }
});

function pyZip(out, members, { compression = 'ZIP_DEFLATED', zip64 = false } = {}) {
  const script = `
import sys, zipfile
out, comp, z64 = sys.argv[1], getattr(zipfile, sys.argv[2]), sys.argv[3] == '1'
with zipfile.ZipFile(out, 'w', compression=comp) as z:
    for i in range(4, len(sys.argv), 2):
        with z.open(sys.argv[i], 'w', force_zip64=z64) as f:
            f.write(open(sys.argv[i + 1], 'rb').read())
`;
  execFileSync('python3', ['-c', script, out, compression, zip64 ? '1' : '0', ...members.flat()]);
}

test('zip: deflate, stored, zip64, picks the device image', { skip: !HAS_PY && 'no python3' }, async () => {
  const img = path.join(dir, 'Ascent_H_Sky_18_21_10.img');
  const other = path.join(dir, 'other.bin');
  writeFileSync(other, randomBytes(70000));
  const members = [
    ['Ascent_V18.21.10/A_先看我_Read me.jpg', other],
    ['Ascent_V18.21.10/Ascent_G_Gnd_18_21_10.img', other],
    ['Ascent_V18.21.10/Ascent_H_Sky_18_21_10.img', img],
    ['PCTool/tool.zip', other],
  ];
  for (const opts of [{}, { compression: 'ZIP_STORED' }, { zip64: true }]) {
    const out = path.join(dir, `vendor-${opts.compression ?? 'deflate'}-${opts.zip64 ? 64 : 32}.zip`);
    pyZip(out, members, opts);
    const r = await open(out);
    assert.equal(r.name, 'Ascent_H_Sky_18_21_10.img');
    assert.deepEqual(r.trail, [path.basename(out)]);
    assert.equal(md5(r.bytes), md5(IMG), JSON.stringify(opts));
  }
});

test('zip: nested .img.xz, several images, none, damage', { skip: !(HAS_PY && HAS_XZ) && 'no python3 or xz' }, async () => {
  const xzImg = path.join(dir, 'Ascent_H_Sky_18_21_10.img.xz');
  writeFileSync(xzImg, xz(['-6'], IMG));
  const nested = path.join(dir, 'nested.zip');
  pyZip(nested, [['fw/Ascent_H_Sky_18_21_10.img.xz', xzImg]]);
  const r = await open(nested);
  assert.deepEqual(r.trail, ['nested.zip', 'Ascent_H_Sky_18_21_10.img.xz']);
  assert.equal(md5(r.bytes), md5(IMG));

  const older = path.join(dir, 'older.img');
  writeFileSync(older, Buffer.from('old'));
  const several = path.join(dir, 'several.zip');
  pyZip(several, [['Ascent_H_Sky_17_5_8.img', older], ['Ascent_H_Sky_18_21_10.img', path.join(dir, 'Ascent_H_Sky_18_21_10.img')]]);
  const s = await open(several);
  assert.equal(s.name, 'Ascent_H_Sky_18_21_10.img');
  assert.match(s.notes.join(), /2 images; using Ascent_H_Sky_18_21_10.img \(the newest\)/);

  const none = path.join(dir, 'none.zip');
  pyZip(none, [['readme.txt', older], ['tool.exe', older]]);
  await assert.rejects(open(none), (e) => e instanceof ArchiveError && /No firmware image in none.zip \(it has readme.txt, tool.exe\)/.test(e.message));

  const zipBytes = readFileSync(path.join(dir, 'vendor-deflate-32.zip'));
  const bad = Buffer.from(zipBytes);
  bad[zipBytes.indexOf('Ascent_H_Sky_18_21_10.img') + 2000] ^= 0xff;   // inside the entry's data
  writeFileSync(path.join(dir, 'bad.zip'), bad);
  await assert.rejects(open(path.join(dir, 'bad.zip')), /damaged|invalid|incorrect|error/i);
});

const vendorZip = process.env.VENDOR_ZIP;
test('the vendor download', { skip: !(vendorZip && existsSync(vendorZip)) && 'set VENDOR_ZIP' }, async () => {
  const r = await openFirmware(file(vendorZip), { wanted });
  assert.match(r.name, /^Ascent_H_Sky_\d+_\d+_\d+\.img$/);
  const want = execFileSync('unzip', ['-p', vendorZip, `*/${r.name}`], { maxBuffer: 1 << 30 });
  assert.equal(md5(r.bytes), md5(want));
});
