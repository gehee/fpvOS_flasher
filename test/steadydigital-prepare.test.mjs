// The SteadyDigital's stock-to-fpvOS preparation: the same Sirius reboot packet
// as the P1 on its own port, and recovery assets checked before any device I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { enterSteadyDigitalBootloader, enterP1Bootloader, loadSteadyDigitalRecovery, prepareSteadyDigitalRecovery,
  STEADYDIGITAL_RECOVERY_MANIFEST_SHA256 } from '../stages/p1-bootstrap.js';
import { STEADYDIGITAL_RAM_FILES, sha256 } from '../transports/p1-hid.js';

const fetchAssets = async (url) => new Response(await fs.readFile(new URL('../assets/steadydigital-updater/browser-v1/' + new URL(url).pathname.split('/').pop(), import.meta.url)));
const portAt = (productId, events = []) => ({ getInfo: () => ({ usbVendorId: 0x1d6b, usbProductId: productId }),
  open: async () => events.push('open'), close: async () => events.push('close'),
  writable: { getWriter: () => ({ write: async (b) => events.push(Buffer.from(b).toString('hex')), releaseLock: () => events.push('release') }) } });

test('stock SteadyDigital entry sends the nine-byte reboot request on 1d6b:0210 only', async () => {
  const events = [];
  await enterSteadyDigitalBootloader(portAt(0x0210, events));
  assert.deepEqual(events, ['open', 'aa05001d0000ccebaa', 'release', 'close']);
  // a stock P1 port (0101) is not a SteadyDigital, and vice versa: nothing is written
  const wrong = [];
  await assert.rejects(enterSteadyDigitalBootloader(portAt(0x0101, wrong)), /stock SteadyDigital/);
  await assert.rejects(enterP1Bootloader(portAt(0x0210, wrong)), /stock P1/);
  assert.deepEqual(wrong, []);
});

test('SteadyDigital recovery assets load against the pinned manifest and the RAM layout', async () => {
  const { manifest, files } = await loadSteadyDigitalRecovery({ fetcher: fetchAssets });
  assert.equal(manifest.board_id, 21316);
  assert.deepEqual(files.map((f) => f.name), Object.keys(STEADYDIGITAL_RAM_FILES));
  const raw = new Uint8Array(await (await fetchAssets('http://x/manifest.json')).arrayBuffer());
  assert.equal(await sha256(raw), STEADYDIGITAL_RECOVERY_MANIFEST_SHA256);
});

test('a tampered SteadyDigital manifest or image stops before any device is opened', async () => {
  for (const bad of ['manifest.json', 'kernel.img', 'skyzone-steadydigital.dtb', 'recovery-initrd.img']) {
    let opens = 0;
    const device = { open: async () => { opens++; } };
    const fetcher = async (url) => { const r = await fetchAssets(url); if (!new URL(url).pathname.endsWith(bad)) return r;
      const bytes = new Uint8Array(await r.arrayBuffer()); bytes[bytes.length - 1] ^= 1; return new Response(bytes); };
    await assert.rejects(prepareSteadyDigitalRecovery(device, { fetcher }), /SHA-256 mismatch/, bad);
    assert.equal(opens, 0, bad);
  }
});

test('the P1 recovery set is never accepted for a SteadyDigital (wrong board, wrong hashes)', async () => {
  const p1 = async (url) => new Response(await fs.readFile(new URL('../assets/p1-updater/browser-v1/' + new URL(url).pathname.split('/').pop(), import.meta.url)));
  await assert.rejects(loadSteadyDigitalRecovery({ fetcher: p1 }), /SteadyDigital recovery manifest SHA-256 mismatch/);
});
