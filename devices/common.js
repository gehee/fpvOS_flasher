import { aswBoard, firmwareVersion } from '../firmware.js';
import { ASCENT_TRANSPORT } from '../transports/ascent.js';

export const sameFactoryIdentity = (current, before) => (!before.serial || current.serial === before.serial)
  && (!before.hardware || current.hardware === before.hardware);
export const formatBytes = (n) => n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(2)} MiB` : `${(n / 1024).toFixed(1)} KiB`;
export const stockFirmware = (info) => {
  const v = firmwareVersion(info.firmware);
  return v ? `stock firmware ${v.join('.')}` : 'stock firmware';
};
// The fpvOS version every fpvOS image reports in its updater's SDK field
// (fpvOS scripts/fpvos-version): the release tag, VERSION+gHASH[-dirty]
// between tags, and git describe's -K-gHASH on builds before 2026.11.
// Updaters before that say "development" or leave it empty: no version then.
export const fpvosVersion = (info) => (info.sdk && info.sdk !== 'development' ? `fpvOS ${info.sdk}` : 'fpvOS');
// YYYY.MM[.betaN] and, for git describe's form, how many commits past it.
export function parseFpvosVersion(sdk) {
  const m = /^(\d{4})\.(\d{1,2})(?:\.beta(\d+))?(?:-(\d+)-g[0-9a-f]+|\+g[0-9a-f]+)?(?:-dirty)?$/.exec(sdk ?? '');
  return m ? { year: +m[1], month: +m[2], beta: m[3] == null ? null : +m[3], ahead: +(m[4] ?? 0) } : null;
}
export const formatHex = (n) => `0x${n.toString(16).padStart(8, '0')}`;

export function aswImage({ prefix, board, parse, checks, capacity = false }) {
  return Object.freeze({ prefix, pattern: new RegExp(`^${prefix}_\\d+_\\d+_\\d+\\.img$`, 'i'),
    detect: (bytes) => aswBoard(bytes) === board, parse, checks,
    columns: Object.freeze(['Section', capacity ? 'Capacity' : 'Size', capacity ? 'First file offset' : 'Offset', 'Update flag']) });
}

export function defineDevice({ meta, transport = ASCENT_TRANSPORT, stages }) {
  return Object.freeze({
    meta: Object.freeze({ ...meta, deviceVersion: meta.deviceVersion ?? ((info) => firmwareVersion(info.firmware)),
      // what the page calls the connected unit, and whether it already runs fpvOS
      describe: meta.describe ?? ((info) => ({ model: meta.name, fpvos: false, firmware: stockFirmware(info) })) }),
    transport,
    stages: Object.freeze(Object.fromEntries(['preflash', 'flash', 'postflash'].map((name) => [name, Object.freeze([...stages[name]])]))),
  });
}
