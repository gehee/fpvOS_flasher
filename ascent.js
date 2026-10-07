// Flashing an Ascent air unit over its USB serial port.
//
// This speaks the protocol of the vendor's PC tool (read from a decompile of its
// Windows build, v2.0.40) to the updater on the unit (ar_fpvhs_upgrade). The
// unit does the flashing itself: it checks the frame CRCs and the file's MD5,
// writes the inactive bank and switches banks. The host only ships the file.
//
// No browser APIs in here: the transport ("link") is passed in, so the Web
// Serial page and the Node tests share this file. A link has
//   open(), close(), write(Uint8Array)
//   onBytes(Uint8Array) and onClose()  - set by Session, called by the link
//   closed                             - a promise that settles when the port goes away
//   reopen({timeoutMs})                - waits for the unit to come back after a reboot

export const CMD = Object.freeze({
  UNKNOWN: 0,             // the unit's reply to a command it does not know
  REBOOT: 3,              // payload "clean": reboot into the update system
  NETWORK_MODE: 59,       // switch the USB gadget from serial to RNDIS
  FIND_DEVICE: 60,
  REMOTE_UPGRADE: 114,
  FILE_START: 115,
  FILE_DATA: 116,
  FILE_END: 117,
  UPGRADE_STATUS: 118,
});

const CMD_NAME = Object.fromEntries(Object.entries(CMD).map(([k, v]) => [v, k]));
export const cmdName = (c) => CMD_NAME[c] ?? `cmd ${c}`;

// ------------------------------------------------------------------ frames --
// 36-byte little-endian header, then the payload:
//   u32 magic "OTRA"  u16 version 3292  u16 type (1 request, 2 ack)
//   u16 msgid 0  u16 0xABCD  u32 command  u16 format 2  u16 userid 0
//   u32 length  u32 seq  u32 retry  u32 crc32
// crc32 is the standard CRC-32 over the header with this field zeroed, then
// over the payload. Replies echo the request's seq.

export const HEADER_LEN = 36;
const MAGIC = 0x4152544f;
const VERSION = 3292;
const TYPE_REQUEST = 1;
const FORMAT_BINARY = 2;
const UNUSED = 0xabcd;
const MAX_REPLY = 64 * 1024;   // replies are a few hundred bytes; the unit's side takes 1 MiB chunks
const EMPTY = new Uint8Array(0);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

