// .xz decompression: the container (streams, blocks, index, padding, CRC-32 /
// CRC-64 / SHA-256 checks) and the LZMA2 filter, which is all `xz` writes by
// default. Other filters (BCJ, delta) are refused. Written from the .xz file
// format specification and the LZMA reference decoder (LzmaSpec.cpp).

import { crc32, crc64 } from './checksum.js';

export class XzError extends Error {
  constructor(msg) { super(`xz: ${msg}`); this.name = 'XzError'; }
}

const MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];
const CHECK_SIZE = [0, 4, 4, 4, 8, 8, 8, 16, 16, 16, 32, 32, 32, 64, 64, 64];
const CHECK_NONE = 0, CHECK_CRC32 = 1, CHECK_CRC64 = 4, CHECK_SHA256 = 10;
const FILTER_LZMA2 = 0x21;

export const isXz = (b) => b.length >= 6 && MAGIC.every((m, i) => b[i] === m);

const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const nextTask = () => new Promise((r) => setTimeout(r, 0));

class Output {
  constructor(size, limit) {
    this.buf = new Uint8Array(Math.max(1 << 16, size));
    this.pos = 0;
    this.limit = limit;
  }

  ensure(n) {
    const need = this.pos + n;
    if (need <= this.buf.length) return;
    if (need > this.limit) throw new XzError(`more than ${this.limit} bytes`);
    const b = new Uint8Array(Math.min(this.limit, Math.max(need, this.buf.length * 2)));
    b.set(this.buf.subarray(0, this.pos));
    this.buf = b;
  }
}

// --------------------------------------------------------------- container --

// onProgress(fraction of the input read); limit caps the output size.
export async function unxz(input, { onProgress, limit = 1 << 30 } = {}) {
  const out = new Output(Math.min(limit, input.length * 3), limit);
  let pos = 0;
  let streams = 0;
  while (pos < input.length) {
    if (streams > 0) {
      // stream padding: null bytes, a multiple of four
      const start = pos;
      while (pos < input.length && input[pos] === 0) pos++;
      if ((pos - start) % 4) throw new XzError('bad stream padding');
      if (pos === input.length) break;
    }
    pos = await decodeStream(input, pos, out, onProgress);
    streams++;
  }
  if (!streams) throw new XzError('empty input');
  return out.buf.slice(0, out.pos);
}

async function decodeStream(b, start, out, onProgress) {
  if (start + 12 > b.length || !MAGIC.every((m, i) => b[start + i] === m)) throw new XzError('not an xz stream');
  const flags = b.subarray(start + 6, start + 8);
  if (crc32(flags) !== u32(b, start + 8)) throw new XzError('stream header is damaged');
  if (flags[0] !== 0 || flags[1] & 0xf0) throw new XzError('unsupported stream flags');
  const check = flags[1];
  if (![CHECK_NONE, CHECK_CRC32, CHECK_CRC64, CHECK_SHA256].includes(check)) throw new XzError(`unsupported check type ${check}`);
  const checkSize = CHECK_SIZE[check];

  let pos = start + 12;
  const records = [];
  while (pos < b.length && b[pos] !== 0x00) {
    const blockStart = pos;
    const outStart = out.pos;
    const hdr = parseBlockHeader(b, pos);
    pos += hdr.size;
    const lz = new Lzma2(out, hdr.dictSize);
    pos = await lz.decode(b, pos, (p) => onProgress?.(p / b.length));
    const compressed = pos - blockStart - hdr.size;
    if (hdr.compressed != null && hdr.compressed !== compressed) throw new XzError('block size does not match its header');
    if (hdr.uncompressed != null && hdr.uncompressed !== out.pos - outStart) throw new XzError('block length does not match its header');
    while ((pos - blockStart) % 4) {
      if (b[pos++] !== 0) throw new XzError('bad block padding');
    }
    if (pos + checkSize > b.length) throw new XzError('truncated');
    await verifyCheck(check, out.buf.subarray(outStart, out.pos), b.subarray(pos, pos + checkSize));
    pos += checkSize;
    records.push({ unpadded: hdr.size + compressed + checkSize, uncompressed: out.pos - outStart });
    onProgress?.(pos / b.length);
  }
  if (pos >= b.length) throw new XzError('truncated (no index)');

  // index
  const indexStart = pos;
  pos++;
  const vli = () => { const r = readVli(b, pos); pos = r.pos; return r.value; };
  const count = vli();
  if (count !== records.length) throw new XzError('index does not match the blocks');
  for (const rec of records) {
    if (vli() !== rec.unpadded || vli() !== rec.uncompressed) throw new XzError('index does not match the blocks');
  }
  while ((pos - indexStart) % 4) {
    if (b[pos++] !== 0) throw new XzError('bad index padding');
  }
  if (crc32(b.subarray(indexStart, pos)) !== u32(b, pos)) throw new XzError('index is damaged');
  pos += 4;

  // footer
  if (pos + 12 > b.length) throw new XzError('truncated (no footer)');
  if (crc32(b.subarray(pos + 4, pos + 10)) !== u32(b, pos)) throw new XzError('stream footer is damaged');
  if ((u32(b, pos + 4) + 1) * 4 !== pos - indexStart) throw new XzError('stream footer does not match the index');
  if (b[pos + 8] !== flags[0] || b[pos + 9] !== flags[1]) throw new XzError('stream footer flags differ from the header');
  if (b[pos + 10] !== 0x59 || b[pos + 11] !== 0x5a) throw new XzError('no stream footer magic');
  return pos + 12;
}

