// Registry only: each device module owns its metadata, policy and stage list.
import { ASCENT_AIR } from './ascent-air.js';
import { ASCENT_VRX } from './ascent-vrx.js';

export const PROFILES = Object.freeze([ASCENT_AIR, ASCENT_VRX]);
export const USB_FILTERS = PROFILES.flatMap((p) => p.meta.usb);
export const getProfile = (id) => PROFILES.find((p) => p.meta.id === id) ?? null;
export const profileForFileName = (name) => PROFILES.find((p) => p.meta.image.pattern.test(name)) ?? null;
export const profileForImage = (bytes) => PROFILES.find((p) => p.meta.image.detect(bytes)) ?? null;
export const profileForUsb = (info) => PROFILES.find((p) => p.meta.usb.some((u) =>
  u.usbVendorId === info.usbVendorId && u.usbProductId === info.usbProductId)) ?? null;
export const profileForDevice = (info, usbInfo) => PROFILES.find((p) => p.meta.identity.matches(info)
  && (!usbInfo || profileForUsb(usbInfo) === p)) ?? null;