// crc32(b, crc32(a)) == crc32(a + b)
export function crc32(bytes, crc = 0) {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function encodeFrame({ cmd, seq, retry = 0, payload = EMPTY, type = TYPE_REQUEST }) {
  const f = new Uint8Array(HEADER_LEN + payload.length);
  const v = new DataView(f.buffer);
  v.setUint32(0, MAGIC, true);
  v.setUint16(4, VERSION, true);
  v.setUint16(6, type, true);
  v.setUint16(10, UNUSED, true);
  v.setUint32(12, cmd, true);
  v.setUint16(16, FORMAT_BINARY, true);
  v.setUint32(20, payload.length, true);
  v.setUint32(24, seq >>> 0, true);
  v.setUint32(28, retry, true);
  f.set(payload, HEADER_LEN);
  v.setUint32(32, crc32(f), true);
  return f;
}

// Splits a byte stream into frames. Bytes before a magic are skipped (and
// counted), a header with an absurd length is skipped, and the CRC is checked
// but a bad one only marks the frame: the PC tool does not check it at all.
export class FrameParser {
  constructor({ maxPayload = MAX_REPLY } = {}) {
    this.maxPayload = maxPayload;
    this.reset();
  }

  reset() {
    this.buf = EMPTY;
    this.skipped = 0;
  }

  push(bytes) {
    const b = new Uint8Array(this.buf.length + bytes.length);
    b.set(this.buf);
    b.set(bytes, this.buf.length);
    const frames = [];
    let i = 0;
    for (;;) {
      const m = findMagic(b, i);
      if (m < 0) {
        const keep = Math.max(i, b.length - 3);   // a magic may straddle reads
        this.skipped += keep - i;
        i = keep;
        break;
      }
      this.skipped += m - i;
      i = m;
      if (b.length - i < HEADER_LEN) break;
      const v = new DataView(b.buffer, b.byteOffset + i, HEADER_LEN);
      const len = v.getUint32(20, true);
      if (len > this.maxPayload) {
        i += 1;
        this.skipped += 1;
        continue;
      }
      if (b.length - i < HEADER_LEN + len) break;
      const head = b.slice(i, i + HEADER_LEN);
      const payload = b.slice(i + HEADER_LEN, i + HEADER_LEN + len);
      const crc = v.getUint32(32, true);
      head.fill(0, 32, 36);
      frames.push({
        type: v.getUint16(6, true),
        cmd: v.getUint32(12, true),
        seq: v.getUint32(24, true),
        retry: v.getUint32(28, true),
        payload,
        crcOk: crc32(payload, crc32(head)) === crc,
      });
      i += HEADER_LEN + len;
    }
    this.buf = b.slice(i);
    return frames;
  }
}

function findMagic(b, from) {
  for (let i = from; i + 4 <= b.length; i++) {
    if (b[i] === 0x4f && b[i + 1] === 0x54 && b[i + 2] === 0x52 && b[i + 3] === 0x41) return i;
  }
  return -1;
}

// ---------------------------------------------------------------- payloads --

const te = new TextEncoder();
const td = new TextDecoder();

function cstr(p, off, len) {
  const s = p.subarray(Math.min(off, p.length), Math.min(off + len, p.length));
  const z = s.indexOf(0);
  return td.decode(z < 0 ? s : s.subarray(0, z));
}

function i32(p, off) {
  if (p.length < off + 4) return undefined;
  return new DataView(p.buffer, p.byteOffset + off, 4).getInt32(0, true);
}

function putCstr(p, off, len, s) {
  const b = te.encode(s);
  if (b.length >= len) throw new Error(`"${s}" is too long (max ${len - 1} bytes)`);
  p.set(b, off);
}

// FIND_DEVICE reply (ResDeviceInfo in the PC tool)
export function parseDeviceInfo(p) {
  return {
    maxChunk: i32(p, 0),
    sdk: cstr(p, 4, 32),
    name: cstr(p, 36, 64),
    cpuTemp: i32(p, 100),
    firmware: cstr(p, 104, 64),
    serial: cstr(p, 168, 32),
    hardware: cstr(p, 200, 32),
    status: i32(p, 232),
    detail: cstr(p, 236, 64),
  };
}

// FILE_DATA / FILE_END reply (ResFileDataInfo)
export function parseFileAck(p) {
  return {
    length: i32(p, 0),
    cursize: i32(p, 4),
    totalsize: i32(p, 8),
    status: i32(p, 12),
    detail: cstr(p, 16, 64),
  };
}

// UPGRADE_STATUS reply (ResUpgradeStatus)
export function parseUpgradeStatus(p) {
  return { percent: i32(p, 0), status: i32(p, 4), detail: cstr(p, 8, 64) };
}

// FILE_START payload (ArFileInfo): md5 as lowercase hex in a 64-byte field,
// i32 length, i32 saveAsFile = 1, char[128] path on the unit, char[128] the
// host's path (the PC tool sends its local path with '/' separators).
export function encodeFileStart({ md5hex, length, remotePath, localPath }) {
  const p = new Uint8Array(64 + 4 + 4 + 128 + 128);
  const v = new DataView(p.buffer);
  putCstr(p, 0, 64, md5hex);
  v.setInt32(64, length, true);
  v.setInt32(68, 1, true);
  putCstr(p, 72, 128, remotePath);
  putCstr(p, 200, 128, localPath);
  return p;
}

export function rebootPayload(mode) {
  const p = new Uint8Array(32);
  putCstr(p, 0, 32, mode);
  return p;
}

// --------------------------------------------------------------------- md5 --
// The unit wants the file's MD5, and WebCrypto has none.

const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Int32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);