function readVli(b, pos) {
  let value = 0, mul = 1;
  for (let i = 0; i < 9; i++) {
    if (pos >= b.length) throw new XzError('truncated');
    const byte = b[pos++];
    value += (byte & 0x7f) * mul;
    if (!(byte & 0x80)) {
      if (i > 0 && byte === 0) throw new XzError('bad number encoding');
      return { value, pos };
    }
    mul *= 128;
  }
  throw new XzError('bad number encoding');
}

function parseBlockHeader(b, pos) {
  const size = (b[pos] + 1) * 4;
  if (pos + size > b.length) throw new XzError('truncated');
  const h = b.subarray(pos, pos + size);
  if (crc32(h.subarray(0, size - 4)) !== u32(h, size - 4)) throw new XzError('block header is damaged');
  const flags = h[1];
  if (flags & 0x3c) throw new XzError('unsupported block flags');
  let p = 2;
  const vli = () => { const r = readVli(h, p); p = r.pos; return r.value; };
  const compressed = flags & 0x40 ? vli() : null;
  const uncompressed = flags & 0x80 ? vli() : null;
  const filters = (flags & 3) + 1;
  let dictSize = null;
  for (let i = 0; i < filters; i++) {
    const id = vli();
    const propSize = vli();
    if (id !== FILTER_LZMA2 || propSize !== 1 || filters !== 1) {
      throw new XzError(`filter 0x${id.toString(16)} is not supported (only plain LZMA2)`);
    }
    const d = h[p++];
    if (d > 40) throw new XzError('bad dictionary size');
    dictSize = d === 40 ? 0xffffffff : (2 | (d & 1)) * 2 ** ((d >> 1) + 11);
  }
  for (; p < size - 4; p++) if (h[p] !== 0) throw new XzError('bad block header padding');
  return { size, compressed, uncompressed, dictSize };
}

async function verifyCheck(type, data, stored) {
  let ok = true;
  if (type === CHECK_CRC32) ok = crc32(data) === u32(stored, 0);
  else if (type === CHECK_CRC64) ok = crc64(data).every((x, i) => x === stored[i]);
  else if (type === CHECK_SHA256) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    ok = d.every((x, i) => x === stored[i]);
  }
  if (!ok) throw new XzError('check failed: the data is damaged');
}

// ------------------------------------------------------------------- LZMA2 --

const PROB_INIT = 1024;
const STATES = 12;
const POS_BITS_MAX = 4;
const END_POS_MODEL = 14;
const FULL_DISTANCES = 128;
const ALIGN_BITS = 4;
const MATCH_MIN = 2;

function lenCoder() {
  return {
    choice: new Uint16Array(2),
    low: new Uint16Array(16 << 3),
    mid: new Uint16Array(16 << 3),
    high: new Uint16Array(256),
  };
}

class Lzma2 {
  constructor(out, dictSize) {
    this.out = out;
    this.dictSize = dictSize;
    this.dictStart = 0;
    this.needDictReset = true;
    this.needProps = true;
    this.isMatch = new Uint16Array(STATES << POS_BITS_MAX);
    this.isRep = new Uint16Array(STATES);
    this.isRepG0 = new Uint16Array(STATES);
    this.isRepG1 = new Uint16Array(STATES);
    this.isRepG2 = new Uint16Array(STATES);
    this.isRep0Long = new Uint16Array(STATES << POS_BITS_MAX);
    this.posSlot = new Uint16Array(4 << 6);
    this.posDec = new Uint16Array(1 + FULL_DISTANCES - END_POS_MODEL);
    this.align = new Uint16Array(1 << ALIGN_BITS);
    this.matchLen = lenCoder();
    this.repLen = lenCoder();
    this.lit = null;
  }

