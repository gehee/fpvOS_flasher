// One safety net across every supported board: what each profile recognises,
// what it must never recognise, which USB IDs reach it, and that the shipped
// browser-recovery assets still match their manifests. Written before the
// stock-preparation panel is made generic, so a refactor cannot quietly change
// which hardware a Connect, a .fwu or a stock Sirius port is routed to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  PROFILES, USB_FILTERS, CONNECT_FILTERS, getProfile, profileForUsb, profilesForUsb,
  profileForDevice, profileForImage, preparationForUsb,
} from '../devices/index.js';
import {
  P1_RAM_FILES, STEADYDIGITAL_RAM_FILES, P1_STOCK_USB, STEADYDIGITAL_STOCK_USB, P1_HID_FILTER,
} from '../transports/p1-hid.js';
import { crc32 } from '../transports/ascent.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const usbKey = (u) => `${u.usbVendorId.toString(16)}:${u.usbProductId.toString(16)}`;

// FIND_DEVICE replies as each board reports them.
const FPVOS_INFO = { name: 'fpvOS updater', status: 0, maxChunk: 1024, detail: 'clean RAM mode',
  firmware: 'fpvOS unsigned development updates' };
const HARDWARE = {
  'ascent-air': { info: { name: 'Ascent_H_Sky', firmware: 'Ascent_H_Sky_18_21_10', hardware: 'FPV-Ascent-Sky-482-V1.3-1.0', serial: 'AIR0001' },
    usb: { usbVendorId: 0x1d76, usbProductId: 0x0101 } },
  'ascent-vrx': { info: { name: 'Ascent_VRX', firmware: 'Ascent_G_Gnd_17_5_3', hardware: 'FPV-Ascent-Gnd-485-V1.2-1.0' },
    usb: { usbVendorId: 0x1d75, usbProductId: 0x0101 } },
  'fpvos-ar9311': { info: { ...FPVOS_INFO, hardware: 'Gnd485', serial: 'fpvos-ar9311' },
    usb: { usbVendorId: 0x1d6b, usbProductId: 0x0104 } },
  'fpvos-p1-air': { info: { ...FPVOS_INFO, hardware: 'P1_SKY', serial: 'fpvos-p1-air' },
    usb: { usbVendorId: 0x1d6b, usbProductId: 0x0104 } },
  'fpvos-steadydigital': { info: { ...FPVOS_INFO, hardware: 'SteadyDigital', serial: 'fpvos-steadydigital' },
    usb: { usbVendorId: 0x1d6b, usbProductId: 0x0104 } },
};
const BOARD_IDS = { 'fpvos-ar9311': 485, 'fpvos-p1-air': 1345409867, 'fpvos-steadydigital': 21316 };
const FPVOS_SHARED_USB = { usbVendorId: 0x1d6b, usbProductId: 0x0104 };

function bundle(board) {
  const names = { 485: ['kernel.img', 'ascent-gnd485.dtb', 'rootfs.cpio.uboot'],
    21316: ['kernel.img', 'skyzone-steadydigital.dtb', 'rootfs.squashfs'],
    1345409867: ['kernel.img', 'betafpv-p1-air.dtb', 'rootfs.cpio.gz'] }[board];
  const payloads = [Buffer.from('kernel'), Buffer.from('dtb'), Buffer.from('root')];
  const h = Buffer.alloc(512);
  h.write('FPVOSUP1');
  [1, board, 512 + payloads.reduce((n, p) => n + p.length, 0), payloads.length].forEach((n, i) => h.writeUInt32LE(n, 8 + i * 4));
  h.write('development', 24); h.writeUInt32LE(0, 88);
  payloads.forEach((p, i) => {
    const o = 96 + 104 * i;
    h.write(names[i], o); h.writeUInt32LE(p.length, o + 32); h.write(sha(p), o + 36);
  });
  h.writeUInt32LE(crc32(h), 508);
  return Buffer.concat([h, ...payloads]);
}

