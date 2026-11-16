// Where this computer is, for a goggle after a flash: its time zone as a
// POSIX TZ string (the goggles have no tzdata; their C library reads these),
// the tzdata name it came from and that zone's country (ISO 3166). The page
// sends it with SET_LOCATION once the goggle runs its new firmware; the
// updater keeps it for kestrel-gnd, which takes the zone when none is set.
// Nothing leaves the browser for this but that message to the goggle.
import { ZONES, LINKS } from './zones.js';

export function browserZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
}

// A fixed offset, for a zone tzdata does not name: <+0530>-5:30 (POSIX counts
// west of Greenwich as positive).
function fixedOffset(minutesEast) {
  if (!minutesEast) return 'UTC0';
  const sign = minutesEast > 0 ? '+' : '-', m = Math.abs(minutesEast);
  const hh = String(Math.floor(m / 60)).padStart(2, '0'), mm = m % 60;
  const name = `<${sign}${hh}${mm ? String(mm).padStart(2, '0') : ''}>`;
  return `${name}${minutesEast > 0 ? '-' : ''}${Math.floor(m / 60)}${mm ? `:${String(mm).padStart(2, '0')}` : ''}`;
}

export function hostLocation({ zone = browserZone(), now = new Date() } = {}) {
  const name = Object.hasOwn(ZONES, zone) ? zone : (Object.hasOwn(LINKS, zone) ? LINKS[zone] : '');
  if (name) return { zone: name, country: ZONES[name][0], tz: ZONES[name][1] };
  return { zone: /^[A-Za-z0-9+_/-]{1,63}$/.test(zone) ? zone : '', country: '', tz: fixedOffset(-now.getTimezoneOffset()) };
}

// SET_LOCATION's payload: TZ, zone and country, NUL-padded to 64, 64 and 8 bytes.
export function encodeLocation({ tz, zone = '', country = '' }) {
  const out = new Uint8Array(136);
  const put = (s, at, size, ok) => {
    if (!ok.test(s) || s.length >= size) throw new Error(`Invalid location field: ${s}`);
    out.set(new TextEncoder().encode(s), at);
  };
  put(tz, 0, 64, /^[A-Za-z0-9+\-,.:/<>]{4,}$/);
  put(zone, 64, 64, /^[A-Za-z0-9+_/-]*$/);
  put(country, 128, 8, /^(?:[A-Z]{2})?$/);
  return out;
}
