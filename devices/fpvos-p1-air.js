// P1 source firmware, independent recovery and browser-only stock preparation.
import { ASCENT_TRANSPORT, ASCENT_PROTOCOL, deviceModeOf } from '../transports/ascent.js';
import { defineDevice } from './common.js';
import { FPVOS_PREPARE, FPVOS_TRANSFER, FPVOS_INSTALL, FPVOS_REBOOT_VERIFY } from '../stages/fpvos.js';
import { parseFpvosBundle, bundleForBoard } from './fpvos-bundle.js';
import { enterP1Bootloader, prepareP1Recovery, loadP1Recovery, P1_STOCK_USB, P1_HID_FILTER, P1_STOCK_VERSIONS } from '../stages/p1-bootstrap.js';

export const parseP1Bundle = (bytes) => parseFpvosBundle(bytes, {
  board: 1345409867, boardName: 'BETAFPV P1 Air / P1_SKY', maxSize: 16777216,
  names: ['kernel.img', 'betafpv-p1-air.dtb', 'rootfs.cpio.gz'],
  limits: [6291456, 65536, 8388608],
});

export const matchesFpvosP1Air = (info) => info.name === 'fpvOS updater'
  && info.hardware === 'P1_SKY' && info.serial === 'fpvos-p1-air' && info.status === 0;

// The updater's SDK field: the image's fpvOS version (git describe), from the
// updater with board/p1-air/source-post-build.sh on; "development" before.
const p1Version = (info) => (info.sdk && info.sdk !== 'development' ? `fpvOS ${info.sdk}` : 'fpvOS');

export const FPVOS_P1_AIR = defineDevice({
  meta: {
    id: 'fpvos-p1-air', name: 'BETAFPV P1 Air · fpvOS',
    models: ['BETAFPV P1 Air · Stock', 'BETAFPV P1 Air · fpvOS'],
    // fpvOS's serial port, and in bridge mode (fpvOS_usb) the AR8030's boot ROM,
    // then the running chip, the serial port kept with the updater on it
    usb: [{ usbVendorId: 0x1d6b, usbProductId: 0x0104 }, { usbVendorId: 0x4152, usbProductId: 0x8030 },
      { usbVendorId: 0x1d6b, usbProductId: 0x8030 }],
    deviceVersion: () => null,
    describe: (info) => ({ model: 'BETAFPV P1 Air', fpvos: true, firmware: p1Version(info) }),
    // normal and bridge mode where the updater names its mode; bridge mode is
    // not saved on the P1 (no SAVED_MODE in fpvOS_usb's p1-air board): a restart
    // brings it back in normal mode
    deviceModes: (info) => deviceModeOf(info) !== null,
    bridgeKept: false,
    preparation: Object.freeze({ enterBootloader: enterP1Bootloader, loadRecovery: prepareP1Recovery, loadAssets: loadP1Recovery,
      serialFilter: P1_STOCK_USB, hidFilter: P1_HID_FILTER, stockVersions: P1_STOCK_VERSIONS,
      stockVersion: '1.0.44',   // the version the page asks the user to confirm
      ui: Object.freeze({ name: 'BETAFPV P1 Air', title: 'Stock BETAFPV P1 Air',
        confirm: 'This is a standard P1 Air with stock firmware 1.0.44. Other stock versions and P1 AIO models are not supported.',
        ask: 'Prepare this unit in the browser and install fpvOS? Supported: a standard P1 Air on stock firmware 1.0.44, kept on external power throughout. Other stock versions and P1 AIO models are not supported. Nothing is written to flash yet; the bootloader is checked first.',
        restart: '1. Restart stock P1', load: '2. Load P1 recovery', serialName: 'P1 Air' }) }),
    identity: { matches: matchesFpvosP1Air, normalMatches: (a, b) => matchesFpvosP1Air(a) && matchesFpvosP1Air(b) },
    image: { pattern: /\.fwu$/i, detect: (b) => bundleForBoard(b, 1345409867), parse: parseP1Bundle,
      columns: ['Component', 'Size', 'Offset', 'Update flag'],
      checks: (p) => [['Bundle SHA-256', p.sha256 ?? ''], ['Operation', 'Install fpvOS']] },
    notices: { flash: 'Keep external power connected throughout the update. Requires the P1 fpvOS updater or clean recovery; prepare supported stock firmware using the browser controls in the Device panel first. The device checks the supported standard P1_SKY NAND layout and preserves stock bank 1, factory calibration and user settings. Unsigned development firmware; keep a verified backup and recovery access.' },
  },
  transport: Object.freeze({ ...ASCENT_TRANSPORT, strictReplies: true,
    protocol: Object.freeze({ createSession: ASCENT_PROTOCOL.createSession, deviceMode: ASCENT_PROTOCOL.deviceMode }),
    timeouts: Object.freeze({ ...ASCENT_TRANSPORT.timeouts, connect: 30000, install: 15 * 60000 }) }),
  stages: { preflash: [FPVOS_PREPARE], flash: [FPVOS_TRANSFER, FPVOS_INSTALL], postflash: [FPVOS_REBOOT_VERIFY] },
});