  async decode(b, pos, tick) {
    const out = this.out;
    let sinceYield = 0;
    for (;;) {
      if (pos >= b.length) throw new XzError('truncated');
      const control = b[pos++];
      if (control === 0x00) return pos;

      if (control >= 0xe0 || control === 0x01) {
        this.needProps = true;
        this.needDictReset = false;
        this.dictStart = out.pos;
      } else if (this.needDictReset) {
        throw new XzError('LZMA2 data does not start with a dictionary reset');
      }

      if (control >= 0x80) {
        if (pos + 4 > b.length) throw new XzError('truncated');
        const unpacked = (control & 0x1f) * 65536 + b[pos] * 256 + b[pos + 1] + 1;
        const packed = b[pos + 2] * 256 + b[pos + 3] + 1;
        pos += 4;
        if (control >= 0xc0) {
          this.setProps(b[pos++]);
          this.needProps = false;
          this.resetState();
        } else if (this.needProps) {
          throw new XzError('LZMA2 chunk without properties');
        } else if (control >= 0xa0) {
          this.resetState();
        }
        if (pos + packed > b.length) throw new XzError('truncated');
        this.chunk(b, pos, packed, unpacked);
        pos += packed;
        sinceYield += unpacked;
      } else {
        if (control > 0x02) throw new XzError('bad LZMA2 control byte');
        if (pos + 2 > b.length) throw new XzError('truncated');
        const size = b[pos] * 256 + b[pos + 1] + 1;
        pos += 2;
        if (pos + size > b.length) throw new XzError('truncated');
        out.ensure(size);
        out.buf.set(b.subarray(pos, pos + size), out.pos);
        out.pos += size;
        pos += size;
        sinceYield += size;
      }
      // keep the page responsive on big files
      if (sinceYield >= 1 << 21) {
        sinceYield = 0;
        tick?.(pos);
        await nextTask();
      }
    }
  }

  setProps(d) {
    if (d > 224) throw new XzError('bad LZMA properties');
    this.lc = d % 9;
    d = Math.floor(d / 9);
    this.lp = d % 5;
    this.pb = Math.floor(d / 5);
    if (this.lc + this.lp > 4) throw new XzError('bad LZMA properties');
    this.lit = new Uint16Array(0x300 << (this.lc + this.lp));
  }

  resetState() {
    this.state = 0;
    this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
    for (const a of [this.isMatch, this.isRep, this.isRepG0, this.isRepG1, this.isRepG2, this.isRep0Long,
      this.posSlot, this.posDec, this.align, this.lit,
      this.matchLen.choice, this.matchLen.low, this.matchLen.mid, this.matchLen.high,
      this.repLen.choice, this.repLen.low, this.repLen.mid, this.repLen.high]) a.fill(PROB_INIT);
  }

  // ---- range decoder ----

  bit(probs, i) {
    const p = probs[i];
    const bound = (this.range >>> 11) * p;
    let bit;
    if (this.code < bound) {
      this.range = bound;
      probs[i] = p + ((2048 - p) >>> 5);
      bit = 0;
    } else {
      this.range -= bound;
      this.code -= bound;
      probs[i] = p - (p >>> 5);
      bit = 1;
    }
    if (this.range < 0x1000000) {
      if (this.inPos >= this.inEnd) throw new XzError('LZMA chunk overrun');
      this.range *= 256;
      this.code = this.code * 256 + this.in[this.inPos++];
    }
    return bit;
  }

  direct(n) {
    let r = 0;
    for (; n > 0; n--) {
      this.range = this.range >>> 1;
      let bit = 0;
      if (this.code >= this.range) { this.code -= this.range; bit = 1; }
      r = r * 2 + bit;
      if (this.range < 0x1000000) {
        if (this.inPos >= this.inEnd) throw new XzError('LZMA chunk overrun');
        this.range *= 256;
        this.code = this.code * 256 + this.in[this.inPos++];
      }
    }
    return r;
  }

  tree(probs, base, n) {
    let m = 1;
    for (let i = 0; i < n; i++) m = (m << 1) | this.bit(probs, base + m);
    return m - (1 << n);
  }

  reverse(probs, base, n) {
    let m = 1, sym = 0;
    for (let i = 0; i < n; i++) {
      const bit = this.bit(probs, base + m);
      m = (m << 1) + bit;
      sym |= bit << i;
    }
    return sym;
  }