test('the registry holds exactly the supported boards, each with a complete definition', () => {
  assert.deepEqual(PROFILES.map((p) => p.meta.id).sort(), Object.keys(HARDWARE).sort());
  assert.equal(new Set(PROFILES.map((p) => p.meta.id)).size, PROFILES.length);
  for (const p of PROFILES) {
    const id = p.meta.id;
    assert.equal(getProfile(id), p, id);
    assert.ok(p.meta.name && p.meta.models.length, `${id} name/models`);
    assert.ok(p.meta.usb.length, `${id} usb`);
    assert.equal(typeof p.meta.identity.matches, 'function', `${id} identity`);
    assert.equal(typeof p.meta.image.parse, 'function', `${id} image.parse`);
    assert.equal(typeof p.meta.image.detect, 'function', `${id} image.detect`);
    assert.ok(p.meta.notices?.flash, `${id} flash notice`);
    assert.ok(p.stages && Array.isArray(p.stages.flash) && p.stages.flash.length, `${id} flash stages`);
    assert.ok(p.transport, `${id} transport`);
  }
});

test('every board is recognised by its own FIND_DEVICE reply and by nobody else', () => {
  for (const [id, { info, usb }] of Object.entries(HARDWARE)) {
    assert.equal(profileForDevice(info, usb), getProfile(id), `${id} with its USB id`);
    assert.equal(PROFILES.filter((p) => p.meta.identity.matches(info)).length <= 1, true, `${id} matches at most one profile`);
    // a reply from this board never selects another board's profile
    for (const [otherId, other] of Object.entries(HARDWARE)) {
      if (otherId === id) continue;
      assert.notEqual(profileForDevice(info, other.usb), getProfile(otherId), `${id} reply must not pick ${otherId}`);
    }
  }
});

test('fpvOS replies must carry the exact hardware, serial, name and a zero status', () => {
  for (const id of ['fpvos-ar9311', 'fpvos-p1-air', 'fpvos-steadydigital']) {
    const { info, usb } = HARDWARE[id];
    for (const change of [{ hardware: 'Other' }, { serial: 'fpvos-other' }, { name: 'Ascent_VRX' }, { status: -1 }, { hardware: '' }]) {
      assert.equal(profileForDevice({ ...info, ...change }, usb), null, `${id} ${JSON.stringify(change)}`);
    }
  }
  // clean RAM mode and installed fpvOS both match (detail differs, identity does not)
  for (const detail of ['clean RAM mode', 'installed', '']) {
    assert.equal(profileForDevice({ ...HARDWARE['fpvos-steadydigital'].info, detail }), getProfile('fpvos-steadydigital'), detail);
  }
});

test('USB IDs choose a transport only: the shared fpvOS ID is claimed by exactly the three fpvOS boards', () => {
  assert.deepEqual(profilesForUsb(FPVOS_SHARED_USB).map((p) => p.meta.id).sort(),
    ['fpvos-ar9311', 'fpvos-p1-air', 'fpvos-steadydigital']);
  assert.equal(profileForUsb(HARDWARE['ascent-vrx'].usb), getProfile('ascent-vrx'));
  assert.equal(profileForUsb(HARDWARE['ascent-air'].usb), getProfile('ascent-air'));
  assert.equal(profileForUsb({ usbVendorId: 0x1d6b, usbProductId: 0x0210 }), null, 'a stock SteadyDigital is not an fpvOS device');
  assert.equal(profileForUsb(P1_STOCK_USB), null, 'a stock P1 is not an fpvOS device');
  assert.equal(profileForUsb({ usbVendorId: 0xffff, usbProductId: 1 }), null);
});

test('the Connect chooser lists every board USB ID and the stock port the P1 can prepare, without duplicates', () => {
  const keys = CONNECT_FILTERS.map(usbKey);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate filters');
  for (const f of USB_FILTERS) assert.ok(keys.includes(usbKey(f)), `${usbKey(f)} offered`);
  assert.ok(keys.includes(usbKey(P1_STOCK_USB)), 'stock P1 serial offered');
  for (const p of PROFILES) for (const u of p.meta.usb) assert.ok(keys.includes(usbKey(u)), `${p.meta.id} ${usbKey(u)}`);
});

test('a .fwu is routed by its board id, never by filename, to exactly one profile', () => {
  for (const [id, board] of Object.entries(BOARD_IDS)) {
    const bytes = new Uint8Array(bundle(board));
    assert.equal(profileForImage(bytes), getProfile(id), `${id} bundle`);
    for (const p of PROFILES) {
      assert.equal(!!p.meta.image.detect(bytes), p.meta.id === id, `${p.meta.id} detect(${id} bundle)`);
    }
  }
});

