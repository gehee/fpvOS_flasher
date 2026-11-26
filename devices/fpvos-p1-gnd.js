// BETAFPV P1 ground units (AR9311) running the fpvOS update service (USB
// 1d6b:0104), either installed fpvOS or the clean RAM recovery: the VR04
// HD FPV Goggles and the P1 HD VRX (Standard and Nano). One fpvOS image serves them, as stock's common
// P1_GND firmware does; every unit reports hardware "P1_GND" and serial
// "fpvos-p1-gnd" to FIND_DEVICE, and a bundle carries board 0x50314744.
//
// The units differ in their device tree alone (the goggles' panel, the
// VRX's HDMI output), so there is a bundle per unit, each with that
// unit's tree: fpvos-p1-gnd-goggles-<version>.fwu,
// fpvos-p1-gnd-vrx-<version>.fwu (the P1 HD VRX, Standard and Nano: one
// board to stock's firmware) and fpvos-p1-gnd-goggles-pro-<version>.fwu (the
// VR04 HD Pro FPV Goggles: a panel behind a GM8773C bridge, the goggles
// bundle is expected to show no picture on them). An installed unit knows
// which it is from its tree and takes only its own. A stock unit's recovery
// runs on a tree for any ground unit and takes any: whoever picks the file
// names the unit. This page cannot tell the files apart, the unit does.
//
// A full .fwu installs on the bank that does not hold stock and keeps the
// stock bank selected while writing. Factory calibration, the environment,
// U-Boot and the stock bank are never written.
//
// A stock unit enumerates on the P1's Sirius serial port (1d6b:0101), the
// same one as a stock P1 Air, and lands in the same USB download gadget:
// Connect asks whether it is the air unit or a ground unit, since the two
// have different recoveries. Which ground unit is not asked.
// Not run on hardware.
import { ASCENT_TRANSPORT, ASCENT_PROTOCOL, deviceModeOf } from '../transports/ascent.js';
import { defineDevice, fpvosVersion } from './common.js';
import { FPVOS_PREPARE, FPVOS_TRANSFER, FPVOS_INSTALL, FPVOS_REBOOT_VERIFY } from '../stages/fpvos.js';
import { SEND_LOCATION } from '../stages/location.js';
import { parseFpvosBundle, bundleForBoard } from './fpvos-bundle.js';
import { enterP1Bootloader, prepareP1GndRecovery, loadP1GndRecovery, P1_STOCK_USB, P1_HID_FILTER, P1_GND_STOCK_VERSIONS, P1_AUTO } from '../stages/p1-bootstrap.js';

const BOARD = 1345406788;   // 0x50314744, fpvOS's backends/p1-gnd/profile.json

// The unit a bundle is for, from the name its device tree gives the board
// (fpvOS's betafpv-p1-*.dts): what the unit's own updater goes by.
export const P1_GND_UNITS = Object.freeze([
  Object.freeze({ id: 'goggles', compatible: 'betafpv,p1-goggle', name: 'VR04 HD FPV Goggles' }),
  Object.freeze({ id: 'goggles-pro', compatible: 'betafpv,p1-goggle-pro', name: 'VR04 HD Pro FPV Goggles' }),
  Object.freeze({ id: 'vrx', compatible: 'betafpv,p1-nano-vrx', name: 'P1 HD VRX (Standard or Nano)' }),
]);
const contains = (bytes, text) => {
  const want = new TextEncoder().encode(text);
  outer: for (let i = bytes.indexOf(want[0]); i >= 0 && i + want.length <= bytes.length; i = bytes.indexOf(want[0], i + 1)) {
    for (let j = 1; j < want.length; j++) if (bytes[i + j] !== want[j]) continue outer;
    return true;
  }
  return false;
};

export async function parseP1GndBundle(bytes) {
  const r = await parseFpvosBundle(bytes, {
    board: BOARD, boardName: 'BETAFPV P1 ground unit / P1_GND', maxSize: 25165824,
    names: ['kernel.img', 'p1-gnd.dtb', 'rootfs.cpio.gz'],
    limits: [6291456, 61440, 16777216],
  });
  const dtb = r.sections.find((s) => s.name === 'p1-gnd.dtb');
  if (dtb) {
    const tree = bytes.subarray(dtb.offset, dtb.offset + dtb.length);
    // a whole name: the string and its end, so the goggles are not the Pro
    const unit = P1_GND_UNITS.find((u) => contains(tree, `${u.compatible}\0`));
    if (unit) r.unit = { id: unit.id, name: unit.name };
  }
  return r;
}

export const matchesFpvosP1Gnd = (info) => info.name === 'fpvOS updater'
  && info.hardware === 'P1_GND' && info.serial === 'fpvos-p1-gnd' && info.status === 0;

const NAME = 'BETAFPV VR04 goggles or P1 HD VRX';
const STOCK = 'stock firmware 1.0.44, 2.0.5, 2.0.6, 2.0.8 or 2.1.4 (the page detects which from its bootloader)';

