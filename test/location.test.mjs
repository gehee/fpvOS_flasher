// The location a goggle gets after a flash: this computer's time zone and
// country, and SET_LOCATION's payload (the flash itself: fpvos.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZONES, LINKS } from '../zones.js';
import { hostLocation, encodeLocation } from '../location.js';

const td = new TextDecoder();
const fields = (p) => [td.decode(p.subarray(0, 64)), td.decode(p.subarray(64, 128)), td.decode(p.subarray(128))]
  .map((s) => s.replace(/\0+$/, ''));

test('every tzdata zone and old name gives a TZ string the unit takes', () => {
  assert.ok(Object.keys(ZONES).length > 400);
  for (const zone of [...Object.keys(ZONES), ...Object.keys(LINKS)]) {
    const where = hostLocation({ zone });
    assert.ok(where.tz && where.zone, zone);
    assert.equal(encodeLocation(where).length, 136, zone);
  }
});

test('zones, old names and countries', () => {
  assert.deepEqual(hostLocation({ zone: 'Europe/Paris' }), { zone: 'Europe/Paris', country: 'FR', tz: 'CET-1CEST,M3.5.0,M10.5.0/3' });
  assert.deepEqual(hostLocation({ zone: 'Asia/Calcutta' }), { zone: 'Asia/Kolkata', country: 'IN', tz: 'IST-5:30' });
  assert.deepEqual(hostLocation({ zone: 'US/Pacific' }), { zone: 'America/Los_Angeles', country: 'US', tz: 'PST8PDT,M3.2.0,M11.1.0' });
  assert.deepEqual(hostLocation({ zone: 'Australia/Sydney' }).country, 'AU');
  assert.deepEqual(hostLocation({ zone: 'UTC' }), { zone: 'Etc/UTC', country: '', tz: 'UTC0' });
  // not in tzdata: the offset now, no country
  const at = (minutesEast) => ({ getTimezoneOffset: () => -minutesEast });
  assert.deepEqual(hostLocation({ zone: 'Mars/Olympus', now: at(330) }), { zone: 'Mars/Olympus', country: '', tz: '<+0530>-5:30' });
  assert.equal(hostLocation({ zone: '', now: at(-180) }).tz, '<-03>3');
  assert.equal(hostLocation({ zone: '', now: at(0) }).tz, 'UTC0');
  assert.equal(hostLocation({ zone: 'bad zone; x', now: at(60) }).zone, '');
});

test('SET_LOCATION payload: fields NUL-padded, nothing a shell would see', () => {
  const p = encodeLocation({ tz: 'CET-1CEST,M3.5.0,M10.5.0/3', zone: 'Europe/Paris', country: 'FR' });
  assert.deepEqual(fields(p), ['CET-1CEST,M3.5.0,M10.5.0/3', 'Europe/Paris', 'FR']);
  assert.throws(() => encodeLocation({ tz: "UTC0'" }));
  assert.throws(() => encodeLocation({ tz: 'UTC0', zone: 'a b' }));
  assert.throws(() => encodeLocation({ tz: 'UTC0', country: 'FRA' }));
  assert.throws(() => encodeLocation({ tz: 'X'.repeat(64) }));
});