function md5Block(st, x, v, off) {
  for (let i = 0; i < 16; i++) x[i] = v.getInt32(off + 4 * i, true);
  let a = st[0], b = st[1], c = st[2], d = st[3];
  for (let i = 0; i < 64; i++) {
    let f, g;
    if (i < 16) { f = (b & c) | (~b & d); g = i; }
    else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
    else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
    else { f = c ^ (b | ~d); g = (7 * i) & 15; }
    const s = MD5_S[((i >> 4) << 2) | (i & 3)];
    const sum = (a + f + MD5_K[i] + x[g]) | 0;
    a = d; d = c; c = b;
    b = (b + ((sum << s) | (sum >>> (32 - s)))) | 0;
  }
  st[0] = (st[0] + a) | 0; st[1] = (st[1] + b) | 0;
  st[2] = (st[2] + c) | 0; st[3] = (st[3] + d) | 0;
}

export function md5hex(bytes) {
  const st = Int32Array.of(0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476);
  const x = new Int32Array(16);
  const n = bytes.length;
  const full = n - (n % 64);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let off = 0; off < full; off += 64) md5Block(st, x, v, off);
  const tail = new Uint8Array(n % 64 < 56 ? 64 : 128);
  tail.set(bytes.subarray(full));
  tail[n % 64] = 0x80;
  const tv = new DataView(tail.buffer);
  tv.setUint32(tail.length - 8, (n * 8) % 2 ** 32, true);
  tv.setUint32(tail.length - 4, Math.floor((n * 8) / 2 ** 32), true);
  for (let off = 0; off < tail.length; off += 64) md5Block(st, x, tv, off);
  const out = new Uint8Array(st.buffer);
  return Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ----------------------------------------------------------- ASW images --
// ASW firmware container. Air-unit (board 3, "H_Sky") header:
//   0x00 "ASW\0"  0x04 board  0x08/0x0c/0x10 version major/minor/patch
//   0x14 5 x {u8 id, u8 flags[3], u32 alloc, u32 file offset}
//   0x70 CRC-32 of bytes 0x80..EOF  0x74 total size
// Ground images (boards 1 and 5) use another layout and are not handled here.

export const BOARD_NAMES = { 1: 'Ascent VRX (L_Gnd)', 3: 'Ascent air unit (H_Sky)', 5: 'Ascent Goggles (G_Gnd)' };
export const AIR_PRODUCT = 'Ascent_H_Sky';
const SECTION_NAMES = { 0: 'boot', 1: 'env', 2: 'kernel', 4: 'rootfs', 5: 'fpv' };
// NAND partitions from the stock env's mtdparts. The section table's "alloc"
// is not a limit: stock's own kernel is longer than its alloc.
const PART_SIZE = { 2: 4 << 20, 4: 16 << 20, 5: 32 << 20 };

