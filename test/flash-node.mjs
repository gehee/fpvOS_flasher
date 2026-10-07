#!/usr/bin/env node
// Drive ascent.js against a real unit from Linux, without a browser:
//   node test/flash-node.mjs info
//   node test/flash-node.mjs flash Ascent_H_Sky_18_21_10.img
// The port is found by USB vendor id (1d76, Artosyn).

import fs from 'node:fs';
import path from 'node:path';
import tty from 'node:tty';
import { execFileSync } from 'node:child_process';
import { Session, flashImage, parseAsw, md5hex, sleep } from '../ascent.js';

const VID = '1d76';

function findTty() {
  for (const n of fs.readdirSync('/sys/class/tty').filter((x) => x.startsWith('ttyACM'))) {
    try {
      const usbDev = path.dirname(fs.realpathSync(`/sys/class/tty/${n}/device`));
      if (fs.readFileSync(`${usbDev}/idVendor`, 'utf8').trim() === VID) return `/dev/${n}`;
    } catch { /* not usb */ }
  }
  return null;
}

class NodeLink {
  constructor() {
    this.onBytes = null;
    this.onClose = null;
    this.closed = Promise.resolve();
  }

  async open() {
    const dev = findTty();
    if (!dev) throw new Error('no 1d76 serial port');
    // raw and no echo before anything arrives, or the tty echoes the
    // unit's replies back to it
    execFileSync('stty', ['-F', dev, 'raw', '-echo', '-echoe', '-echok', '-echoctl', '-echoke', '-hupcl', '115200']);
    this.dev = dev;
    this.wfd = fs.openSync(dev, fs.constants.O_WRONLY | fs.constants.O_NOCTTY);
    const rfd = fs.openSync(dev, fs.constants.O_RDONLY | fs.constants.O_NOCTTY);
    this.rs = new tty.ReadStream(rfd);
    this.rs.setRawMode(true);
    this.closed = new Promise((r) => { this.markClosed = r; });
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      this.markClosed();
      this.onClose?.();
    };
    this.rs.on('data', (b) => this.onBytes?.(new Uint8Array(b)));
    this.rs.on('error', end);
    this.rs.on('end', end);
    this.rs.on('close', end);
    console.error(`[link] opened ${dev}`);
  }

  async write(bytes) {
    let off = 0;
    while (off < bytes.length) {
      off += await new Promise((res, rej) => fs.write(this.wfd, bytes, off, bytes.length - off, null,
        (e, n) => (e ? rej(e) : res(n))));
    }
  }

  async close() {
    try { this.rs?.destroy(); } catch { /* gone */ }
    try { if (this.wfd != null) fs.closeSync(this.wfd); } catch { /* gone */ }
    this.wfd = null;
    await this.closed;
  }

  async reopen({ timeoutMs = 90000 } = {}) {
    await this.close();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { return await this.open(); } catch { await sleep(500); }
    }
    throw new Error('the unit did not come back');
  }
}

const log = (m, level = 'info') => console.log(`${new Date().toISOString().slice(11, 23)} ${level.padEnd(5)} ${m}`);

async function main() {
  const [cmd, file] = process.argv.slice(2);
  const link = new NodeLink();
  await link.open();
  const session = new Session(link, log);
  const info = await session.deviceInfo();
  console.log(JSON.stringify(info, null, 2));
  if (cmd === 'flash') {
    const bytes = new Uint8Array(fs.readFileSync(file));
    const parsed = parseAsw(bytes, path.basename(file));
    if (parsed.errors.length) throw new Error(parsed.errors.join(' '));
    parsed.warnings.forEach((w) => log(w, 'warn'));
    const t0 = Date.now();
    let lastText = '';
    const after = await flashImage(session, {
      bytes, md5: md5hex(bytes), remoteName: parsed.remoteName,
      chunkSize: info.maxChunk > 0 ? Math.min(info.maxChunk, 1 << 20) : 1 << 20,
    }, {
      log,
      progress: ({ frac, text }) => { if (text !== lastText) { lastText = text; log(`[${(frac * 100).toFixed(0)}%] ${text}`); } },
    });
    log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s; unit reports ${JSON.stringify(after)}`);
  }
  await link.close();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