test('each fpvOS board accepts only its own bundle, and rejects the other boards', async () => {
  for (const [id, board] of Object.entries(BOARD_IDS)) {
    const own = await getProfile(id).meta.image.parse(new Uint8Array(bundle(board)));
    assert.deepEqual(own.errors, [], `${id} accepts its own bundle`);
    for (const [otherId, otherBoard] of Object.entries(BOARD_IDS)) {
      if (otherId === id) continue;
      const parsed = await getProfile(id).meta.image.parse(new Uint8Array(bundle(otherBoard)));
      assert.ok(parsed.errors.length, `${id} must reject the ${otherId} bundle`);
    }
  }
});

test('stock preparation: each board owns its own Sirius port and no two boards share one', () => {
  const p1 = getProfile('fpvos-p1-air'), sd = getProfile('fpvos-steadydigital');
  assert.equal(preparationForUsb(P1_STOCK_USB), p1);
  assert.equal(preparationForUsb(STEADYDIGITAL_STOCK_USB), sd);
  assert.equal(preparationForUsb({ usbVendorId: 0x1d6b, usbProductId: 0x0104 }), null, 'an fpvOS unit is not prepared');
  for (const [p, usb] of [[p1, P1_STOCK_USB], [sd, STEADYDIGITAL_STOCK_USB]]) {
    const prep = p.meta.preparation;
    assert.deepEqual(prep.serialFilter, usb, p.meta.id);
    assert.equal(prep.hidFilter, P1_HID_FILTER, p.meta.id);
    assert.equal(typeof prep.enterBootloader, 'function', p.meta.id);
    assert.equal(typeof prep.loadRecovery, 'function', p.meta.id);
    assert.ok(prep.stockVersions.includes(prep.stockVersion), `${p.meta.id} default stock version is a supported one`);
    for (const k of ['name', 'title', 'confirm', 'ask', 'restart', 'load', 'serialName']) assert.ok(prep.ui[k], `${p.meta.id} ui.${k}`);
  }
  const ports = PROFILES.filter((p) => p.meta.preparation).map((p) => usbKey(p.meta.preparation.serialFilter));
  assert.equal(new Set(ports).size, ports.length, 'unique stock ports');
  assert.ok(CONNECT_FILTERS.map(usbKey).includes(usbKey(STEADYDIGITAL_STOCK_USB)), 'Connect offers the stock SteadyDigital');
  // boards without a browser stock path (Ascent) never claim a Sirius port
  for (const id of ['ascent-air', 'ascent-vrx', 'fpvos-ar9311']) assert.equal(getProfile(id).meta.preparation, undefined, id);
});

test('the SteadyDigital stock port and RAM layout are distinct from the P1 and unchanged', () => {
  assert.deepEqual(STEADYDIGITAL_STOCK_USB, { usbVendorId: 0x1d6b, usbProductId: 0x0210 });
  assert.notDeepEqual(STEADYDIGITAL_STOCK_USB, P1_STOCK_USB);
  // same RAM destinations on both AR9311 recoveries; only the dtb name differs
  assert.deepEqual(Object.values(STEADYDIGITAL_RAM_FILES), Object.values(P1_RAM_FILES));
  assert.deepEqual(Object.keys(STEADYDIGITAL_RAM_FILES), ['kernel.img', 'skyzone-steadydigital.dtb', 'recovery-initrd.img']);
  assert.deepEqual(Object.keys(P1_RAM_FILES), ['kernel.img', 'betafpv-p1-air.dtb', 'recovery-initrd.img']);
  assert.deepEqual(STEADYDIGITAL_RAM_FILES['kernel.img'], [0x24400000, 6291456]);
  assert.deepEqual(STEADYDIGITAL_RAM_FILES['skyzone-steadydigital.dtb'], [0x22080000, 65536]);
  assert.deepEqual(STEADYDIGITAL_RAM_FILES['recovery-initrd.img'], [0x26000000, 65536]);
});

// ---- shipped recovery assets: bytes, hashes and RAM addresses ----------------
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url));
const manifest = (dir) => JSON.parse(read(`${dir}/manifest.json`).toString());

