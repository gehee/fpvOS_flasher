// After a flash, once the goggle runs its new firmware: gives an fpvOS goggle
// this computer's time zone and country (location.js). kestrel-gnd takes the
// zone when SYSTEM > Time Zone is NOT SET, so a pilot's own choice stays.
// Never fails the flash: a goggle that does not keep one (an older fpvOS) only
// gets a line in the log, and one back on stock is not asked.
import { CMD } from '../transports/ascent.js';
import { hostLocation, encodeLocation } from '../location.js';

export async function SEND_LOCATION(ctx) {
  const info = ctx.runtime.finalInfo;
  if (ctx.options.location === false || info?.name !== 'fpvOS updater') return;
  try {
    const where = ctx.options.location ?? hostLocation();
    const f = await ctx.session.request(CMD.SET_LOCATION, encodeLocation(where), { timeoutMs: 5000, retryMs: 1500 });
    const v = new DataView(f.payload.buffer, f.payload.byteOffset, f.payload.byteLength);
    const status = f.payload.length >= 4 ? v.getInt32(0, true) : -1;
    const detail = new TextDecoder().decode(f.payload.subarray(4)).replace(/\0.*$/s, '');
    if (status !== 0) throw new Error(detail || `status ${status}`);
    ctx.runtime.location = where;
    ctx.report.log(`gave the goggle the time zone ${where.zone || 'a fixed offset'} (${where.tz})${where.country ? `, country ${where.country}` : ''}`);
  } catch (e) {
    ctx.report.log(`the goggle did not take this computer's time zone: ${e.message}`, 'warn');
  }
}
