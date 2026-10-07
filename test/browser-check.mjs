#!/usr/bin/env node
// Runs the page in headless Chrome against fake-serial.js and flashes an
// image through the real UI, twice: once with the port permission kept across
// reboots, once with it lost (the "Select the unit again" path).
//   node test/browser-check.mjs IMG [OUTDIR]
// Needs google-chrome. Screenshots go to OUTDIR (default: a temp dir).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const img = path.resolve(process.argv[2] ?? '');
const out = process.argv[3] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'flasher-check-'));
if (!fs.existsSync(img)) { console.error('usage: browser-check.mjs IMG [OUTDIR]'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ static server --
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const f = p.endsWith('/') ? path.join(p, 'index.html') : p;
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

// ------------------------------------------------------------------ chrome --
const debugPort = 9300 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flasher-chrome-'));
const chrome = spawn('google-chrome', [
  '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1000,1400', 'about:blank',
], { stdio: 'ignore' });

let targets;
for (let i = 0; i < 50 && !targets; i++) {
  await sleep(200);
  try { targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json(); } catch { /* starting */ }
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let nextId = 0;
const pending = new Map();
const problems = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id) {
    const p = pending.get(d.id);
    pending.delete(d.id);
    if (d.error) p.rej(new Error(`${d.error.message}`)); else p.res(d.result);
  } else if (d.method === 'Runtime.exceptionThrown') {
    problems.push(`exception: ${d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text}`);
  } else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') {
    problems.push(`console.error: ${d.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  }
};
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const id = ++nextId;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const js = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${expr}: ${r.exceptionDetails.exception?.description}`);
  return r.result.value;
};
// Polls through errors: right after Page.navigate the old document (still
// "complete", without our elements) can answer first.
async function until(expr, ms, what) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    try {
      if (await js(expr)) return;
    } catch (e) {
      last = e;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what ?? expr}${last ? ` (${last.message})` : ''}`);
}
async function shot(name) {
  const { cssContentSize: s } = await cdp('Page.getLayoutMetrics');
  const { data } = await cdp('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: Math.ceil(s.width), height: Math.ceil(s.height), scale: 1 },
  });
  fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(data, 'base64'));
}
async function chooseFile(file) {
  const { root: doc } = await cdp('DOM.getDocument');
  const { nodeId } = await cdp('DOM.querySelector', { nodeId: doc.nodeId, selector: '#file' });
  await cdp('DOM.setFileInputFiles', { nodeId, files: [file] });
}

await cdp('Page.enable');
await cdp('Runtime.enable');
await cdp('DOM.enable');
const fake = fs.readFileSync(path.join(root, 'test/fake-serial.js'), 'utf8');
await cdp('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__fake = { regrant: !location.search.includes('regrant=0') };\n${fake}`,
});

async function scenario(name, query, { reselect }) {
  console.log(`--- ${name}`);
  await cdp('Page.navigate', { url: `${base}${query}` });
  await until("document.readyState === 'complete'", 10000);
  await until("document.querySelector('#unit-status').dataset.kind === 'ok'", 10000, 'auto-connect');
  console.log(`connected: ${await js("document.querySelector('#unit-info').innerText.replace(/\\n/g, ' | ')")}`);
  await chooseFile(img);
  await until("!document.querySelector('#file-info').hidden && /[0-9a-f]{32}/.test(document.querySelector('#file-meta').innerText)", 20000, 'image parsed');
  await until("!document.querySelector('#flash').disabled", 5000, 'flash enabled');
  console.log(`checks: ${await js("[...document.querySelectorAll('#checks li')].map(l => l.dataset.level + ': ' + l.textContent).join(' / ')")}`);
  await shot(`${name}-ready`);
  await js("document.querySelector('#flash').click()");
  await until("document.querySelector('#ask').open", 3000, 'confirm dialog');
  await shot(`${name}-confirm`);
  await js("document.querySelector('#ask-ok').click()");
  let reselects = 0;
  const t0 = Date.now();
  let midShot = false;
  while (await js("document.querySelector('#result').hidden")) {
    if (Date.now() - t0 > 120000) throw new Error('flash did not finish');
    if (reselect && !(await js("document.querySelector('#reselect').hidden"))) {
      if (reselects === 0) await shot(`${name}-reselect`);
      await js("document.querySelector('#reselect').click()");
      reselects++;
    }
    if (!midShot && await js("/Sending/.test(document.querySelector('#stage-text').textContent)")) {
      await shot(`${name}-sending`);
      midShot = true;
    }
    await sleep(200);
  }
  await js("document.querySelector('details').open = true");
  await shot(`${name}-done`);
  const r = await js(`({
    result: document.querySelector('#result').textContent,
    ok: document.querySelector('#result').dataset.ok,
    md5ok: window.__fake.md5ok,
    remotePath: window.__fake.remotePath,
    mode: window.__fake.mode,
    requested: window.__fake.requested || 0,
    cmds: window.__fake.log.filter(l => !/FILE_DATA|UPGRADE_STATUS/.test(l)),
  })`);
  console.log(JSON.stringify({ ...r, reselects, seconds: Math.round((Date.now() - t0) / 1000) }, null, 1));
  const fail = [];
  if (r.ok !== 'true') fail.push(`result: ${r.result}`);
  if (!r.md5ok) fail.push('unit md5 check failed');
  if (r.mode !== 'normal') fail.push(`unit ends in ${r.mode} mode`);
  if (reselect && r.requested < 2) fail.push(`expected 2 reselects, got ${r.requested}`);
  if (!reselect && r.requested) fail.push('asked for the port without need');
  return fail;
}

async function looks() {
  console.log('--- looks: dark, phone width, a goggles image');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
  await cdp('Page.navigate', { url: base });
  await until("document.querySelector('#unit-status').dataset.kind === 'ok'", 10000, 'auto-connect');
  const bad = path.join(out, 'Ascent_G_Gnd_17_5_8.img');
  const b = Buffer.alloc(4096);
  b.write('ASW\0');
  b.writeUInt32LE(5, 4);
  b.writeUInt32LE(17, 8); b.writeUInt32LE(5, 12); b.writeUInt32LE(8, 16);
  fs.writeFileSync(bad, b);
  await chooseFile(bad);
  await until("document.querySelectorAll('#checks li[data-level=error]').length > 0", 5000, 'error shown');
  const disabled = await js("document.querySelector('#flash').disabled");
  const overflow = await js('document.documentElement.scrollWidth > window.innerWidth');
  await shot('looks-dark-phone-bad-image');
  const fail = [];
  if (!disabled) fail.push('flash enabled for a goggles image');
  if (overflow) fail.push('horizontal scroll at 390 px');
  return fail;
}

let failures = [];
try {
  failures.push(...await scenario('kept', '', { reselect: false }));
  failures.push(...await scenario('lost', '?regrant=0', { reselect: true }));
  failures.push(...await looks());
} catch (e) {
  failures.push(e.message);
}
failures.push(...problems);
console.log(`screenshots: ${out}`);
console.log(failures.length ? `FAIL\n  ${failures.join('\n  ')}` : 'PASS');
ws.close();
chrome.kill();
server.close();
await new Promise((r) => { chrome.once('exit', r); setTimeout(r, 3000); });
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* chrome still writing */ }
process.exit(failures.length ? 1 : 0);
