// A fake navigator.serial with a simulated air unit behind it, injected into
// the page by browser-check.mjs before app.js runs. It mimics how Chrome
// behaves: a reboot errors the readable stream, fires "disconnect", and the
// unit comes back as a new SerialPort with a "connect" event.
//
// window.__fake = { regrant: false } makes the rebooted unit missing from
// getPorts(), as when Chrome does not keep the permission.

(() => {
  const VID = 0x1d76;
  const fake = window.__fake = Object.assign({ regrant: true, bootMs: 600, log: [] }, window.__fake || {});
  const serial = new EventTarget();
  let A = null;   // ascent.js, loaded on first use
  let granted = [];
  let device = null;

  function fire(type, port) {
    const ev = new Event(type);
    Object.defineProperty(ev, 'target', { value: port });
    serial.dispatchEvent(ev);
  }

  class FakePort extends EventTarget {
    constructor(dev) { super(); this.dev = dev; this.readable = null; this.writable = null; }

    getInfo() { return { usbVendorId: VID, usbProductId: 0x0101 }; }

    async open() {
      if (!this.dev.present || this.dev.port !== this) throw new DOMException('Failed to open serial port.', 'NetworkError');
      if (this.readable) throw new DOMException('The port is already open.', 'InvalidStateError');
      A = A || await import('/ascent.js');
      this.readable = new ReadableStream({ start: (c) => { this.ctrl = c; } });
      this.writable = new WritableStream({
        write: (chunk) => {
          if (!this.dev.present) throw new DOMException('The device has been lost.', 'NetworkError');
          this.dev.receive(chunk);
        },
      });
    }

    async close() {
      this.readable = null;
      this.writable = null;
    }

    lose() {
      try { this.ctrl?.error(new DOMException('The device has been lost.', 'NetworkError')); } catch { /* closed */ }
      this.readable = null;
      this.writable = null;
    }
  }

  class FakeUnit {
    constructor(mode) {
      this.mode = mode;
      this.present = true;
      this.port = new FakePort(this);
      this.parser = null;
      this.status = 0;
    }

    send(f, payload = new Uint8Array(0)) {
      const out = A.encodeFrame({ cmd: f.cmd, seq: f.seq, payload, type: 2 });
      setTimeout(() => { try { this.port.ctrl?.enqueue(out); } catch { /* lost */ } }, 2);
    }

    struct(size, fill) {
      const p = new Uint8Array(size);
      const v = new DataView(p.buffer);
      fill((off, n) => v.setInt32(off, n, true), (off, s) => p.set(new TextEncoder().encode(s), off));
      return p;
    }

    receive(bytes) {
      this.parser = this.parser || new A.FrameParser({ maxPayload: 4 << 20 });
      for (const f of this.parser.push(bytes)) {
        fake.log.push(`${this.mode} ${A.cmdName(f.cmd)} seq ${f.seq} crc ${f.crcOk}`);
        this.handle(f);
      }
    }

    handle(f) {
      const C = A.CMD;
      if (f.cmd === C.FIND_DEVICE) {
        return this.send(f, this.struct(300, (i32, str) => {
          i32(0, 1 << 20); str(4, 'v1.0'); str(36, 'Ascent_H_Sky'); i32(100, 51);
          str(104, 'Ascent_H_Sky_18_21_10'); str(168, 'FAKE0001'); str(200, 'HW_V1.0');
        }));
      }
      if (f.cmd === C.REBOOT) { this.send(f); return reboot(new TextDecoder().decode(f.payload).startsWith('clean') ? 'clean' : 'normal'); }
      if (f.cmd === C.REMOTE_UPGRADE) return this.mode === 'clean' ? this.send(f) : undefined;
      if (f.cmd === C.FILE_START) {
        const v = new DataView(f.payload.buffer, f.payload.byteOffset);
        this.file = { md5: new TextDecoder().decode(f.payload.subarray(0, 32)), length: v.getInt32(64, true), parts: [], got: 0 };
        fake.remotePath = new TextDecoder().decode(f.payload.subarray(72, 200)).replace(/\0.*$/s, '');
        return this.send(f);
      }
      if (f.cmd === C.FILE_DATA) {
        this.file.parts.push(f.payload);
        this.file.got += f.payload.length;
        return this.send(f, this.struct(80, (i32, str) => { i32(0, f.payload.length); i32(4, this.file.got); i32(8, this.file.length); i32(12, 0); str(16, 'OK'); }));
      }
      if (f.cmd === C.FILE_END) {
        const all = new Uint8Array(this.file.got);
        let o = 0;
        for (const p of this.file.parts) { all.set(p, o); o += p.length; }
        const ok = A.md5hex(all) === this.file.md5;
        fake.md5ok = ok;
        return this.send(f, this.struct(80, (i32, str) => { i32(12, ok ? 0 : -1); str(16, ok ? 'OK' : 'md5 fail'); }));
      }
      if (f.cmd === C.UPGRADE_STATUS) {
        this.status = Math.min(100, this.status + 25);
        this.send(f, this.struct(72, (i32, str) => { i32(0, this.status); str(8, 'WRITING'); }));
        if (this.status >= 100) setTimeout(() => reboot('normal'), 50);
        return undefined;
      }
      return this.send({ ...f, cmd: C.UNKNOWN });
    }
  }

  function reboot(mode) {
    setTimeout(() => {
      const old = device;
      old.present = false;
      old.port.lose();
      granted = granted.filter((p) => p !== old.port);
      fire('disconnect', old.port);
      setTimeout(() => {
        device = new FakeUnit(mode);
        fake.mode = mode;
        if (fake.regrant) {
          granted.push(device.port);
          fire('connect', device.port);
        }
      }, fake.bootMs);
    }, 20);
  }

  device = new FakeUnit('normal');
  granted = [device.port];
  fake.mode = 'normal';

  serial.getPorts = async () => granted.slice();
  serial.requestPort = async () => {
    fake.requested = (fake.requested || 0) + 1;
    if (!granted.includes(device.port)) granted.push(device.port);
    return device.port;
  };
  Object.defineProperty(navigator, 'serial', { value: serial, configurable: true });
})();
