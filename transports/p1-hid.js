// Version-specific P1 U-Boot RAM transport. No NAND/flash commands are exposed.
import { crc32 } from '../checksum.js';
export const P1_STOCK_USB = Object.freeze({ usbVendorId: 0x1d6b, usbProductId: 0x0101 });
// Skyzone SteadyDigital stock Sirius serial (vs the P1's 0x0101); same Artosyn
// bootloader HID (P1_HID_FILTER) and v2 layout after the reboot packet.
export const STEADYDIGITAL_STOCK_USB = Object.freeze({ usbVendorId: 0x1d6b, usbProductId: 0x0210 });
export const P1_HID_FILTER = Object.freeze({ vendorId: 0x1d6b, productId: 0x0100, usagePage: 0xff00, usage: 1 });
const MAGIC = Uint8Array.of(4, 85, 255, 170, 65, 82, 84, 79);
// writeChunk: data bytes per write frame. shortCommands: U-Boot commands of at
// most 15 characters. The v1 loader (stock 1.0.44) takes 960-byte frames and
// long commands; the v2 loader (stock 2.x, the SteadyDigital's too) commits one
// 64-byte packet per frame (48 header + 15 data: larger frames corrupt the RAM
// image) and takes only short commands - as the fpvOS Recovery app drives it
// (first P1 2.1.2 runs, 2026-11-22).
const layouts = {
  v1: { magic: 0x2ffbf378, table: 0x2ffbf290, callback: 0x2ffbf330, command: 0x2ff65e98,
    callbacks: [0x2ff86448, 0, 0, 0, 0x2ff86788, 0x2ff86950, 0],
    fingerprints: [0x2ff86788, 0x2ff86950, 0x2ff65e98, 0x2ff85b50], writeChunk: 960, shortCommands: false },
  v2: { magic: 0x2febebd0, table: 0x2febeae8, callback: 0x2febeb88, command: 0x2fe651d8,
    callbacks: [0x2fe85898, 0, 0, 0, 0x2fe85bd8, 0x2fe85da0, 0],
    fingerprints: [0x2fe85bd8, 0x2fe85da0, 0x2fe651d8, 0x2fe84fa0], writeChunk: 15, shortCommands: true },
};
for (const layout of Object.values(layouts)) {
  Object.freeze(layout.callbacks); Object.freeze(layout.fingerprints); Object.freeze(layout);
}
const versions = Object.freeze({ '1.0.44': 'v1', '2.0.5': 'v2', '2.0.6': 'v2', '2.1.2': 'v2' });
export const P1_STOCK_VERSIONS = Object.freeze(Object.keys(versions));
// The bootloader found by probing rather than named: v1 first, v2 only once v1
// got no reply. A v1 probe on a v2 loader is known to be harmless (a 2.1.2 P1
// took four and stayed up, 2026-11-23); a v2 probe on a v1 loader has never
// been tried, and this order never sends one to a v1 loader that answers.
export const P1_AUTO = 'auto';
const AUTO_ORDER = Object.freeze(['v1', 'v2']);
const FAMILY = Object.freeze({ v1: 'stock 1.0.44', v2: 'stock 2.x' });
export function p1Bootloader(stockVersion) {
  if (stockVersion === P1_AUTO) return { id: P1_AUTO, layout: layouts[AUTO_ORDER[0]], candidates: AUTO_ORDER };
  if (!Object.hasOwn(versions, stockVersion)) throw new Error('Select a supported stock P1 firmware version.');
  const id = versions[stockVersion]; return { id, layout: layouts[id], candidates: [id] };
}
const SCRATCH = 0x24bff000;
// The P1 recovery's kernel line on the v2 loader, built from short variables
// (it takes 15-character commands): bootm hands the kernel U-Boot's bootargs,
// never its built-in command line. maxcpus=1 (the stock 2.x SPL parks CPU1
// where the DT's spin table does not expect it) and clk_ignore_unused (or the
// late clock cleanup stops the board once its USB gadget is up); then what the
// v1 boot sets in one line: the DTB and initrd kept where they were loaded, and
// a non-secure boot. Leaves a/r/f/n/s, which upload() and boot() use.
const P1_V2_BOOTARGS = Object.freeze([
  'set w console=', 'set y ttyS0,', 'set z 1152000', 'set k mem=128M',
  'set u rdinit=/', 'set v init', 'set m maxcpus=1', 'set p nr_cpus=1',
  'set q clk_igno', 'set t re_unused',
  'set x $w$y$z $k', 'set x $x $u$v', 'set x $x $m $p', 'set x $x $q$t',
  'set bootargs $x',
  'set H ffffffff', 'set H $H$H', 'set fdt_high $H',
  'set A setenv', 'set i initrd_hi', 'set c $A $i', 'set c ${c}gh $H', 'run c',
  'set B bootm_', 'set C boot_', 'set D mode', 'set E nosec',
  'set c $A $B$C', 'set c $c$D $E', 'run c',
]);
const PROBE_ATTEMPTS = 4;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const P1_RAM_FILES = Object.freeze({ 'kernel.img': [0x24400000, 6291456],
  'betafpv-p1-air.dtb': [0x22080000, 65536], 'recovery-initrd.img': [0x26000000, 65536] });
