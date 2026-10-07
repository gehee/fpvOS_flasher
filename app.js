// fpvOS Flasher: Web Serial glue and UI for ascent.js.

import {
  CMD, Session, LinkLostError, flashImage, parseAsw, md5hex, deviceKind,
  firmwareVersion, compareVersions, sleep,
} from './ascent.js';
import { openFirmware } from './archive.js';

// What the page can flash. One entry per kind of device: its USB id (the
// chooser offers only these), the file names it takes (to pick one out of an
// archive), and the models it covers, each listed on the page. Each kind's
// protocol lives in its own module (ascent.js today).
const DEVICES = [
  {
    models: ['Ascent Lite air unit', 'Ascent Lite+ air unit'],
    usbVendorId: 0x1d76,
    image: /^Ascent_H_Sky_\d+_\d+_\d+\.img$/i,
  },
];
const FILTERS = DEVICES.map(({ usbVendorId }) => ({ usbVendorId }));
const isOurs = (port) => DEVICES.some((d) => d.usbVendorId === port.getInfo().usbVendorId);

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------- link --

class WebSerialLink {
  constructor(port, { onNeedPort, onPortBack } = {}) {
    this.port = port;
    this.onNeedPort = onNeedPort;
    this.onPortBack = onPortBack;
    this.onBytes = null;
    this.onClose = null;
    this.closed = Promise.resolve();
  }

  async open() {
    await this.port.open({ baudRate: 115200, bufferSize: 1 << 16 });
    this.closing = false;
    this.writer = this.port.writable.getWriter();
    this.closed = new Promise((r) => { this.markClosed = r; });
    this.#readLoop();
  }

