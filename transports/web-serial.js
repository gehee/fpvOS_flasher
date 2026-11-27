// Browser link adapter. Device matching and protocol policy are supplied by
// the caller; this module only owns port/stream lifetime and reconnection.
import { LinkLostError, sleep } from './ascent.js';

export class WebSerialLink {
  constructor(port, { serial = { baudRate: 115200, bufferSize: 65536 }, acceptPort = () => true,
    filters = [], onNeedPort, onPortBack, log = () => {} } = {}) {
    this.port = port;
    this.serial = serial;
    this.acceptPort = acceptPort;
    this.filters = filters;
    this.onNeedPort = onNeedPort;
    this.onPortBack = onPortBack;
    this.log = log;
    this.onBytes = null;
    this.onClose = null;
    this.closed = Promise.resolve();
  }

  async open() {
    await this.port.open(this.serial);
    this.closing = false;
    this.writer = this.port.writable.getWriter();
    this.closed = new Promise((r) => { this.markClosed = r; });
    this.#readLoop();
  }

  async #readLoop() {
    try {
      while (this.port.readable && !this.closing) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value?.length) this.onBytes?.(value);
          }
        } catch (e) {
          if (!this.closing) this.log(`serial read: ${e.message}`, 'debug');
        } finally {
          try { this.reader.releaseLock(); } catch { /* already released */ }
        }
      }
    } finally {
      this.markClosed();
      this.onClose?.();
    }
  }

  async write(bytes) {
    if (!this.writer) throw new LinkLostError();
    await this.writer.write(bytes);
  }

  async close() {
    this.closing = true;
    try { await this.reader?.cancel(); } catch { /* gone */ }
    try { this.writer?.releaseLock(); } catch { /* pending write */ }
    this.writer = null;
    try { await this.port.close(); } catch { /* already closed */ }
    await this.closed;
  }

  async reopen({ timeoutMs = 90000, signal, filters, acceptPort, acceptDevice, requireSelection = false } = {}) {
    const originalPort = this.port;
    await this.close();
    if (filters) this.filters = filters;
    if (acceptPort) this.acceptPort = acceptPort;
    if (requireSelection && !this.onNeedPort) throw new Error('Explicit port selection is required.');
    const start = Date.now();
    let picked = null, asked = false;
    // What happens while waiting, for a bug report: each new failure once,
    // and where the wait stands every 15 s (debug lines: in the copied log).
    const id = (p) => { const i = p?.getInfo?.() ?? {}; return i.usbVendorId == null ? 'no USB id'
      : `${i.usbVendorId.toString(16).padStart(4, '0')}:${(i.usbProductId ?? 0).toString(16).padStart(4, '0')}`; };
    const seen = new Set();
    const once = (msg) => { if (!seen.has(msg)) { seen.add(msg); this.log(msg, 'debug'); } };
    let lastStatus = 0;
    for (;;) {
      if (signal?.aborted) throw new Error('Cancelled.');
      const waited = Date.now() - start;
      if (!asked && this.onNeedPort && (requireSelection || waited > 10000)) {
        asked = true;
        this.onNeedPort().then((p) => { picked = p; this.log(`reconnect: port picked, USB ${id(p)}`, 'debug'); });
      }
      if (waited > (asked ? Math.max(timeoutMs, 5 * 60000) : timeoutMs)) throw new Error('The device did not come back.');
      const allowed = requireSelection ? [] : await navigator.serial.getPorts();
      const ports = allowed.filter((p) => this.acceptPort(p.getInfo()));
      if (waited - lastStatus >= 15000) {
        lastStatus = waited;
        this.log(`reconnect: waiting ${Math.round(waited / 1000)} s; ports this page may open: ${allowed.map(id).join(', ') || 'none'}`
          + `${allowed.length !== ports.length ? ` (${ports.length} of them this unit's)` : ''}${picked ? `; picked ${id(picked)}` : asked ? '; waiting for a pick' : ''}`, 'debug');
      }
      if (picked && !this.acceptPort(picked.getInfo())) {
        this.log(`reconnect: the picked port (USB ${id(picked)}) is not this unit's kind; pick it again`, 'warn');
        picked = null; asked = false; continue;
      }
      // Prefer the exact authorized port. If it is unavailable and several
      // devices share USB IDs, require the chooser rather than guessing a unit.
      const candidates = picked ? [picked] : ports.includes(originalPort)
        ? [originalPort] : ports.length <= 1 ? ports : [];
      if (!picked && !candidates.length && ports.length > 1) once(`reconnect: ${ports.length} ports of this kind; waiting for a pick`);
      for (const p of candidates) {
        if (!this.acceptPort(p.getInfo())) continue;
        try {
          this.port = p;
          await this.open();
          if (acceptDevice && !await acceptDevice()) {
            once(`reconnect: USB ${id(p)} opened but is not the unit expected`);
            await this.close();
            if (picked === p) { picked = null; asked = false; }
            continue;
          }
          if (asked) this.onPortBack?.();
          this.log(`reconnect: opened USB ${id(p)} after ${Math.round((Date.now() - start) / 1000)} s`, 'debug');
          return;
        } catch (e) {
          once(`reconnect: USB ${id(p)}${p === originalPort ? ' (the port from before)' : p === picked ? ' (picked)' : ''} `
            + `did not open: ${e?.name ?? 'Error'}: ${e?.message ?? e}`);
          await this.close(); /* not up yet, or the old dead port */
        }
      }
      await sleep(500);
    }
  }
}
