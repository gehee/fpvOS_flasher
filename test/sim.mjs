// A fake air unit behind a fake link, for the Node tests. It plays the
// updater's side as the PC tool expects it; what the real unit does beyond
// that is unknown, so keep this simple.

import { createHash } from 'node:crypto';
import {
  CMD, FrameParser, encodeFrame, parseDeviceInfo, sleep,
} from '../ascent.js';

const te = new TextEncoder();
const td = new TextDecoder();

function struct(size, fill) {
  const p = new Uint8Array(size);
  const v = new DataView(p.buffer);
  fill({
    i32: (off, n) => v.setInt32(off, n, true),
    str: (off, s) => p.set(te.encode(s), off),
  });
  return p;
}

export class SimUnit {
  constructor(opts = {}) {
    this.opts = {
      firmware: 'Ascent_H_Sky_18_21_10',
      bootMs: 50,
      installSteps: 5,
      dropReply: new Set(),      // commands whose first reply is lost
      junk: false,               // send noise before replies
      split: 0,                  // deliver replies in pieces of this size
      badMd5: false,
      ...opts,
    };
    this.mode = 'normal';
    this.present = true;
    this.link = null;
    this.parser = new FrameParser({ maxPayload: 4 << 20 });
    this.file = null;
    this.received = [];          // commands seen
    this.status = 0;
  }

  receive(bytes) {
    for (const f of this.parser.push(bytes)) {
      if (!f.crcOk) throw new Error(`sim: bad CRC from host on ${f.cmd}`);
      this.received.push(f.cmd);
      this.handle(f);
    }
  }

  reply(f, payload = new Uint8Array(0)) {
    if (this.opts.dropReply.has(f.cmd)) {
      this.opts.dropReply.delete(f.cmd);
      return;
    }
    let out = encodeFrame({ cmd: f.cmd, seq: f.seq, payload, type: 2 });
    if (this.opts.junk) out = Uint8Array.from([...te.encode('junk\n'), ...out]);
    const link = this.link;
    const n = this.opts.split || out.length;
    setTimeout(async () => {
      for (let i = 0; i < out.length; i += n) {
        link?.deliver(out.slice(i, i + n));
        await sleep(0);
      }
    }, 1);
  }

  handle(f) {
    switch (f.cmd) {
      case CMD.FIND_DEVICE:
        return this.reply(f, struct(300, ({ i32, str }) => {
          i32(0, 1 << 20);
          str(4, 'v1.0');
          str(36, 'Ascent_H_Sky');
          i32(100, 48);
          str(104, this.opts.firmware);
          str(168, 'SIM0001');
          str(200, 'HW_V1.0');
        }));
      case CMD.REBOOT: {
        this.reply(f);
        const mode = td.decode(f.payload).replace(/\0+$/, '');
        return this.reboot(mode === 'clean' ? 'clean' : 'normal');
      }
      case CMD.REMOTE_UPGRADE:
        if (this.mode !== 'clean') return undefined;   // assumption: silent outside clean mode
        return this.reply(f);
      case CMD.FILE_START: {
        const p = f.payload;
        const v = new DataView(p.buffer, p.byteOffset);
        const s = (off, len) => td.decode(p.subarray(off, off + len)).replace(/\0.*$/s, '');
        this.file = { md5: s(0, 64), length: v.getInt32(64, true), path: s(72, 128), local: s(200, 128), chunks: [] };
        return this.reply(f);
      }
      case CMD.FILE_DATA: {
        this.file.chunks.push(f.payload);
        const cur = this.file.chunks.reduce((n, c) => n + c.length, 0);
        return this.reply(f, struct(80, ({ i32, str }) => {
          i32(0, f.payload.length); i32(4, cur); i32(8, this.file.length); i32(12, 0); str(16, 'OK');
        }));
      }
      case CMD.FILE_END: {
        const data = Buffer.concat(this.file.chunks);
        this.file.data = data;
        const md5 = createHash('md5').update(data).digest('hex');
        const ok = !this.opts.badMd5 && md5 === this.file.md5 && data.length === this.file.length;
        return this.reply(f, struct(80, ({ i32, str }) => {
          i32(8, data.length); i32(12, ok ? 0 : -1); str(16, ok ? 'OK' : 'md5 check fail');
        }));
      }
      case CMD.UPGRADE_STATUS: {
        this.status = Math.min(100, this.status + Math.ceil(100 / this.opts.installSteps));
        this.reply(f, struct(72, ({ i32, str }) => { i32(0, this.status); str(8, this.status >= 100 ? 'SUCCESS' : 'WRITING'); }));
        if (this.status >= 100) setTimeout(() => this.reboot('normal'), 20);
        return undefined;
      }
      default:
        return this.reply({ ...f, cmd: CMD.UNKNOWN });
    }
  }

  reboot(mode) {
    setTimeout(() => {
      this.present = false;
      this.link?.lost();
      setTimeout(() => { this.mode = mode; this.present = true; }, this.opts.bootMs);
    }, 10);
  }
}

export class SimLink {
  constructor(unit) {
    this.unit = unit;
    this.onBytes = null;
    this.onClose = null;
    this.closed = Promise.resolve();
    this.isOpen = false;
  }

  async open() {
    if (!this.unit.present) throw new Error('sim: no device');
    this.isOpen = true;
    this.unit.link = this;
    this.unit.parser.reset();
    this.closed = new Promise((r) => { this.markClosed = r; });
  }

  deliver(bytes) { if (this.isOpen) this.onBytes?.(bytes); }

  lost() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.markClosed();
    this.onClose?.();
  }

  async write(bytes) {
    if (!this.isOpen) throw new Error('sim: port closed');
    this.unit.receive(bytes);
  }

  async close() { this.lost(); }

  async reopen({ timeoutMs = 5000 } = {}) {
    await this.close();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { return await this.open(); } catch { await sleep(10); }
    }
    throw new Error('sim: the unit did not come back');
  }
}

export { parseDeviceInfo };