  async #readLoop() {
    try {
      // a non-fatal error (framing, overrun) replaces port.readable; a lost
      // device sets it to null
      while (this.port.readable && !this.closing) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value?.length) this.onBytes?.(value);
          }
        } catch (e) {
          if (!this.closing) log(`serial read: ${e.message}`, 'debug');
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

  // After a reboot the unit enumerates as a new USB device. Chrome normally
  // keeps the permission and lists it in getPorts(); if not, the user has to
  // pick it again, which needs a click: offer that after a while, and keep
  // looking meanwhile.
  async reopen({ timeoutMs = 90000, signal } = {}) {
    await this.close();
    const start = Date.now();
    let picked = null;
    let asked = false;
    for (;;) {
      if (signal?.aborted) throw new Error('Cancelled.');
      const waited = Date.now() - start;
      if (!asked && this.onNeedPort && waited > 10000) {
        asked = true;
        this.onNeedPort().then((p) => { picked = p; });
      }
      // once the user was asked, give them time to answer
      if (waited > (asked ? Math.max(timeoutMs, 5 * 60000) : timeoutMs)) {
        throw new Error('The device did not come back.');
      }
      const ports = (await navigator.serial.getPorts())
        .filter(isOurs);
      for (const p of picked ? [picked, ...ports] : ports) {
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

// ------------------------------------------------------------------ state --

const state = {
  link: null,
  session: null,
  info: null,
  image: null,       // { file, bytes, parsed, md5 }
  busy: false,
  flashed: null,     // result line after a flash
};

// -------------------------------------------------------------------- log --

const logLines = [];

function log(msg, level = 'info') {
  const l = { t: new Date().toISOString().slice(11, 23), level, msg };
  logLines.push(l);
  showLogLine(l);
}

function showLogLine(l) {
  if (l.level === 'debug' && !$('verbose').checked) return;
  const box = $('log');
  const line = document.createElement('div');
  line.className = `log-${l.level}`;
  line.textContent = `${l.t}  ${l.msg}`;
  box.append(line);
  box.scrollTop = box.scrollHeight;
}

function logText() {
  return logLines.map((l) => `${l.t} ${l.level.padEnd(5)} ${l.msg}`).join('\n');
}

// ------------------------------------------------------------------ unit --

async function connect() {
  let port;
  try {
    port = await navigator.serial.requestPort({ filters: FILTERS });
  } catch {
    return;   // chooser closed
  }
  await openPort(port);
}

async function openPort(port) {
  if (state.link || state.busy) return;
  const link = new WebSerialLink(port, {
    onNeedPort: askForPort,
    onPortBack: () => { $('reselect').hidden = true; portRequest = null; },
  });
  setUnitStatus('connecting', 'Connecting…');
  try {
    await link.open();
  } catch (e) {
    setUnitStatus('error', "Could not open the port. Is another program (the vendor's PC tool, a terminal) using it?");
    log(`open: ${e.message}`, 'error');
    return;
  }
  state.link = link;
  state.session = new Session(link, log);
  watchLink(link);
  try {
    state.info = await state.session.deviceInfo();
    log(`connected: ${state.info.firmware || state.info.name} (hw ${state.info.hardware}, sn ${state.info.serial})`);
    setUnitStatus('ok', 'Connected');
  } catch (e) {
    log(`no answer to FIND_DEVICE: ${e.message}`, 'error');
    setUnitStatus('error', 'The port opened but the device does not answer. Wait for it to finish booting, then reconnect.');
    await link.close();
    state.link = state.session = null;
  }
  render();
}

// closed is a new promise after every reopen, and a flash reopens on its own
function watchLink(link) {
  link.closed.then(() => {
    if (state.link === link && !state.busy) disconnected();
  });
}

function disconnected() {
  state.link = state.session = state.info = null;
  setUnitStatus('idle', 'Not connected');
  log('device disconnected');
  render();
}

async function disconnect() {
  const link = state.link;
  if (!link || state.busy) return;
  state.link = null;
  await link.close();
  disconnected();
}

let portRequest = null;

function askForPort() {
  $('reselect').hidden = false;
  log('the device has not reappeared yet; the browser may need it selected again', 'warn');
  return new Promise((resolve) => { portRequest = resolve; });
}

async function reselect() {
  try {
    const port = await navigator.serial.requestPort({ filters: FILTERS });
    $('reselect').hidden = true;
    portRequest?.(port);
    portRequest = null;
  } catch { /* chooser closed; keep the button */ }
}

function setUnitStatus(kind, text) {
  const s = $('unit-status');
  s.dataset.kind = kind;
  s.querySelector('span').textContent = text;
}

// --------------------------------------------------------------- firmware --

// An image as is, or the one inside a .zip / .xz / .gz / .tar.
async function loadFile(file) {
  if (!file || state.busy) return;
  state.flashed = null;
  const current = { file, loading: 'Opening' };
  state.image = current;
  render();
  let opened;
  try {
    opened = await openFirmware(file, {
      wanted: (n) => DEVICES.some((d) => d.image.test(n)),
      onProgress: (text) => {
        if (state.image !== current) return;
        current.loading = text;
        $('file-status').textContent = `${text}…`;
      },
    });
  } catch (e) {
    if (state.image !== current) return;
    state.image = { file, error: e.message };
    log(`file ${file.name}: ${e.message}`, 'error');
    render();
    return;
  }
  if (state.image !== current) return;   // another file was dropped meanwhile
  const { bytes, name, trail, notes } = opened;
  const parsed = parseAsw(bytes, name);
  const md5 = parsed.errors.length ? null : md5hex(bytes);
  state.image = { file, bytes, name, trail, notes, parsed, md5 };
  log(`file ${[...trail, name].join(' > ')}: ${bytes.length} bytes, ${parsed.boardName ?? 'not an image'} `
    + `${parsed.versionText ?? ''}${md5 ? `, md5 ${md5}` : ''}`);
  render();
}

// Problems from the image and the unit together: [{level, text}]
function checks() {
  const out = [];
  if (state.image?.error) out.push({ level: 'error', text: state.image.error });
  for (const n of state.image?.notes ?? []) out.push({ level: 'info', text: n });
  const img = state.image?.parsed;
  if (img) {
    for (const e of img.errors) out.push({ level: 'error', text: e });
    for (const w of img.warnings) out.push({ level: 'warn', text: w });
  }
  if (state.info) {
    const kind = deviceKind(state.info);
    if (kind === 'ground') out.push({ level: 'error', text: 'The connected device is a ground unit (goggles or VRX), and this image is for an air unit.' });
    if (kind === 'unknown') out.push({ level: 'warn', text: `Could not tell what the device is ("${state.info.firmware || state.info.name}").` });
    const have = firmwareVersion(state.info.firmware);
    if (img?.version && have && !img.errors.length) {
      const c = compareVersions(img.version, have);
      if (c < 0) out.push({ level: 'warn', text: `The image (${img.versionText}) is older than the device's ${have.join('.')}. The device may refuse it.` });
      if (c === 0) out.push({ level: 'info', text: `Same version number as the device (${have.join('.')}). fpvOS images keep the stock number, so this is normal.` });
    }
  }
  return out;
}

// ------------------------------------------------------------------ flash --

const STAGES = ['clean', 'upload', 'install', 'restart'];
let abort = null;

async function flash() {
  const img = state.image;
  if (!canFlash()) return;
  const ok = await ask(`Flash ${img.parsed.remoteName}?`,
    'The device writes its other flash bank and switches to it. Keep it powered and connected until it restarts. '
      + 'This flasher is experimental: use it at your own risk.',
    'Flash');
  if (!ok || !canFlash()) return;

  state.busy = true;
  state.flashed = null;
  abort = new AbortController();
  render();
  setProgress({ stage: 'clean', frac: 0, text: 'Starting' });
  const t0 = Date.now();
  try {
    const after = await flashImage(state.session, {
      bytes: img.bytes,
      md5: img.md5,
      remoteName: img.parsed.remoteName,
      chunkSize: chunkSize(),
    }, { progress: setProgress, log, signal: abort.signal });
    const secs = Math.round((Date.now() - t0) / 1000);
    state.flashed = { ok: true, text: after
      ? `Flashed in ${secs} s. The device now reports ${after.firmware || after.name}.`
      : `Flashed in ${secs} s. The device is restarting; reconnect to check it.` };
    if (after) state.info = after;
    log(state.flashed.text);
  } catch (e) {
    state.flashed = { ok: false, text: e.message };
    log(`flash failed: ${e.message}`, 'error');
    setProgress({ stage: 'failed', frac: null, text: 'Failed' });
  } finally {
    state.busy = false;
    abort = null;
    $('reselect').hidden = true;
    if (state.link?.writer) watchLink(state.link);
    else if (state.link) disconnected();
    render();
  }
}

function chunkSize() {
  const n = state.info?.maxChunk;
  return n > 0 ? Math.min(n, 1 << 20) : 1 << 20;
}

function canFlash() {
  return !!(state.session && state.info && state.image?.md5 && !state.busy
    && !checks().some((c) => c.level === 'error'));
}

let currentStage = null;

function setProgress({ stage, frac, text }) {
  currentStage = stage;
  if (frac != null) $('bar').style.width = `${(frac * 100).toFixed(1)}%`;
  $('bar').dataset.state = stage === 'failed' ? 'failed' : stage === 'done' ? 'done' : 'run';
  $('stage-text').textContent = text;
  $('cancel').hidden = !state.busy || !['clean', 'upload'].includes(stage);
  const idx = STAGES.indexOf(stage);
  document.querySelectorAll('#stages li').forEach((li, i) => {
    li.dataset.state = stage === 'done' || i < idx ? 'done' : i === idx ? 'active' : '';
  });
}

async function networkMode() {
  if (!state.session || state.busy) return;
  if (!await ask('Switch to network mode?', 'The device leaves serial mode until it reboots, and this page loses it.', 'Switch')) return;
  try {
    await state.session.request(CMD.NETWORK_MODE, undefined, { timeoutMs: 3000, retryMs: 0 });
  } catch (e) {
    if (!(e instanceof LinkLostError)) log(`network mode: ${e.message}`, 'warn');
  }
  log('asked the device to switch to network mode');
}

function ask(title, text, okLabel) {
  const d = $('ask');
  $('ask-title').textContent = title;
  $('ask-text').textContent = text;
  $('ask-ok').textContent = okLabel;
  d.returnValue = '';
  d.showModal();
  return new Promise((resolve) => {
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true });
  });
}

// ----------------------------------------------------------------- render --

const fmtBytes = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(2)} MiB` : `${(n / 1024).toFixed(1)} KiB`);
const hex = (n) => `0x${n.toString(16).padStart(8, '0')}`;

function render() {
  const supported = 'serial' in navigator;
  $('unsupported').hidden = supported;
  if (!supported && !window.isSecureContext) {
    $('unsupported').textContent = `Chrome only allows USB serial on https:// pages and on localhost, and this page `
      + `was opened from ${location.origin}. Open it as http://localhost on the computer that serves it, or in `
      + `chrome://flags enable "Insecure origins treated as secure" for ${location.origin}, then relaunch Chrome.`;
  }

  // unit
  const info = state.info;
  $('connect').hidden = !!state.link;
  $('connect').disabled = !supported || state.busy;
  $('disconnect').hidden = !state.link;
  $('disconnect').disabled = state.busy;
  $('netmode').disabled = !state.session || state.busy;
  $('unit-info').hidden = !info;
  if (info) {
    const rows = [
      ['Firmware', info.firmware],
      ['Device', info.name],
      ['Hardware', info.hardware],
      ['Serial', info.serial],
      ['SDK', info.sdk],
      ['CPU temperature', info.cpuTemp != null ? `${info.cpuTemp} °C` : ''],
      ['Max chunk', info.maxChunk ? fmtBytes(info.maxChunk) : ''],
    ].filter(([, v]) => v);
    $('unit-info').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', k), el('dd', v)]));
  }

  // firmware
  const img = state.image;
  $('drop').classList.toggle('loaded', !!img);
  $('file-info').hidden = !img;
  $('file-status').hidden = !img?.loading;
  $('file-status').textContent = img?.loading ? `${img.loading}…` : '';
  const p = img?.parsed;
  $('file-meta').hidden = !p;
  $('sections').hidden = !p?.sections.length;
  if (img) $('file-name').textContent = img.name ?? img.file.name;
  if (p) {
    const rows = [
      ['From', img.trail.length ? img.trail.join(' › ') : ''],
      ['Image', p.boardName ?? 'unknown'],
      ['Version', p.versionText ?? ''],
      ['Size', fmtBytes(img.bytes.length)],
      ['Checksum', p.crcStored != null ? (p.crcStored === p.crcCalc ? `OK · ${hex(p.crcCalc)}` : `bad: ${hex(p.crcStored)} in header, file is ${hex(p.crcCalc)}`) : '',
        p.crcStored === p.crcCalc ? 'good' : ''],
      ['MD5', img.md5 ?? ''],
      ['Sent as', p.remoteName ?? ''],
    ].filter(([, v]) => v);
    $('file-meta').replaceChildren(...rows.flatMap(([k, v, cls]) => [el('dt', k), el('dd', v, cls)]));
    $('sections').querySelector('tbody').replaceChildren(...p.sections.map((s) => {
      const tr = document.createElement('tr');
      tr.append(el('td', s.name), el('td', fmtBytes(s.length), 'num'), el('td', `0x${s.offset.toString(16)}`, 'num'), el('td', s.upgrade ? 'yes' : 'no'));
      return tr;
    }));
  }

  // checks
  const cs = checks();
  $('checks').replaceChildren(...cs.map((c) => {
    const li = el('li', c.text);
    li.dataset.level = c.level;
    return li;
  }));
  $('checks').hidden = !cs.length;

  // flash
  $('flash').disabled = !canFlash();
  $('flash').textContent = state.busy ? 'Flashing…' : 'Flash';
  $('cancel').hidden = !state.busy || !['clean', 'upload'].includes(currentStage);
  $('progress').hidden = !state.busy && !state.flashed;
  $('result').hidden = !state.flashed;
  if (state.flashed) {
    $('result').dataset.ok = state.flashed.ok;
    $('result').textContent = state.flashed.text;
  }
  $('hint').textContent = !state.link ? 'Connect a device first.'
    : !img ? 'Choose a firmware image.'
    : img.loading ? 'Unpacking the firmware.'
    : cs.some((c) => c.level === 'error') ? 'Fix the problems above first.'
    : '';
}