for (const [name, dir, ramFiles, board] of [
  ['P1 Air', 'assets/p1-updater/browser-v1', P1_RAM_FILES, 1345409867],
  ['SteadyDigital', 'assets/steadydigital-updater/browser-v1', STEADYDIGITAL_RAM_FILES, 21316],
]) {
  test(`${name} browser recovery assets match their manifest, RAM layout and bootloader fingerprints`, () => {
    const m = manifest(dir);
    assert.equal(m.format, 1);
    assert.equal(m.version, 'browser-v1');
    assert.equal(m.board_id, board);
    assert.deepEqual(Object.keys(m.files).sort(), Object.keys(ramFiles).sort(), 'manifest lists exactly the RAM files');
    for (const [file, [address, limit]] of Object.entries(ramFiles)) {
      const entry = m.files[file];
      const bytes = read(`${dir}/${file}`);
      assert.equal(entry.address, address, `${file} address`);
      assert.equal(bytes.length, entry.size, `${file} size`);
      assert.ok(entry.size > 0 && entry.size <= limit, `${file} fits its ${limit}-byte RAM window`);
      assert.equal(sha(bytes), entry.sha256, `${file} sha256`);
    }
    assert.ok(m.bootloaders.v2?.fingerprints.length === 4, 'v2 bootloader fingerprints');
    for (const f of m.bootloaders.v2.fingerprints) {
      assert.ok(f.address > 0 && f.size > 0 && /^[0-9a-f]{64}$/.test(f.sha256));
    }
  });
}

test('the P1 Air keeps its v1 and v2 bootloader fingerprints; SteadyDigital ships v2 only', () => {
  assert.deepEqual(Object.keys(manifest('assets/p1-updater/browser-v1').bootloaders).sort(), ['v1', 'v2']);
  assert.deepEqual(Object.keys(manifest('assets/steadydigital-updater/browser-v1').bootloaders), ['v2']);
  // the SteadyDigital reuses the P1 v2 bootloader verbatim
  assert.deepEqual(manifest('assets/steadydigital-updater/browser-v1').bootloaders.v2,
    manifest('assets/p1-updater/browser-v1').bootloaders.v2);
});

test('the AR9311 (Ascent VRX fpvOS) v3 bootstrap files match their manifest', () => {
  const dir = 'assets/ar9311-updater/v3', m = manifest(dir);
  assert.equal(m.board_id, 485);
  for (const [file, entry] of Object.entries(m.files)) {
    const bytes = read(`${dir}/${file}`);
    assert.equal(bytes.length, entry.size, `${file} size`);
    assert.equal(sha(bytes), entry.sha256, `${file} sha256`);
  }
});

test('the SteadyDigital test page still imports only things the transport exports', async () => {
  const html = read('steadydigital-prepare.html').toString();
  const imports = /import \{([^}]+)\} from '\.\/transports\/p1-hid\.js'/.exec(html);
  assert.ok(imports, 'page imports the P1 HID transport');
  const mod = await import('../transports/p1-hid.js');
  for (const name of imports[1].split(',').map((s) => s.trim())) assert.ok(name in mod, `${name} exported`);
});

test('device modes: the fpvOS boards that keep a bridge offer the switch; the Ascent VRX does not', async () => {
  const { deviceModeRequest } = await import('../transports/ascent.js');
  for (const id of ['fpvos-p1-air', 'fpvos-steadydigital']) {
    const p = getProfile(id);
    assert.equal(typeof p.transport.protocol.deviceMode, 'function', `${id} can request a mode`);
    for (const [detail, shown] of [['normal mode', true], ['bridge mode', true], ['clean RAM mode', true], ['OK', false], ['', false]]) {
      assert.equal(p.meta.deviceModes({ ...HARDWARE[id].info, detail }), shown, `${id} "${detail}"`);
    }
    // in bridge mode the AR8030 enumerates under these IDs and must reach this profile's transport
    for (const usb of [{ usbVendorId: 0x4152, usbProductId: 0x8030 }, { usbVendorId: 0x1d6b, usbProductId: 0x8030 }]) {
      assert.ok(profilesForUsb(usb).includes(p), `${id} ${usbKey(usb)}`);
    }
  }
  // the SteadyDigital's firmware keeps bridge across reboots: bridgeKept is not turned off
  assert.notEqual(getProfile('fpvos-steadydigital').meta.bridgeKept, false);
  assert.equal(getProfile('fpvos-p1-air').meta.bridgeKept, false);
  assert.equal(getProfile('fpvos-ar9311').transport.protocol.deviceMode, undefined);
  assert.equal(deviceModeRequest('normal', 'bridge'), 'bridge');
  assert.equal(deviceModeRequest('bridge', 'normal'), 'normal');
  assert.equal(deviceModeRequest('update', 'bridge'), null);
});
