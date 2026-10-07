// CRC-32 (zip, gzip, xz, the Ascent frames and images) and CRC-64 (xz's
// default check), both the reflected ECMA forms everyone uses.

const CRC32_TABLE = (() => {
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
  for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// CRC-64/XZ, polynomial 0xC96C5795D7870F42 (reflected), kept as two 32-bit
// halves so it needs no BigInt in the loop.
const CRC64_LO = new Uint32Array(256);
const CRC64_HI = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let lo = n, hi = 0;
  for (let k = 0; k < 8; k++) {
    const odd = lo & 1;
    lo = ((lo >>> 1) | (hi << 31)) >>> 0;
    hi >>>= 1;
    if (odd) { lo = (lo ^ 0xd7870f42) >>> 0; hi = (hi ^ 0xc96c5795) >>> 0; }
  }
  CRC64_LO[n] = lo;
  CRC64_HI[n] = hi;
}

// The 8 bytes as xz stores them (little-endian).
export function crc64(bytes) {
  let lo = 0xffffffff, hi = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const t = (lo ^ bytes[i]) & 0xff;
    lo = (((lo >>> 8) | (hi << 24)) ^ CRC64_LO[t]) >>> 0;
    hi = ((hi >>> 8) ^ CRC64_HI[t]) >>> 0;
  }
  const out = new Uint8Array(8);
  const v = new DataView(out.buffer);
  v.setUint32(0, ~lo >>> 0, true);
  v.setUint32(4, ~hi >>> 0, true);
  return out;
}