function el(tag, text, cls) {
  const e = document.createElement(tag);
  e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

// ------------------------------------------------------------------ wiring --

function init() {
  $('devices').replaceChildren(...DEVICES.flatMap((d) => d.models).map((m) => el('li', m)));
  render();
  if (!('serial' in navigator)) return;

  $('connect').onclick = connect;
  $('disconnect').onclick = disconnect;
  $('netmode').onclick = networkMode;
  $('reselect').onclick = reselect;
  $('flash').onclick = flash;
  $('cancel').onclick = () => { abort?.abort(); log('cancelling after the current step', 'warn'); };
  $('file').onchange = (e) => loadFile(e.target.files[0]);
  $('verbose').onchange = () => {
    $('log').replaceChildren();
    logLines.forEach(showLogLine);
  };
  $('copy-log').onclick = () => navigator.clipboard.writeText(logText());
  $('save-log').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([logText()], { type: 'text/plain' }));
    a.download = `fpvos-flasher-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const drop = $('drop');
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    loadFile(e.dataTransfer.files[0]);
  };

  window.addEventListener('beforeunload', (e) => { if (state.busy) e.preventDefault(); });

  // plug in = connect, for a unit this page was allowed before
  navigator.serial.addEventListener('connect', (e) => {
    if (!state.busy && isOurs(e.target)) openPort(e.target);
  });
  navigator.serial.getPorts().then((ports) => {
    const p = ports.find(isOurs);
    if (p) openPort(p);
  });
}

init();
