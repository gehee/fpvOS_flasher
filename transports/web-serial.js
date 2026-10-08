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

  async reopen({ timeoutMs = 90000, signal } = {}) {
    await this.close();
    const start = Date.now();
    let picked = null, asked = false;
    for (;;) {
      if (signal?.aborted) throw new Error('Cancelled.');
      const waited = Date.now() - start;
      if (!asked && this.onNeedPort && waited > 10000) {
        asked = true;
        this.onNeedPort().then((p) => { picked = p; });
      }
      if (waited > (asked ? Math.max(timeoutMs, 5 * 60000) : timeoutMs)) throw new Error('The device did not come back.');
      const ports = (await navigator.serial.getPorts()).filter((p) => this.acceptPort(p.getInfo()));
      for (const p of picked ? [picked, ...ports] : ports) {
        if (!this.acceptPort(p.getInfo())) continue;
        try {
          this.port = p;
          await this.open();
          if (asked) this.onPortBack?.();
          return;
        } catch { /* not up yet, or the old dead port */ }
      }
      await sleep(500);
    }
  }
}
