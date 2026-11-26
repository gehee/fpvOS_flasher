// Registry only: each device module owns its metadata, policy and stage list.
import { ASCENT_AIR } from './ascent-air.js';
import { ASCENT_VRX } from './ascent-vrx.js';
import { FPVOS_AR9311 } from './fpvos-ar9311.js';
import { FPVOS_P1_AIR } from './fpvos-p1-air.js';
import { FPVOS_P1_GND } from './fpvos-p1-gnd.js';
import { FPVOS_STEADYDIGITAL } from './fpvos-steadydigital.js';

export const PROFILES = Object.freeze([ASCENT_AIR, ASCENT_VRX, FPVOS_AR9311, FPVOS_P1_AIR, FPVOS_P1_GND, FPVOS_STEADYDIGITAL]);
export const USB_FILTERS = [...new Map(PROFILES.flatMap((p) => p.meta.usb).map((u) => [`${u.usbVendorId}:${u.usbProductId}`, u])).values()];
// Stock units a profile can prepare in the browser (the P1's Sirius serial port)
// are offered by Connect too, so a first-time unit is recognised rather than
// missing from the chooser. These IDs are not "ours": the unit becomes an fpvOS
// device only after preparation, so profileForUsb() still rejects them.
const PREPARE_FILTERS = PROFILES.flatMap((p) => (p.meta.preparation ? [p.meta.preparation.serialFilter] : []));
export const CONNECT_FILTERS = [...new Map([...USB_FILTERS, ...PREPARE_FILTERS].map((u) => [`${u.usbVendorId}:${u.usbProductId}`, u])).values()];
// Every board that stock port may be, as { profile, unit, ui }: one where the
// port names the board (the SteadyDigital), several where boards share it -
// every stock P1 is 1d6b:0101, the air unit and the ground units alike, with
// a different recovery for each and nothing on the port to tell them apart,
// so Connect asks. `unit` is for a profile that offers several units itself
// (preparation.units), passed back to its loadAssets/loadRecovery; none does
// now, so it is null.
export const preparationsForUsb = (info) => PROFILES.filter((p) => p.meta.preparation
  && p.meta.preparation.serialFilter.usbVendorId === info.usbVendorId
  && p.meta.preparation.serialFilter.usbProductId === info.usbProductId)
  .flatMap((profile) => (profile.meta.preparation.units
    ? profile.meta.preparation.units.map((u) => ({ profile, unit: u.id, ui: u.ui }))
    : [{ profile, unit: null, ui: profile.meta.preparation.ui }]));
export const getProfile = (id) => PROFILES.find((p) => p.meta.id === id) ?? null;
// A .fwu filename cannot identify a board; only its header can.
export const profileForFileName = (name) => {
  const matches = PROFILES.filter((p) => p.meta.image.pattern.test(name));
  return matches.length === 1 ? matches[0] : null;
};
export const profileForImage = (bytes) => PROFILES.find((p) => p.meta.image.detect(bytes)) ?? null;
export const profilesForUsb = (info) => PROFILES.filter((p) => p.meta.usb.some((u) =>
  u.usbVendorId === info.usbVendorId && u.usbProductId === info.usbProductId));
// USB IDs choose a compatible transport only; FIND_DEVICE chooses the board.
export const profileForUsb = (info) => profilesForUsb(info)[0] ?? null;
export const profileForDevice = (info, usbInfo) => PROFILES.find((p) => p.meta.identity.matches(info)
  && (!usbInfo || profilesForUsb(usbInfo).includes(p))) ?? null;