export function parseAsw(bytes, fileName = '') {
  const errors = [];
  const warnings = [];
  const r = { errors, warnings, sections: [] };
  if (bytes.length < 0x80 || td.decode(bytes.subarray(0, 4)) !== 'ASW\0') {
    errors.push('Not a firmware image this page knows (no ASW header).');
    return r;
  }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  r.board = v.getUint32(4, true);
  r.boardName = BOARD_NAMES[r.board] ?? `unknown board ${r.board}`;
  r.version = [v.getUint32(8, true), v.getUint32(12, true), v.getUint32(16, true)];
  r.versionText = r.version.join('.');
  if (r.board !== 3) {
    errors.push(`This image is for the ${r.boardName}, which this page cannot flash yet.`);
    return r;
  }
  r.sizeStored = v.getUint32(0x74, true);
  r.crcStored = v.getUint32(0x70, true);
  r.crcCalc = crc32(bytes.subarray(0x80));
  if (r.sizeStored !== bytes.length) {
    errors.push(`The file is ${bytes.length} bytes but its header says ${r.sizeStored}: truncated or damaged.`);
  }
  if (r.crcStored !== r.crcCalc) errors.push('Checksum mismatch: the file is damaged.');

  for (let i = 0; i < 5; i++) {
    const o = 0x14 + 12 * i;
    r.sections.push({
      id: bytes[o],
      name: SECTION_NAMES[bytes[o]] ?? `id${bytes[o]}`,
      upgrade: bytes[o + 1] === 1,
      alloc: v.getUint32(o + 4, true),
      offset: v.getUint32(o + 8, true),
    });
  }
  r.sections.forEach((s, i) => {
    const end = i + 1 < r.sections.length ? r.sections[i + 1].offset : bytes.length;
    s.length = end - s.offset;
    if (s.offset < 0x80 || s.length < 0 || end > bytes.length) {
      errors.push(`Section ${s.name} lies outside the file.`);
    } else if (PART_SIZE[s.id] && s.length > PART_SIZE[s.id]) {
      errors.push(`Section ${s.name} (${s.length} bytes) does not fit its ${PART_SIZE[s.id] >> 20} MiB partition.`);
    }
  });

  // The unit takes the version from the file name and looks for
  // Ascent_H_Sky_*.img, so the file goes over under its canonical name.
  r.remoteName = `${AIR_PRODUCT}_${r.version.join('_')}.img`;
  const m = /(\d+)_(\d+)_(\d+)\.img$/i.exec(fileName);
  if (fileName && !m) {
    warnings.push(`The file name has no version; it will be sent as ${r.remoteName}.`);
  } else if (m && m.slice(1).join('.') !== r.versionText) {
    warnings.push(`The file name says ${m.slice(1).join('.')} but the image is ${r.versionText}; it will be sent as ${r.remoteName}.`);
  }
  return r;
}

// "Ascent_H_Sky_18_21_10" -> [18, 21, 10]; the unit's FIND_DEVICE firmware field
export function firmwareVersion(fw) {
  const m = /(\d+)_(\d+)_(\d+)$/.exec(fw ?? '');
  return m ? m.slice(1).map(Number) : null;
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// ----------------------------------------------------------------- session --

export class LinkLostError extends Error {
  constructor(msg = 'The unit disconnected.') { super(msg); this.name = 'LinkLostError'; }
}
export class TimeoutError extends Error {
  constructor(msg) { super(msg); this.name = 'TimeoutError'; }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function withTimeout(promise, ms, msg) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new TimeoutError(msg)), ms); }),
  ]).finally(() => clearTimeout(t));
}

// Request/reply over a link. A reply matches on command and seq. A resend gets
// a new seq (as the PC tool does), and a late reply to any earlier attempt
// still counts.
export class Session {
  constructor(link, log = () => {}) {
    this.link = link;
    this.log = log;
    this.parser = new FrameParser();
    this.seq = 1;
    this.waiters = new Set();
    this.crcWarned = false;
    this.attach(link);
  }

  attach(link) {
    this.link = link;
    link.onBytes = (b) => this.#feed(b);
    link.onClose = () => {
      for (const w of this.waiters) w.fail(new LinkLostError());
    };
  }

  reset() { this.parser.reset(); }