export const FPVOS_P1_GND = defineDevice({
  meta: {
    id: 'fpvos-p1-gnd', name: 'BETAFPV P1 ground unit · fpvOS',
    models: ['BETAFPV VR04 HD FPV Goggles · Stock', 'BETAFPV VR04 HD Pro FPV Goggles · Stock', 'BETAFPV P1 HD VRX (Standard) · Stock', 'BETAFPV P1 HD VRX (Nano) · Stock',
      'BETAFPV VR04 HD FPV Goggles · fpvOS', 'BETAFPV VR04 HD Pro FPV Goggles · fpvOS', 'BETAFPV P1 HD VRX (Standard) · fpvOS', 'BETAFPV P1 HD VRX (Nano) · fpvOS'],
    // fpvOS's serial port, and in bridge mode (fpvOS_usb) the AR8030's boot ROM,
    // then the running chip, the serial port kept with the updater on it
    usb: [{ usbVendorId: 0x1d6b, usbProductId: 0x0104 }, { usbVendorId: 0x4152, usbProductId: 0x8030 },
      { usbVendorId: 0x1d6b, usbProductId: 0x8030 }],
    deviceVersion: () => null,
    // one identity for both units: the updater does not say which it runs on
    describe: (info) => ({ model: 'BETAFPV P1 ground unit', fpvos: true, firmware: fpvosVersion(info) }),
    deviceModes: (info) => deviceModeOf(info) !== null,
    // stock stays on the other bank: the updater's "stock" request selects it
    // and restarts (fpvos-update nand stock)
    stockReturn: 'bank',
    preparation: Object.freeze({ enterBootloader: enterP1Bootloader, loadRecovery: prepareP1GndRecovery, loadAssets: loadP1GndRecovery,
      serialFilter: P1_STOCK_USB, hidFilter: P1_HID_FILTER, stockVersions: P1_GND_STOCK_VERSIONS,
      // found by probing (1.0.44 has the v1 bootloader, 2.x the v2 one), v1 first
      stockVersion: P1_AUTO,
      ui: Object.freeze({ name: NAME, title: 'Stock BETAFPV VR04 goggles or P1 HD VRX',
        confirm: `This is a VR04 HD FPV Goggles, a VR04 HD Pro FPV Goggles or a P1 HD VRX (Standard or Nano) on ${STOCK}.`,
        ask: `Prepare this unit in the browser and install fpvOS? For the VR04 HD FPV Goggles, the VR04 HD Pro FPV Goggles and the P1 HD VRX (Standard or Nano) on ${STOCK}, kept on external power throughout. `
          + 'The bundle picked afterwards names the unit. Nothing is written to flash yet; the bootloader is checked first.',
        restart: '1. Restart stock P1', load: '2. Load P1 recovery', serialName: 'P1 ground unit' }) }),
    identity: { matches: matchesFpvosP1Gnd, normalMatches: (a, b) => matchesFpvosP1Gnd(a) && matchesFpvosP1Gnd(b) },
    image: { pattern: /\.fwu$/i, detect: (b) => bundleForBoard(b, BOARD), parse: parseP1GndBundle,
      columns: ['Component', 'Size', 'Offset', 'Update flag'],
      checks: (p) => [['Bundle SHA-256', p.sha256 ?? ''], ['Operation', 'Install fpvOS (on the bank not holding stock; stock kept)']] },
    notices: { flash: 'Install the bundle for this unit: fpvos-p1-gnd-goggles for the VR04 HD FPV Goggles, fpvos-p1-gnd-vrx for the P1 HD VRX (Standard or Nano), fpvos-p1-gnd-goggles-pro for the VR04 HD Pro FPV Goggles. A unit already on fpvOS refuses the bundle of another; a stock unit being prepared takes any of them, and a wrong one leaves it with no picture (switch back to stock from this page). A stock unit is prepared from this page first (Connect, then the two steps in the Device panel); an fpvOS or clean-recovery unit installs directly. Keep external power connected throughout. The install writes the bank that does not hold stock and keeps the stock bank selected while writing, so a power cut still boots stock; factory calibration, the environment, U-Boot and the stock bank are never written. Unsigned development firmware, not yet run on hardware; keep a verified backup and recovery access.' },
  },
  transport: Object.freeze({ ...ASCENT_TRANSPORT, strictReplies: true,
    protocol: Object.freeze({ createSession: ASCENT_PROTOCOL.createSession, deviceMode: ASCENT_PROTOCOL.deviceMode }),
    timeouts: Object.freeze({ ...ASCENT_TRANSPORT.timeouts, connect: 30000, install: 15 * 60000 }) }),
  stages: { preflash: [FPVOS_PREPARE], flash: [FPVOS_TRANSFER, FPVOS_INSTALL], postflash: [FPVOS_REBOOT_VERIFY, SEND_LOCATION] },
});
