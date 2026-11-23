// Skyzone SteadyDigital (AR9311) running the fpvOS update service (USB
// 1d6b:0104), either installed fpvOS or the clean RAM recovery. Same framing
// and service as the Ascent VRX profile; the board reports hardware
// "SteadyDigital" and serial "fpvos-steadydigital" to FIND_DEVICE.
//
// A full fpvOS .fwu (board 21316) installs on the bank that does not hold
// stock (the bank already holding fpvOS, else the one not booted) and keeps
// the stock bank selected while writing, so a power cut still boots stock.
// Factory calibration, the environment, U-Boot and the stock bank are never
// written.
//
// A stock unit enumerates as an Artosyn Sirius composite gadget (1d6b:0210), not
// on this service. Connect recognises that port and prepares the unit from the
// browser (restart into the U-Boot download gadget, then load the fpvOS RAM
// recovery over WebHID); once it runs fpvOS or the clean recovery, this profile
// installs from there.
import { ASCENT_TRANSPORT, ASCENT_PROTOCOL, deviceModeOf } from '../transports/ascent.js';
import { defineDevice } from './common.js';
import { FPVOS_PREPARE, FPVOS_TRANSFER, FPVOS_INSTALL, FPVOS_REBOOT_VERIFY } from '../stages/fpvos.js';
import { SEND_LOCATION } from '../stages/location.js';
import { enterSteadyDigitalBootloader, prepareSteadyDigitalRecovery, loadSteadyDigitalRecovery, STEADYDIGITAL_STOCK_USB, P1_HID_FILTER } from '../stages/p1-bootstrap.js';
import { parseFpvosBundle as parseBundle, bundleForBoard } from './fpvos-bundle.js';

export const parseFpvosBundle = (bytes) => parseBundle(bytes, {
  board: 21316, boardName: 'fpvOS SteadyDigital', maxSize: 33554432,
  // fpvOS's backends/skyzone-steadydigital/profile.json: the root is the
  // squashfs the unit mounts from flash (UBI in the installed bank), up to 24 MiB.
  names: ['kernel.img', 'skyzone-steadydigital.dtb', 'rootfs.squashfs'],
  limits: [6291456, 65536, 25165824],
});

export const matchesFpvosSteadyDigital = (info) => info.name === 'fpvOS updater'
  && info.hardware === 'SteadyDigital' && info.serial === 'fpvos-steadydigital' && info.status === 0;

export const FPVOS_STEADYDIGITAL = defineDevice({
  meta: {
    id: 'fpvos-steadydigital', name: 'Skyzone SteadyDigital · fpvOS', models: ['Skyzone SteadyDigital · fpvOS'],
    // fpvOS's serial port, and in bridge mode (fpvOS_usb) the AR8030's boot ROM,
    // then the running chip, the serial port kept with the updater on it
    usb: [{ usbVendorId: 0x1d6b, usbProductId: 0x0104 }, { usbVendorId: 0x4152, usbProductId: 0x8030 },
      { usbVendorId: 0x1d6b, usbProductId: 0x8030 }],
    deviceVersion: () => null,
    // normal and bridge mode where the updater names its mode; the firmware keeps
    // bridge across reboots (S61fpvos-usb), so bridgeKept stays at its default
    deviceModes: (info) => deviceModeOf(info) !== null,
    preparation: Object.freeze({ enterBootloader: enterSteadyDigitalBootloader, loadRecovery: prepareSteadyDigitalRecovery, loadAssets: loadSteadyDigitalRecovery,
      serialFilter: STEADYDIGITAL_STOCK_USB, hidFilter: P1_HID_FILTER, stockVersions: Object.freeze(['2.1.2']),
      stockVersion: '2.1.2',
      ui: Object.freeze({ name: 'Skyzone SteadyDigital', title: 'Stock Skyzone SteadyDigital',
        confirm: 'This is a Skyzone SteadyDigital on its stock firmware.',
        ask: 'Prepare this unit in the browser and install fpvOS? Keep external power connected throughout. Nothing is written to flash yet; the bootloader is checked first, and stock stays in bank A.',
        restart: '1. Restart stock SteadyDigital', load: '2. Load SteadyDigital recovery', serialName: 'SteadyDigital' }) }),
    describe: () => ({ model: 'Skyzone SteadyDigital', fpvos: true, firmware: 'fpvOS' }),
    identity: { matches: matchesFpvosSteadyDigital, normalMatches: (a, b) => matchesFpvosSteadyDigital(a) && matchesFpvosSteadyDigital(b) },
    image: { pattern: /\.fwu$/i, detect: (b) => bundleForBoard(b, 21316), parse: parseFpvosBundle,
      columns: ['Component', 'Size', 'Offset', 'Update flag'],
      checks: (p) => [['Bundle SHA-256', p.sha256 ?? ''], ['Operation', 'Install fpvOS (on the bank not holding stock; stock kept)']] },
    notices: { flash: 'A stock unit is prepared from this page first (Connect, then the two steps in the Device panel); an fpvOS or clean-recovery unit installs directly. Keep external power connected throughout. The install writes the bank that does not hold stock (whichever bank a stock update left it on) and keeps the stock bank selected while writing, so a power cut still boots stock; factory calibration, the environment, U-Boot and the stock bank are never written. Settings and pairing in usr_data are preserved. Unsigned development firmware; keep a verified backup and a working U-Boot RAM recovery path.' },
  },
  transport: Object.freeze({ ...ASCENT_TRANSPORT, strictReplies: true,
    protocol: Object.freeze({ createSession: ASCENT_PROTOCOL.createSession, deviceMode: ASCENT_PROTOCOL.deviceMode }),
    timeouts: Object.freeze({ ...ASCENT_TRANSPORT.timeouts, connect: 30000, install: 15 * 60000 }) }),
  stages: { preflash: [FPVOS_PREPARE], flash: [FPVOS_TRANSFER, FPVOS_INSTALL], postflash: [FPVOS_REBOOT_VERIFY, SEND_LOCATION] },
});