  #feed(bytes) {
    const before = this.parser.skipped;
    for (const f of this.parser.push(bytes)) {
      if (!f.crcOk && !this.crcWarned) {
        this.crcWarned = true;
        this.log(`reply ${cmdName(f.cmd)} has a CRC that does not match (accepted, as the PC tool does)`, 'warn');
      }
      let taken = false;
      for (const w of this.waiters) if (w.match(f)) { w.deliver(f); taken = true; }
      if (!taken) this.log(`ignored ${cmdName(f.cmd)} seq ${f.seq}`, 'debug');
    }
    if (this.parser.skipped > before) {
      this.log(`skipped ${this.parser.skipped - before} bytes that were not frames`, 'debug');
    }
  }

  #waiter(match) {
    let hit = null, err = null, wake = null;
    const w = {
      match,
      deliver: (f) => { if (!hit) { hit = f; wake?.(); } },
      fail: (e) => { err = e; wake?.(); },
    };
    this.waiters.add(w);
    return {
      next: (ms) => new Promise((resolve, reject) => {
        let t;
        const done = () => {
          clearTimeout(t);
          wake = null;
          if (hit) resolve(hit); else if (err) reject(err); else resolve(null);
        };
        if (hit || err) return done();
        wake = done;
        t = setTimeout(done, Math.max(0, ms));
      }),
      cancel: () => this.waiters.delete(w),
    };
  }

  // retryMs 0 = send once and wait the whole timeout.
  async request(cmd, payload = EMPTY, { expect = cmd, timeoutMs = 8000, retryMs = 2000 } = {}) {
    const seqs = new Set();
    const waiter = this.#waiter((f) => seqs.has(f.seq) && (f.cmd === expect || f.cmd === CMD.UNKNOWN));
    const deadline = Date.now() + timeoutMs;
    try {
      for (let attempt = 0; ; attempt++) {
        const seq = this.seq;
        this.seq = (this.seq + 1) >>> 0;
        seqs.add(seq);
        if (attempt > 0) this.log(`no reply to ${cmdName(cmd)}, sending it again (${attempt})`, 'warn');
        try {
          await this.link.write(encodeFrame({ cmd, seq, retry: attempt, payload }));
        } catch (e) {
          throw new LinkLostError(`Writing to the unit failed: ${e.message}`);
        }
        const left = deadline - Date.now();
        const f = await waiter.next(retryMs > 0 ? Math.min(retryMs, left) : left);
        if (f) {
          if (f.cmd === CMD.UNKNOWN && expect !== CMD.UNKNOWN) {
            throw new Error(`The unit does not know ${cmdName(cmd)}.`);
          }
          return f;
        }
        if (Date.now() >= deadline) throw new TimeoutError(`The unit did not answer ${cmdName(cmd)}.`);
      }
    } finally {
      waiter.cancel();
    }
  }

  async deviceInfo({ timeoutMs = 6000 } = {}) {
    const f = await this.request(CMD.FIND_DEVICE, EMPTY, { timeoutMs, retryMs: 1500 });
    return parseDeviceInfo(f.payload);
  }
}

// ------------------------------------------------------------------- flash --

export function deviceKind(info) {
  const s = `${info?.firmware ?? ''} ${info?.name ?? ''}`;
  if (/sky/i.test(s)) return 'air';
  if (/gnd|goggle|vrx/i.test(s)) return 'ground';
  return 'unknown';
}