  len(c, posState) {
    if (this.bit(c.choice, 0) === 0) return this.tree(c.low, posState << 3, 3);
    if (this.bit(c.choice, 1) === 0) return 8 + this.tree(c.mid, posState << 3, 3);
    return 16 + this.tree(c.high, 0, 8);
  }

  distance(len) {
    const slot = this.tree(this.posSlot, (len < 3 ? len : 3) << 6, 6);
    if (slot < 4) return slot;
    const nd = (slot >>> 1) - 1;
    let dist = (2 | (slot & 1)) * 2 ** nd;
    if (slot < END_POS_MODEL) {
      dist += this.reverse(this.posDec, dist - slot, nd);
    } else {
      dist += this.direct(nd - ALIGN_BITS) * 16;
      dist += this.reverse(this.align, 0, ALIGN_BITS);
    }
    return dist;
  }

  // ---- one LZMA chunk ----

  chunk(b, pos, packed, unpacked) {
    if (packed < 5 || b[pos] !== 0) throw new XzError('bad LZMA chunk start');
    this.in = b;
    this.inEnd = pos + packed;
    this.code = ((b[pos + 1] * 256 + b[pos + 2]) * 256 + b[pos + 3]) * 256 + b[pos + 4];
    this.range = 0xffffffff;
    this.inPos = pos + 5;

    const out = this.out;
    out.ensure(unpacked);
    const buf = out.buf;
    let op = out.pos;
    const end = op + unpacked;
    const ds = this.dictStart;
    const pbMask = (1 << this.pb) - 1;
    const lpMask = (1 << this.lp) - 1;
    const lc = this.lc;
    let state = this.state;
    let rep0 = this.rep0, rep1 = this.rep1, rep2 = this.rep2, rep3 = this.rep3;

    while (op < end) {
      const posState = (op - ds) & pbMask;
      if (this.bit(this.isMatch, (state << POS_BITS_MAX) + posState) === 0) {
        const prev = op > ds ? buf[op - 1] : 0;
        const base = 0x300 * ((((op - ds) & lpMask) << lc) + (prev >>> (8 - lc)));
        const lit = this.lit;
        let sym = 1;
        if (state >= 7) {
          let mb = buf[op - rep0 - 1];
          do {
            const m = (mb >>> 7) & 1;
            mb <<= 1;
            const bit = this.bit(lit, base + ((1 + m) << 8) + sym);
            sym = (sym << 1) | bit;
            if (m !== bit) break;
          } while (sym < 0x100);
        }
        while (sym < 0x100) sym = (sym << 1) | this.bit(lit, base + sym);
        buf[op++] = sym - 0x100;
        state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
        continue;
      }

      let len;
      if (this.bit(this.isRep, state) === 1) {
        if (op === ds) throw new XzError('LZMA repeat with nothing before it');
        if (this.bit(this.isRepG0, state) === 0) {
          if (this.bit(this.isRep0Long, (state << POS_BITS_MAX) + posState) === 0) {
            state = state < 7 ? 9 : 11;
            buf[op] = buf[op - rep0 - 1];
            op++;
            continue;
          }
        } else {
          let dist;
          if (this.bit(this.isRepG1, state) === 0) {
            dist = rep1;
          } else {
            if (this.bit(this.isRepG2, state) === 0) {
              dist = rep2;
            } else {
              dist = rep3;
              rep3 = rep2;
            }
            rep2 = rep1;
          }
          rep1 = rep0;
          rep0 = dist;
        }
        len = this.len(this.repLen, posState);
        state = state < 7 ? 8 : 11;
      } else {
        rep3 = rep2;
        rep2 = rep1;
        rep1 = rep0;
        len = this.len(this.matchLen, posState);
        state = state < 7 ? 7 : 10;
        rep0 = this.distance(len);
        if (rep0 === 0xffffffff) throw new XzError('LZMA end marker inside LZMA2');
      }
      len += MATCH_MIN;
      if (rep0 >= op - ds || rep0 >= this.dictSize) throw new XzError('LZMA distance out of range');
      if (len > end - op) throw new XzError('LZMA match past the chunk');
      const src = op - rep0 - 1;
      if (rep0 + 1 >= len) {
        buf.copyWithin(op, src, src + len);
        op += len;
      } else {
        for (let i = 0; i < len; i++) buf[op + i] = buf[src + i];
        op += len;
      }
    }

    if (this.inPos !== this.inEnd || this.code !== 0) throw new XzError('LZMA chunk does not end cleanly');
    out.pos = op;
    this.state = state;
    this.rep0 = rep0; this.rep1 = rep1; this.rep2 = rep2; this.rep3 = rep3;
  }
}