// Same RAM destinations; only the DTB file name differs for the SteadyDigital.
export const STEADYDIGITAL_RAM_FILES = Object.freeze({ 'kernel.img': [0x24400000, 6291456],
  'skyzone-steadydigital.dtb': [0x22080000, 65536], 'recovery-initrd.img': [0x26000000, 65536] });
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
export const sha256 = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((n) => n.toString(16).padStart(2, '0')).join('');
function cancelled(signal) { if (signal?.aborted) throw new Error('Preparation cancelled. Power-cycle the P1 before reconnecting.'); }
function deadline(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}
// Both AR9311 stock units take the same Sirius reboot packet on their own stock
// serial port; only the port's USB id (and the wording) differs.
export async function enterStockBootloader(port, usb, label, { signal } = {}) {
  const info = port.getInfo();
  if (info.usbVendorId !== usb.usbVendorId || info.usbProductId !== usb.usbProductId) throw new Error(`Select the stock ${label} Sirius serial port.`);
  let writer;
  try {
    cancelled(signal);
    await port.open({ baudRate: 115200 });
    writer = port.writable.getWriter();
    cancelled(signal);
    await deadline(writer.write(Uint8Array.of(0xaa, 5, 0, 0x1d, 0, 0, 0xcc, 0xeb, 0xaa)), 5000, `Stock ${label} did not accept the reboot command.`);
  } finally {
    writer?.releaseLock();
    try { await deadline(port.close(), 2000, 'Serial close timeout'); } catch { /* Reboot can disconnect the port. */ }
  }
}
export const enterP1Bootloader = (port, options) => enterStockBootloader(port, P1_STOCK_USB, 'P1', options);
export const enterSteadyDigitalBootloader = (port, options) => enterStockBootloader(port, STEADYDIGITAL_STOCK_USB, 'SteadyDigital', options);
export function p1Frame(kind, body, first = 4) {
  if (![4, 5, 6].includes(kind) || body.length > 960) throw new Error('Invalid P1 RAM command.');
  const p = new Uint8Array(48 + body.length), v = new DataView(p.buffer);
  p.set(MAGIC); p[0] = first;
  v.setUint32(16, p.length, true); v.setUint32(20, 1, true); p[28] = 1;
  v.setUint16(36, kind, true); v.setUint16(38, 12, true); v.setUint32(40, body.length, true); p.set(body, 48);
  return p;
}
function setup(tag, count, address) {
  const p = new Uint8Array(16), v = new DataView(p.buffer);
  p.set(new TextEncoder().encode(tag)); v.setUint32(4, count, true); v.setBigUint64(8, BigInt(address), true); return p;
}
export class P1HidRecovery {
  constructor(device, { stockVersion = '1.0.44', ramFiles = P1_RAM_FILES, readChunk = 16, writeChunk, signal, progress = () => {}, log = () => {}, readTimeout = 3000, commandPause = 200 } = {}) {
    const { layout, candidates } = p1Bootloader(stockVersion);
    this.layout = layout; this.candidates = candidates; this.bootloader = null; this.stockVersion = stockVersion;
    this.ramFiles = ramFiles; this.readChunk = readChunk; this.chunkOption = writeChunk;
    this.device = device; this.signal = signal; this.progress = progress; this.log = log; this.readTimeout = readTimeout; this.commandPause = commandPause;
    this.verified = false; this.commands = false; this.loaded = new Set(); this.pending = null;
    // A bounded trace of what the bootloader actually did, for a bug report from
    // any browser and OS: the log shows it when preparation fails.
    this.diag = []; this.reports = 0; this.stray = 0;
    this.onReport = (e) => {
      if (e.device && e.device !== device) return;
      this.reports++;
      if (!this.pending) this.stray++;
      if (this.reports <= 12) this.note(`recv report ${e.reportId}, ${e.data.byteLength} bytes${this.pending ? '' : ' (unrequested)'}`);
      const p = new Uint8Array(e.data.byteLength + 1); p[0] = e.reportId;
      p.set(new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength), 1); this.pending?.(p);
    };
    this.onDisconnect = (e) => { if (e.device === device) this.rejectRead?.(new Error('P1 USB bootloader disconnected.')); };
  }
  // Data bytes per write frame: the caller's, else the bootloader's own.
  get writeChunk() { return this.chunkOption ?? this.layout.writeChunk; }
  note(text) { if (this.diag.length < 200) this.diag.push(`${(Date.now() - (this.t0 ??= Date.now())).toString().padStart(6)} ms  ${text}`); }
  diagnostics() {
    return [`P1 HID diagnostics (${globalThis.navigator?.userAgent ?? 'unknown browser'})`, ...this.diag,
      `reports received: ${this.reports} (${this.stray} unrequested)`].join('\n');
  }
  async open() {
    const d = this.device;
    if (d.vendorId !== P1_HID_FILTER.vendorId || d.productId !== P1_HID_FILTER.productId || d.productName !== 'USB download gadget'
      || !d.collections.some((c) => c.usagePage === 0xff00 && c.usage === 1
        && c.inputReports.some((r) => r.reportId === 4) && c.outputReports.some((r) => r.reportId === 2))) {
      throw new Error('Select the P1 USB download gadget. This is not the supported bootloader interface.');
    }
    cancelled(this.signal);
    try { await d.open(); } catch { throw new Error('Cannot open the P1 bootloader. Close other updaters and check USB/HID access permissions.'); }
    this.note(`opened ${d.vendorId?.toString(16)}:${d.productId?.toString(16)} "${d.productName}", collections `
      + JSON.stringify(d.collections.map((c) => ({ page: c.usagePage?.toString(16), usage: c.usage,
        in: c.inputReports?.map((r) => r.reportId), out: c.outputReports?.map((r) => r.reportId) }))));
    d.addEventListener('inputreport', this.onReport);
    globalThis.navigator?.hid?.addEventListener('disconnect', this.onDisconnect);
  }
  async close() {
    this.rejectRead?.(new Error('P1 connection closed.'));
    this.device.removeEventListener('inputreport', this.onReport);
    globalThis.navigator?.hid?.removeEventListener('disconnect', this.onDisconnect);
    if (this.device.opened) { try { await this.device.close(); } catch { /* USB re-enumeration */ } }
  }
  async send(kind, body, first = 4) {
    cancelled(this.signal);
    const p = p1Frame(kind, body, first);
    await deadline(this.device.sendReport(first, p.subarray(1)), 5000, 'P1 USB transfer timed out. Power-cycle and retry preparation.');
  }
  readable(address, size) {
    const { table: TABLE, magic: MAGIC_ADDRESS, fingerprints: FINGERPRINTS } = this.layout;
    return Number.isInteger(address) && Number.isInteger(size) && size > 0 && (
      address >= TABLE && address + size <= MAGIC_ADDRESS + 8
      || FINGERPRINTS.some((a) => address >= a && address + size <= a + 64)
      || address === SCRATCH && size === 4
      || Object.values(this.ramFiles).some(([a, n]) => address >= a && address + size <= a + n));
  }
  async read(address, size, timeout = this.readTimeout) {
    if (!this.readable(address, size)) throw new Error('P1 read outside approved RAM windows.');
    const data = new Uint8Array(size);
    for (let offset = 0; offset < size;) {
      cancelled(this.signal);
      const count = Math.min(this.readChunk, size - offset);
      // Input report 4 is only 64 bytes. The protocol adds 48 bytes of headers.
      // readChunk is the data bytes per reply (P1: 16 → 64-byte report; the
      // SteadyDigital's bootloader answers 8 → 56-byte report).
      let finish, fail;
      const reply = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      reply.catch(() => {}); // A disconnect can reject while sendReport is still pending.
      this.pending = finish; this.rejectRead = fail;
      let p;
      try {
        await this.send(5, setup('ufgt', count, address + offset));
        try { p = await deadline(reply, timeout, 'No compatible P1 bootloader reply.'); } catch (e) { this.note(`read 0x${(address + offset).toString(16)} timed out after ${timeout} ms (${this.reports} reports so far)`); throw e; }
      } finally { this.pending = this.rejectRead = null; }
      const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
      if (p.length !== 48 + count || !equal(p.subarray(0, 8), MAGIC) || p[28] !== 1
        || v.getUint32(20, true) !== 1 || v.getUint32(24, true) !== 0
        || v.getUint16(36, true) !== 2 || v.getUint16(38, true) !== 12
        || v.getUint32(40, true) !== count || v.getUint32(44, true) !== 0) throw new Error('Malformed P1 RAM reply.');
      data.set(p.subarray(48), offset); offset += count;
    }
    return data;
  }
  // fingerprints: the policy for the one bootloader named, or (any) keyed by
  // id, { v1: [...], v2: [...] }, as the recovery manifest lists them.
  async identify(fingerprints) {
    const policy = (id) => Array.isArray(fingerprints) && this.candidates.length === 1 ? fingerprints : fingerprints?.[id];
    for (const id of this.candidates) {
      const f = policy(id), expected = layouts[id].fingerprints;
      if (!Array.isArray(f) || f.length !== expected.length
        || f.some((x, i) => x.address !== expected[i] || x.size !== 64 || !/^[a-f0-9]{64}$/.test(x.sha256))) throw new Error('Invalid bootloader fingerprint policy.');
    }
    // A fixed, one-byte RAM-only probe is necessary before Linux HID can deliver
    // replies. It changes a protocol constant, never an instruction or NAND.
    // Each candidate is probed in turn (v1 before v2, see P1_AUTO), the next
    // only once the last got no reply; fingerprints gate all later writes.
    // First, read-only: a loader adapted by an earlier try answers already.
    let found = null;
    for (const id of this.candidates) {
      this.layout = layouts[id];
      try { if (equal(await this.read(this.layout.magic, 8, 350), MAGIC)) { found = id; break; } } catch (e) { cancelled(this.signal); }
    }
    this.note(found ? `${found} bootloader already answers on report 4` : 'no reply yet; probing');
    for (const id of this.candidates) {
      if (found) break;
      this.layout = layouts[id];
      if (this.candidates.length > 1) this.note(`trying the ${id} (${FAMILY[id]}) bootloader`);
      if (await this.probe()) found = id;
    }
    if (!found) {
      const tried = this.candidates.map((id) => FAMILY[id]).join(' and ');
      throw new Error(`No compatible P1 bootloader reply after ${PROBE_ATTEMPTS} probes${this.candidates.length > 1 ? ' of each' : ''} (tried the ${tried} bootloader${this.candidates.length > 1 ? 's' : ''}; ${this.reports} reports seen). Quit the browser completely, power-cycle the unit (cut its external power too) and retry; if it still fails, copy the log into a bug report.`);
    }
    this.layout = layouts[found]; this.bootloader = found;
    const { table: TABLE, callback: CALLBACK, command: COMMAND } = this.layout;
    for (const f of policy(found)) {
      if (await sha256(await this.read(f.address, f.size)) !== f.sha256) throw new Error(`Unsupported P1 bootloader version for ${FAMILY[found]}: it answers like that one, but its code does not match; no firmware was written. Power-cycle the unit and check its stock version.`);
    }
    const table = await this.read(TABLE, 168), v = new DataView(table.buffer);
    for (let i = 0; i < 7; i++) {
      const expectedKind = i >= 4 ? i : 0;
      const pointer = v.getBigUint64(i * 24 + 16, true);
      const expected = this.layout.callbacks[i];
      if (v.getBigUint64(i * 24, true) !== BigInt(expectedKind) || v.getBigUint64(i * 24 + 8, true) !== 0n
        || pointer !== BigInt(expected) && !(i === 6 && pointer === BigInt(COMMAND))) throw new Error('Unrecognized P1 bootloader dispatch table; no firmware was written.');
    }
    this.verified = true;
    const callback = new Uint8Array(8); new DataView(callback.buffer).setBigUint64(0, BigInt(COMMAND), true);
    await this.write(CALLBACK, callback);
    if (!equal(await this.read(CALLBACK, 8), callback)) throw new Error('P1 RAM callback verification failed.');
    this.commands = true;
    this.log(`${this.candidates.length > 1 ? 'Detected and verified' : 'Verified'} the P1 ${FAMILY[found]} bootloader; enabled temporary RAM recovery commands.`);
  }
  // The probe for this.layout. Some hosts need it more than once, or the HID
  // handle reopened after it, before replies arrive: retry that, nothing more.
  // True once the loader answers at this layout's magic; false if it never does.
  async probe() {
    const MAGIC_ADDRESS = this.layout.magic;
    for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
      if (attempt === 3) {   // last resort: a fresh handle, same device, same probe
        this.note('reopening the HID handle');
        try { await this.device.close(); await sleep(300); await this.device.open(); } catch (e) { this.note(`reopen failed: ${e.message}`); }
      }
      await this.send(4, setup('uftr', 1, MAGIC_ADDRESS), 255);
      await this.send(4, Uint8Array.of(4), 255);
      this.note(`probe ${attempt}/${PROBE_ATTEMPTS} sent`);
      try {
        if (!equal(await this.read(MAGIC_ADDRESS, 8, attempt === 1 ? this.readTimeout : Math.min(this.readTimeout, 1500)), MAGIC)) throw new Error('Unsupported P1 bootloader. Power-cycle the unit.');
        return true;
      } catch (e) {
        if (!/No compatible/.test(e.message)) throw e;
        await sleep(200);
      }
    }
    return false;
  }
  async write(address, data) {
    const CALLBACK = this.layout.callback;
    if (!this.verified || !(address === CALLBACK && data.length === 8 || address === SCRATCH && data.length === 4
      || Object.values(this.ramFiles).some(([a, n]) => address === a && data.length > 0 && data.length <= n))) throw new Error('Unverified or out-of-range P1 RAM write.');
    await this.send(4, setup('uftr', data.length, address));
    for (let offset = 0; offset < data.length;) {
      // The vendor handler treats every 16-byte body as a transfer setup.
      // writeChunk is the data bytes per frame (P1: 960; the SteadyDigital's
      // bootloader only commits 8 per frame — a 56-byte report, like its reads).
      let count = Math.min(this.writeChunk, data.length - offset); if (count === 16) count = 8;
      await this.send(4, data.subarray(offset, offset + count)); offset += count;
      if (data.length > 1024) this.progress({ address, bytes: offset, total: data.length });
    }
  }
  async upload(name, bytes) {
    const policy = this.ramFiles[name];
    if (!this.commands || !policy || !bytes.length || bytes.length > policy[1]) throw new Error('Invalid P1 recovery image.');
    const [address] = policy;
    this.loaded.delete(name);
    await this.write(address, bytes);
    // U-Boot's crc32 command stores the result in network byte order.
    const expected = crc32(bytes), sentinel = new Uint8Array(4);
    new DataView(sentinel.buffer).setUint32(0, (expected ^ 0xffffffff) >>> 0);
    await this.write(SCRATCH, sentinel);
    if (this.layout.shortCommands) {
      for (const c of [`set a ${address.toString(16)}`, `set n ${bytes.length.toString(16)}`, `set s ${SCRATCH.toString(16)}`, 'crc32 $a $n $s']) await this.command(c);
    } else await this.send(6, new TextEncoder().encode(`crc32 ${address.toString(16)} ${bytes.length.toString(16)} ${SCRATCH.toString(16)}`));
    const result = await this.read(SCRATCH, 4);
    if (new DataView(result.buffer).getUint32(0) !== expected) throw new Error(`P1 ${name} RAM checksum mismatch; recovery will not boot.`);
    this.loaded.add(name); this.log(`Verified ${name} in P1 RAM (${bytes.length} bytes).`);
  }
  // One short U-Boot command (the v2 loader), given time to run before the next.
  async command(text) {
    if (!this.commands || text.length > 15) throw new Error(`Invalid P1 bootloader command: ${text}`);
    await this.send(6, new TextEncoder().encode(text)); await sleep(this.commandPause);
  }
  async boot() {
    if (!this.commands || Object.keys(this.ramFiles).some((name) => !this.loaded.has(name))) throw new Error('All P1 recovery images must be verified before boot.');
    if (this.layout.shortCommands) {
      for (const c of P1_V2_BOOTARGS) await this.command(c);
      for (const c of ['set a 24400000', 'set r 26000000', 'set f 22080000']) await this.command(c);
      await this.send(6, new TextEncoder().encode('bootm $a $r $f'));
      return;
    }
    await this.send(6, new TextEncoder().encode('setenv bootm_boot_mode nosec; setenv fdt_high ffffffffffffffff; setenv initrd_high ffffffffffffffff; bootm 24400000 26000000 22080000'));
  }
}