// image: { bytes, remoteName, md5 (hex), localName }
// progress({stage, frac, text}); stages: clean, upload, install, restart, done
export async function flashImage(session, image, { progress = () => {}, log = () => {}, signal, dataTimeoutMs = 30000 } = {}) {
  const link = session.link;
  const step = (stage, frac, text) => progress({ stage, frac, text });
  const checkAbort = () => { if (signal?.aborted) throw new Error('Cancelled.'); };

  step('clean', 0.01, 'Rebooting the unit into update mode');
  try {
    await session.request(CMD.REBOOT, rebootPayload('clean'), { timeoutMs: 8000, retryMs: 2000 });
    log('unit accepted the reboot into update mode');
  } catch (e) {
    // gone before its ack reached us: it is rebooting
    if (!(e instanceof LinkLostError)) throw e;
    log('unit went away before acknowledging the reboot', 'warn');
  }
  step('clean', 0.02, 'Waiting for the unit to restart');
  await withTimeout(link.closed, 30000, 'The unit did not restart.');
  session.reset();
  step('clean', 0.03, 'Waiting for the unit to come back in update mode');
  await link.reopen({ timeoutMs: 90000, signal });
  session.attach(link);
  log('unit is back');
  await sleep(200);
  checkAbort();

  step('clean', 0.06, 'Starting the update');
  await session.request(CMD.REMOTE_UPGRADE, EMPTY, { timeoutMs: 30000, retryMs: 2000 });

  const total = image.bytes.length;
  const remotePath = `/tmp/pc/${image.remoteName}`;
  step('upload', 0.08, 'Sending the firmware');
  log(`file ${remotePath}, ${total} bytes, md5 ${image.md5}`);
  await session.request(CMD.FILE_START, encodeFileStart({
    md5hex: image.md5,
    length: total,
    remotePath,
    localPath: `/fpvos-flasher/${image.remoteName}`,
  }), { timeoutMs: 8000, retryMs: 2000 });
  await sleep(100);

  const chunk = image.chunkSize ?? 1 << 20;
  for (let off = 0; off < total; off += chunk) {
    checkAbort();
    const part = image.bytes.subarray(off, Math.min(off + chunk, total));
    // Never resent: the unit appends what it gets, and a duplicate chunk
    // would only fail the MD5 check at the end.
    const f = await session.request(CMD.FILE_DATA, part, { timeoutMs: dataTimeoutMs, retryMs: 0 });
    const ack = parseFileAck(f.payload);
    const sent = off + part.length;
    log(`chunk ${off / chunk + 1}: unit has ${ack.cursize}/${ack.totalsize}, status ${ack.status} ${ack.detail}`, 'debug');
    step('upload', 0.08 + 0.72 * (sent / total), `Sending the firmware (${Math.round((100 * sent) / total)}%)`);
  }

  step('upload', 0.8, 'Unit is checking the file');
  const end = parseFileAck((await session.request(CMD.FILE_END, EMPTY, { timeoutMs: 30000, retryMs: 5000 })).payload);
  log(`file end: status ${end.status}, "${end.detail}"`);
  if (end.status !== 0 || end.detail !== 'OK') {
    throw new Error(`The unit rejected the file: ${end.detail || `status ${end.status}`}`);
  }

  // From here on the unit writes flash on its own; leaving now is not harmful
  // but the result would be unknown.
  step('install', 0.82, 'Writing the firmware to flash');
  const started = Date.now();
  let last = '';
  let percent = -1;
  for (;;) {
    let s;
    try {
      await sleep(500);
      s = parseUpgradeStatus((await session.request(CMD.UPGRADE_STATUS, EMPTY, { timeoutMs: 8000, retryMs: 2000 })).payload);
    } catch (e) {
      if (e instanceof LinkLostError && percent >= 90) {
        log(`unit restarted at ${percent}%`, 'warn');
        break;
      }
      throw e;
    }
    const now = `${s.percent}% status ${s.status} ${s.detail}`;
    if (now !== last) { log(`install: ${now}`); last = now; }
    percent = s.percent;
    if (s.percent > 99) break;
    if (/fail|error|err\b/i.test(s.detail)) throw new Error(`The unit reports: ${s.detail}`);
    if (Date.now() - started > 10 * 60 * 1000) throw new TimeoutError('The install did not finish within 10 minutes.');
    step('install', 0.82 + 0.16 * Math.max(0, Math.min(99, s.percent)) / 100,
      `Writing the firmware to flash (${Math.max(0, s.percent)}%)`);
  }

  step('restart', 0.98, 'Unit is restarting');
  let after = null;
  try {
    await withTimeout(link.closed, 30000, 'The unit did not restart after the update.');
    session.reset();
    await link.reopen({ timeoutMs: 120000, signal, quiet: true });
    session.attach(link);
    await sleep(500);
    after = await session.deviceInfo({ timeoutMs: 15000 });
    log(`unit reports firmware "${after.firmware}"`);
  } catch (e) {
    log(`could not read the unit after the update: ${e.message}`, 'warn');
  }
  step('done', 1, 'Done');
  return after;
}
