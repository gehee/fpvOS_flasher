#!/usr/bin/env node
// Runs the page in headless Chrome against fake-serial.js and flashes an
// image through the real UI: bare image, archive and reselect paths, plus
// profile mismatch / unsupported device checks. No physical USB access.
//   node test/browser-check.mjs [IMG] [OUTDIR]
// CHROME=/path/to/chromium selects a browser; VRX_IMG adds signed stock VRX flows.
// Defaults to a synthetic air image. Screenshots go to OUTDIR (a temp dir by default).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { airImage, vrxImage, storedZip } from './fixtures.mjs';
import { openBrowser, PUBLIC_ASSETS } from './browser-harness.mjs';
import { crc32 } from '../checksum.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[3] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'flasher-check-'));
fs.mkdirSync(out, { recursive: true });
const img = process.argv[2] ? path.resolve(process.argv[2]) : path.join(out, 'Ascent_H_Sky_18_21_10.img');
if (!process.argv[2]) fs.writeFileSync(img, airImage());
if (!fs.existsSync(img)) { console.error('usage: browser-check.mjs [IMG] [OUTDIR]'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fake = fs.readFileSync(path.join(root, 'test/fake-serial.js'), 'utf8');

async function connectedPage(query = '') {
  await cdp('Page.navigate', { url: `${base}${query}` });
  await until("document.readyState === 'complete' && document.querySelector('#unit-info') && !document.querySelector('#unit-info').hidden", 10000, 'auto-connect');
  await js("document.querySelector('#image-details').open = true");   // a chosen file's details
}

async function p1PreparationControls() {
  console.log('--- P1 preparation steps, permissions and cancellation');
  await cdp('Page.navigate', { url: `${base}?device=p1stock` });
  await until("document.readyState === 'complete' && !document.querySelector('#connect').hidden", 10000, 'stock page');
  await js("document.querySelector('#p1-preparation').open = true");
  // before confirmation both steps are blocked
  if (!await js("document.querySelector('#p1-enter-bootloader').disabled && document.querySelector('#p1-load-recovery').disabled")) throw new Error('Stock version confirmation is required.');
  await js("document.querySelector('#p1-stock-confirm').click()");
  // step 1 is the lit next action; step 2 stays blocked until step 1 has run
  await until("!document.querySelector('#p1-enter-bootloader').disabled && document.querySelector('#p1-enter-bootloader').classList.contains('step-active')", 3000, 'step 1 lit');
  if (!await js("document.querySelector('#p1-load-recovery').disabled && !document.querySelector('#p1-load-recovery').classList.contains('step-active')")) throw new Error('Step 2 must stay blocked until step 1 has run.');
  // run step 1 (restart) by hand
  await js("document.querySelector('#p1-enter-bootloader').click()");
  await until("Array.isArray(window.__fake.p1RebootRaw) && document.querySelector('#p1-preparation-cancel').hidden", 5000, 'step 1 done');
  // step 1 greyed and ticked, step 2 now the lit action
  if (!await js("document.querySelector('#p1-enter-bootloader').disabled && document.querySelector('#p1-enter-bootloader').classList.contains('step-done')")) throw new Error('Finished step 1 must be greyed and marked done.');
  if (!await js("!document.querySelector('#p1-load-recovery').disabled && document.querySelector('#p1-load-recovery').classList.contains('step-active')")) throw new Error('Step 2 must unblock as the lit action once step 1 has run.');
  // step 2 chooser locks competing actions; cancelling leaves a retryable status
  await js(`navigator.hid.requestDevice = () => new Promise(resolve => { window.resolveP1Chooser = resolve; });
    document.querySelector('#p1-load-recovery').click();`);
  if (!await js("document.querySelector('#connect').disabled && document.querySelector('#p1-enter-bootloader').disabled && !document.querySelector('#p1-preparation-cancel').hidden && !/…$/.test(document.querySelector('#flash').textContent)")) throw new Error('Preparation must lock competing actions without claiming a firmware flash.');
  // the recovery set is fetched before the chooser opens, so the chooser appears a moment after the click
  await until("typeof window.resolveP1Chooser === 'function'", 5000, 'HID chooser requested');
  await js("document.querySelector('#p1-preparation-cancel').click(); window.resolveP1Chooser([])");
  await until("!document.querySelector('#p1-load-recovery').disabled && document.querySelector('#p1-preparation-cancel').hidden", 3000);
  if (!await js("document.querySelector('#p1-preparation-status').textContent.includes('No bootloader selected')")) throw new Error('Empty chooser must leave a retryable status.');
}

async function steadyDigitalStockDetection() {
  console.log('--- SteadyDigital stock detection from Connect, same panel as the P1');
  await cdp('Page.navigate', { url: `${base}?device=sdstock` });
  await until("document.readyState === 'complete' && !document.querySelector('#connect').hidden", 10000, 'stock SteadyDigital page');
  const fail = [];
  if (!await js("document.querySelector('#unit-info').hidden")) fail.push('stock SteadyDigital auto-connected as a device');
  if (!await js("document.querySelector('#p1-preparation').hidden")) fail.push('preparation shown before a stock SteadyDigital was found');
  await js("document.querySelector('#connect').click()");
  await until("document.querySelector('#ask').open", 3000, 'stock SteadyDigital prepare confirm');
  if (!await js("/Skyzone SteadyDigital/.test(document.querySelector('#ask-title')?.textContent ?? document.querySelector('#ask').textContent) && !/P1/.test(document.querySelector('#ask').textContent)")) fail.push('confirm names the wrong board');
  await js("document.querySelector('#ask-ok').click()");
  await until("Array.isArray(window.__fake.p1RebootRaw)", 5000, 'restart sent');
  if (String(await js("window.__fake.p1RebootRaw")) !== String([0xaa, 5, 0, 0x1d, 0, 0, 0xcc, 0xeb, 0xaa])) fail.push('wrong SteadyDigital restart bytes');
  await until("document.querySelector('#p1-preparation-cancel').hidden", 5000, 'restart finished');
  if (!await js("/SteadyDigital/.test(document.querySelector('#prep-summary').textContent) && !/P1/.test(document.querySelector('#p1-enter-bootloader').textContent + document.querySelector('#p1-load-recovery').textContent)")) fail.push('panel still carries the P1 wording');
  if (!await js("document.querySelector('#p1-enter-bootloader').classList.contains('step-done') && document.querySelector('#p1-load-recovery').classList.contains('step-active')")) fail.push('steps not walked: 1 done, 2 lit');
  return fail;
}

async function preparationBlockedOffLinux(linuxUA) {
  console.log('--- off Linux/ChromeOS, stock preparation goes to the fpvOS Recovery app (macOS, Windows)');
  const fail = [];
  const uas = {
    macOS: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
    Windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
  };
  try {
    for (const [os, ua] of Object.entries(uas)) {
      await cdp('Emulation.setUserAgentOverride', { userAgent: ua });
      await cdp('Page.navigate', { url: `${base}?device=sdstock` });
      await until("document.readyState === 'complete' && !document.querySelector('#connect').hidden", 10000, `stock page (${os} UA)`);
      await js("document.querySelector('#connect').click()");
      await until("!document.querySelector('#recovery-app').hidden && document.querySelector('#recovery-app').open", 3000, `recovery app panel (${os})`);
      if (!await js(`document.querySelector('#recovery-os').textContent === ${JSON.stringify(os)}`)) fail.push(`${os}: the panel does not name ${os}`);
      if (os === 'macOS') {
        // the Terminal command fetches the app (no quarantine): the latest release's zip,
        // or ./recovery-app/'s when the page is served from localhost, as here
        if (await js("document.querySelector('#recovery-terminal').hidden")) fail.push('macOS: no Terminal command');
        if (!await js("/(releases\\/latest\\/download|recovery-app)\\/fpvOS-Recovery-macOS\\.zip'/.test(document.querySelector('#recovery-command').textContent)")) fail.push('macOS: the command does not fetch the app zip');
      } else if (!await js("document.querySelector('#recovery-terminal').hidden")) fail.push(`${os}: a Terminal command shown`);
      if (!await js("/Download/.test(document.querySelector('#recovery-download').textContent)")) fail.push(`${os}: no download button`);
      // the app does the bootloader step: the page must not start preparation or send a reboot
      if (!await js("document.querySelector('#p1-preparation').hidden")) fail.push(`${os}: the browser preparation panel opened`);
      if (await js("Array.isArray(window.__fake.p1RebootRaw)")) fail.push(`${os}: a reboot was sent`);
      await shot(`recovery-app-${os}`);
    }
  } finally {
    await cdp('Emulation.setUserAgentOverride', { userAgent: linuxUA });
  }
  return fail;
}

async function p1StockDetection() {
  console.log('--- P1 stock detection from Connect');
  await cdp('Page.navigate', { url: `${base}?device=p1stock` });
  await until("document.readyState === 'complete' && !document.querySelector('#connect').hidden", 10000, 'stock page');
  const fail = [];
  // a stock P1 is offered by Connect but must not auto-connect as a device
  if (!await js("document.querySelector('#unit-info').hidden")) fail.push('stock P1 auto-connected as a device');
  if (!await js("document.querySelector('#p1-preparation').hidden")) fail.push('P1 preparation shown before a stock P1 was found');
  await js("document.querySelector('#connect').click()");
  await until("document.querySelector('#ask').open", 3000, 'stock P1 prepare confirm');
  if (!await js("/stock firmware 1\\.0\\.44/.test(document.querySelector('#ask-text').textContent)")) fail.push('stock P1 confirm lacks the supported-version scope');
  await shot('p1-stock-confirm');
  await js("document.querySelector('#ask-ok').click()");
  await until("Array.isArray(window.__fake.p1RebootRaw)", 5000, 'restart sent');
  const raw = String(await js("window.__fake.p1RebootRaw"));
  if (raw !== String([0xaa, 5, 0, 0x1d, 0, 0, 0xcc, 0xeb, 0xaa])) fail.push(`wrong P1 restart bytes: ${raw}`);
  await until("document.querySelector('#p1-preparation-cancel').hidden", 5000, 'restart finished');
  if (!await js("document.querySelector('#p1-preparation').open && !document.querySelector('#p1-preparation').hidden")) fail.push('preparation panel did not open');
  if (!await js("document.querySelector('#p1-stock-confirm').checked")) fail.push('stock confirm not set from Connect');
  if (!await js("/Load P1 recovery|download gadget/.test(document.querySelector('#p1-preparation-status').textContent)")) fail.push('did not guide to the recovery step');
  if (await js("document.querySelector('#p1-load-recovery').disabled")) fail.push('Load P1 recovery not enabled after restart');
  if (!await js("document.querySelector('#p1-enter-bootloader').disabled && document.querySelector('#p1-enter-bootloader').classList.contains('step-done')")) fail.push('step 1 not greyed/ticked after the auto restart');
  if (!await js("document.querySelector('#p1-load-recovery').classList.contains('step-active')")) fail.push('step 2 not lit as the next action');
  await shot('p1-stock-detection');
  return fail;
}

async function scenario(name, query, { reselect, file = img, source = img, profile = 'ascent-air', unlock = false, bootstrap = false }) {
  console.log(`--- ${name}`);
  await connectedPage(query);
  if (profile === 'fpvos-p1-air') {
    if (!await js("document.querySelector('#p1-enter-bootloader') && document.querySelector('#p1-load-recovery') && !document.querySelector('#p1-preparation-download')")) throw new Error('P1 browser preparation controls are missing.');
    if (!await js("document.querySelector('#p1-enter-bootloader').disabled && document.querySelector('#p1-load-recovery').disabled")) throw new Error('Stock preparation must be disabled while connected.');
  }
  await chooseFile(file);
  await until("!document.querySelector('#file-info').hidden && /[0-9a-f]{32}/.test(document.querySelector('#file-meta').innerText)", 30000, 'image parsed');
  const shown = await js("[...document.querySelectorAll('#file-meta dt')].find(e => e.textContent === 'MD5').nextElementSibling.textContent");
  const expectedMd5 = createHash('md5').update(fs.readFileSync(source)).digest('hex');
  if (shown !== expectedMd5) throw new Error(`${name}: page shows md5 ${shown}, image is ${expectedMd5}`);
  if (!await js(`document.querySelector('#profile-hint').textContent.includes(${JSON.stringify(profile === 'ascent-vrx' ? 'Ascent VRX · Stock' : profile === 'fpvos-ar9311' ? 'Ascent VRX · fpvOS' : profile === 'fpvos-p1-air' ? 'BETAFPV P1 Air · fpvOS' : 'Ascent Lite')})`)) {
    throw new Error(`${name}: wrong detected hardware profile`);
  }
  await until("!document.querySelector('#flash').disabled", 5000, 'flash enabled');
  if (unlock) {
    if (await js("document.querySelector('#unlock-before-flash').disabled")) throw new Error('unlock unavailable');
    if (!await js("document.querySelector('#unlock-before-flash').checked")) throw new Error('downgrade did not auto-select unlock');
  }
  await shot(`${name}-ready`);
  await js("document.querySelector('#flash').click()");
  await until("document.querySelector('#ask').open", 3000, 'confirm dialog');
  const notice = await js("document.querySelector('#ask-text').textContent");
  if (profile === 'ascent-vrx' && !/external DC power/.test(notice)) throw new Error('VRX confirmation lacks its power/update policy');
  if (unlock && !/0\.0\.0/.test(notice)) throw new Error('unlock confirmation lacks the version overlay policy');
  if (bootstrap && !/RAM updater/.test(notice)) throw new Error('bootstrap confirmation lacks its experimental preparation policy');
  await shot(`${name}-confirm`);
  await js("document.querySelector('#ask-ok').click()");
  let reselects = 0;
  const t0 = Date.now();
  while (await js("document.querySelector('#result').hidden")) {
    if (Date.now() - t0 > 120000) throw new Error('flash did not finish');
    if (reselect && !(await js("document.querySelector('#reselect').hidden"))) {
      if (reselects === 0) await shot(`${name}-reselect`);
      await js("document.querySelector('#reselect').click()");
      reselects++;
    }
    await sleep(200);
  }
  await js("document.querySelector('#log-panel').open = true");
  await shot(`${name}-done`);
  const r = await js(`({
    result: document.querySelector('#result').textContent,
    ok: document.querySelector('#result').dataset.ok,
    md5ok: window.__fake.md5ok,
    remotePath: window.__fake.remotePath,
    mode: window.__fake.mode,
    requested: window.__fake.requested || 0,
    cmds: window.__fake.log.filter(l => !/FILE_DATA|UPGRADE_STATUS/.test(l)),
    starts: window.__fake.starts, reboots: window.__fake.rebootPayloads,
  })`);
  console.log(`${r.result} (${reselects} port reselections)`);
  const fail = [];
  if (r.ok !== 'true') fail.push(`result: ${r.result}`);
  if (!r.md5ok) fail.push('unit md5 check failed');
  if (r.mode !== 'normal') fail.push(`unit ends in ${r.mode} mode`);
  if (reselect && r.requested < (bootstrap ? 1 : 2)) fail.push(`missing port reselection (${r.requested})`);
  if (!reselect && r.requested) fail.push('asked for the port without need');
  const expectedName = profile === 'fpvos-p1-air' ? 'fpvos.fwu' : path.basename(source);
  if (r.remotePath !== `/tmp/pc/${expectedName}`) fail.push(`wrong remote filename: ${r.remotePath}`);
  if (unlock && (r.starts.length !== 3 || r.reboots[0] !== 'normal' || r.cmds.filter(c => /FILE_END/.test(c)).length !== 1)) fail.push('unlock staging/reboot/update trigger order was wrong');
  if (bootstrap && (r.starts.length !== 4 || r.starts[0] !== '/usrdata/fpvos-update' || r.starts[1] !== '/usrdata/fpvos-bootstrap.sh'
    || r.reboots[0] !== 'normal' || r.cmds.filter(c => /FILE_END/.test(c)).length !== 1)) fail.push('bootstrap staging/reboot/update trigger order was wrong');
  return fail;
}

// A release installed, and the unit back answering as stock: no "runs fpvOS".
// The test releases are named like none with fpvOS's own updater (which would
// say its device mode), so no telling either way: no failure claimed.
async function catalogInstallStillStock() {
  console.log('--- firmware choice: installed, but the unit comes back on stock');
  const fail = [];
  await connectedPage();
  await until("document.querySelector('#flash').textContent === 'Install fpvOS test-new'", 5000, 'latest release selected');
  await js("document.querySelector('#flash').click()");
  await until("document.querySelector('#ask').open", 10000, 'install confirm');
  await js("document.querySelector('#ask-ok').click()");
  await until("!document.querySelector('#result').hidden", 120000, 'install finished');
  const r = await js("({ ok: document.querySelector('#result').dataset.ok, text: document.querySelector('#result').textContent })");
  console.log(r.text);
  if (r.ok !== 'true' || /runs fpvOS|not fpvOS/.test(r.text) || !/cannot tell/.test(r.text)) fail.push(`still-stock install result: ${r.text}`);
  return fail;
}

// The firmware choice: published releases newest first, an older one installed
// from the list (downloaded, checked against its MD5, one confirmation), then a
// local file joins the list.
async function catalogInstall() {
  console.log('--- firmware choice: an older release, then a local file');
  const fail = [];
  await connectedPage('?installsFpvos=test-old');
  await until("document.querySelector('#flash').textContent === 'Install fpvOS test-new'", 5000, 'latest release selected');
  const options = await js("[...document.querySelectorAll('#release option')].map(o => o.textContent).join('|')");
  if (options !== `fpvOS test-new · latest|fpvOS test-old|fpvOS-vrxpro-abc1234.img.xz · test|fpvOS-old-Ascent_H_Sky.img · test|${buildImg} · test`) fail.push(`release list: ${options}`);
  if (!await js("document.querySelector('#device-name').textContent === 'Caddx Ascent Lite'")) fail.push('device name');
  if (!await js("document.querySelector('#start').hidden && document.querySelector('#developer').hidden && document.querySelector('#image-details').hidden")) fail.push('connect panel, developer section or image details shown');
  await shot('install-ready');
  await js("document.querySelector('#release-button').click()");
  if (await js("document.querySelector('#release-list').hidden")) fail.push('firmware list did not open');
  await shot('install-list-open');
  await js("document.querySelector('#release-list li[data-value=\"test-old\"]').click()");
  if (!await js("document.querySelector('#release-list').hidden && document.querySelector('#release').value === 'test-old'")) fail.push('firmware list did not pick and close');
  if (!await js("document.querySelector('#flash').textContent === 'Install fpvOS test-old'")) fail.push('older release not selected');
  await js("document.querySelector('#flash').click()");
  await until("document.querySelector('#ask').open", 10000, 'install confirm');
  if (!await js("document.querySelector('#ask-title').textContent === 'Install fpvOS test-old on your Caddx Ascent Lite?'")) fail.push('install confirm title');
  await shot('install-confirm');
  await js("document.querySelector('#ask-ok').click()");
  await until("!document.querySelector('#result').hidden", 120000, 'install finished');
  const r = await js(`({ ok: document.querySelector('#result').dataset.ok, text: document.querySelector('#result').textContent,
    md5ok: window.__fake.md5ok, remotePath: window.__fake.remotePath, mode: window.__fake.mode,
    hidden: document.querySelector('#flash').hidden, hint: document.querySelector('#hint').textContent })`);
  await shot('install-done');
  console.log(r.text);
  if (r.ok !== 'true' || !/runs fpvOS test-old/.test(r.text)) fail.push(`install result: ${r.text}`);
  if (!r.md5ok) fail.push('unit md5 check failed');
  if (r.mode !== 'normal') fail.push(`unit ends in ${r.mode} mode`);
  if (r.remotePath !== '/tmp/pc/Ascent_H_Sky_18_21_10.img') fail.push(`wrong remote filename: ${r.remotePath}`);
  if (!r.hidden || !/unplug/.test(r.hint)) fail.push('install offered again after success');
  // a local file joins the list and becomes the selection
  await chooseFile(img);
  await until("document.querySelector('#release').value === 'file' && document.querySelector('#flash').textContent === 'Flash this file' && !document.querySelector('#flash').disabled", 10000, 'local file selected');
  if (!await js(`[...document.querySelectorAll('#release option')].pop().textContent === ${JSON.stringify(`Local file: ${path.basename(img)}`)}`)) fail.push('local file not in the list');
  if (await js("document.querySelector('#image-details').hidden")) fail.push('local file details hidden');
  await shot('install-local-file');
  // a VRX has no published image here: nothing to install until a test build or a file is chosen
  await connectedPage('?device=vrx');
  await until("/choose a test build/i.test(document.querySelector('#hint').textContent)", 5000, 'no-release hint');
  if (!await js("document.querySelector('#flash').disabled")) fail.push('install offered without an image');
  // a unit on fpvOS shows fpvOS's version, not the stock name it reports for the PC tool
  await connectedPage('?airFpvos=2026.10.beta4-42-g3a8bff1');
  if (!await js("document.querySelector('#device-firmware').textContent === 'Runs fpvOS 2026.10.beta4-42-g3a8bff1'")) fail.push(`fpvOS version: ${await js("document.querySelector('#device-firmware').textContent")}`);
  if (!await js("/Reported as/.test(document.querySelector('#unit-info').textContent) && /already runs fpvOS/.test(document.querySelector('#hint').textContent)")) fail.push('fpvOS unit details or hint');
  await shot('fpvos-unit');
  // ?dev shows the developer section
  await connectedPage('?dev');
  if (await js("document.querySelector('#developer').hidden")) fail.push('developer section hidden with ?dev');
  return fail;
}

// Test builds from test-firmware/: fetched when chosen, shown with every check of
// a local file (an unversioned name warns), and flashed as one.
async function testBuilds() {
  console.log('--- test builds from test-firmware/');
  const fail = [];
  await connectedPage();
  await until("document.querySelector('#release-list li[data-value^=\"test:\"]')", 5000, 'test builds listed');
  await js(`document.querySelector('#release-button').click(); document.querySelector('#release-list li[data-value="test:fpvOS-old-Ascent_H_Sky.img"]').click()`);
  await until("document.querySelector('#flash').textContent === 'Flash this file' && !document.querySelector('#flash').disabled", 10000, 'unversioned test build loaded');
  if (!await js("/file name has no version/.test(document.querySelector('#checks').textContent)")) fail.push('no version warning for an unversioned test build');
  if (await js("document.querySelector('#image-details').hidden")) fail.push('test build details hidden');
  await js(`document.querySelector('#release-button').click(); document.querySelector('#release-list li[data-value="test:${build}/${buildImg}"]').click()`);
  await until(`document.querySelector('#file-name').textContent === ${JSON.stringify(buildImg)} && !document.querySelector('#flash').disabled`, 10000, 'test build loaded');
  if (await js("/file name has no version/.test(document.querySelector('#checks').textContent)")) fail.push('version warning for a versioned test build');
  if (!await js(`document.querySelector('#release-list li[data-value="test:${build}/${buildImg}"] small')?.textContent === ${JSON.stringify(build)}`)) fail.push('build folder not under the test build name');
  // a long name is cut short in the button, its tag and the arrow stay whole
  if (!await js("(() => { const b = document.querySelector('#release-button'), t = b.querySelector('.tag'); return b.scrollWidth <= b.clientWidth && t && t.getBoundingClientRect().right <= b.getBoundingClientRect().right - 40; })()")) fail.push('test build name overflows the firmware button');
  await shot('test-build');
  await js("document.querySelector('#flash').click()");
  await until("document.querySelector('#ask').open", 10000, 'test build confirm');
  await js("document.querySelector('#ask-ok').click()");
  await until("!document.querySelector('#result').hidden", 120000, 'test build flashed');
  const r = await js("({ ok: document.querySelector('#result').dataset.ok, text: document.querySelector('#result').textContent, remotePath: window.__fake.remotePath })");
  if (r.ok !== 'true') fail.push(`test build flash: ${r.text}`);
  if (r.remotePath !== '/tmp/pc/Ascent_H_Sky_18_21_10.img') fail.push(`wrong remote filename: ${r.remotePath}`);
  // every test build is listed whatever is connected (its checks say whether the unit takes it)
  await connectedPage('?device=vrx');
  const listed = await js("[...document.querySelectorAll('#release option')].filter(o => o.value.startsWith('test:')).length");
  if (listed !== 3) fail.push(`a VRX lists ${listed} of the 3 test builds`);
  // a build copied in while the page is open shows when the page comes back to the front
  listing('test-root.html', [...testRoot, 'fpvOS-new-Ascent_H_Sky.img']);
  await js("window.dispatchEvent(new Event('focus'))");
  await until(`document.querySelector('#release option[value="test:fpvOS-new-Ascent_H_Sky.img"]')`, 5000, 'new test build listed');
  listing('test-root.html', testRoot);
  return fail;
}

// An fpvOS P1: the version and SoC temperature its updater reports, the bundle
// it installed, and its device modes (bridge mode not kept across a restart).
async function p1OnFpvos() {
  console.log('--- P1 on fpvOS: version, installed bundle, temperature, device modes');
  const fail = [];
  const rows = "Object.fromEntries([...document.querySelectorAll('#unit-info dt')].map(d => [d.textContent, d.nextElementSibling.textContent]))";
  // an updater from before: no version, no temperature
  await connectedPage('?device=p1');
  let info = await js(rows);
  if (info.Firmware !== 'fpvOS' || 'CPU temperature' in info) fail.push(`older P1 updater rows: ${JSON.stringify(info)}`);
  const hash = 'ab'.repeat(32);
  await connectedPage(`?device=p1&p1Version=2026.10.beta4-23-g1234567&p1Temp=53&installed=${hash}`);
  info = await js(rows);
  if (info.Firmware !== 'fpvOS 2026.10.beta4-23-g1234567' || info['Installed bundle'] !== hash
    || info['CPU temperature'] !== '53 °C' || 'Reported as' in info) fail.push(`P1 rows: ${JSON.stringify(info)}`);
  if (!await js("!document.querySelector('#advanced').hidden")) fail.push('no device mode switch for the P1');
  await js("document.querySelector('#advanced').open = true");
  if (!await js("document.querySelector('#mode-normal').getAttribute('aria-checked') === 'true'")) fail.push('P1 normal mode not shown');
  await js("document.querySelector('#mode-bridge').click()");
  await until("document.querySelector('#ask').open", 3000, 'P1 bridge confirm');
  if (await js("/after a power cycle/.test(document.querySelector('#ask-text').textContent)")) fail.push('P1 bridge confirm says it is kept');
  await js("document.querySelector('#ask-ok').click()");
  await until("!document.querySelector('#start').hidden && /until it restarts/.test(document.querySelector('#start-note').textContent)", 5000, 'P1 bridge done');
  // back under the running AR8030's USB ids, the page connects to it again
  await until("!document.querySelector('#device').hidden && document.querySelector('#mode-bridge').getAttribute('aria-checked') === 'true'", 10000, 'P1 in bridge mode');
  if (!await js("/until you switch it back here or it restarts/.test(document.querySelector('#device-mode-note').textContent)")) fail.push('P1 bridge note');
  await shot('p1-bridge');
  await js("document.querySelector('#mode-normal').click()");
  await until("document.querySelector('#ask').open", 3000, 'P1 normal confirm');
  await js("document.querySelector('#ask-ok').click()");
  await until("!document.querySelector('#device').hidden && document.querySelector('#mode-normal').getAttribute('aria-checked') === 'true'", 10000, 'P1 back in normal mode');
  if (String(await js('window.__fake.rebootPayloads')) !== 'bridge,normal') fail.push(`P1 mode requests: ${await js('window.__fake.rebootPayloads')}`);
  return fail;
}

// fpvOS's device modes on an air unit: normal -> bridge -> normal through the
// switch (the unit re-enumerates each time), a unit found in update mode, a
// refused switch, and none of it on stock's updater.
async function deviceModes() {
  console.log('--- Device modes: bridge and back, update mode, refusal, stock');
  const fail = [];
  const q = '?airFpvos=2026.10.beta5&modeLag=3';
  // firmware before persistent bridge mode: no switch
  await connectedPage('?airFpvos=2026.10.beta4-44-g4372d89-dirty');
  if (!await js("document.querySelector('#advanced').hidden")) fail.push('device mode switch shown on beta4-44');
  const flip = async (to, text) => {
    await js(`document.querySelector('#mode-${to}').click()`);
    await until("document.querySelector('#ask').open", 3000, `${to} confirm`);
    if (!await js(`document.querySelector('#ask-title').textContent === 'Switch to ${to} mode?'`)) fail.push(`${to} confirm title`);
    await js("document.querySelector('#ask-ok').click()");
    await until(text ? `!document.querySelector('#start').hidden && document.querySelector('#start-note').textContent.includes(${JSON.stringify(text)})`
      : `window.__fake.rebootPayloads.includes('${to}')`, 5000, `${to} done`);
  };
  await connectedPage(q);
  // under Advanced, closed until opened
  if (!await js("!document.querySelector('#advanced').hidden && !document.querySelector('#advanced').open")) fail.push('Advanced not shown closed');
  await js("document.querySelector('#advanced').open = true");
  if (!await js("document.querySelector('#mode-normal').getAttribute('aria-checked') === 'true' && /^Normal:/.test(document.querySelector('#device-mode-note').textContent)")) fail.push('normal mode not shown');
  await shot('device-mode-normal');
  await flip('bridge', 'is in bridge mode');
  await shot('device-mode-switched');
  // the unit comes back (in bridge mode) and the page connects to it again
  await until("!document.querySelector('#device').hidden && document.querySelector('#mode-bridge').getAttribute('aria-checked') === 'true'", 10000, 'bridge unit');
  if (!await js("document.querySelector('#advanced').open && document.querySelector('#firmware').hidden && /stays in bridge mode/.test(document.querySelector('#device-mode-note').textContent)")) fail.push('bridge mode card');
  await shot('device-mode-bridge');
  await flip('normal', '');
  await until("!document.querySelector('#device').hidden && document.querySelector('#mode-normal').getAttribute('aria-checked') === 'true'", 10000, 'normal unit');
  if (!await js("document.querySelector('#start-note').hidden")) fail.push('a note after switching back to normal');
  if (String(await js('window.__fake.rebootPayloads')) !== 'bridge,normal') fail.push(`mode requests: ${await js('window.__fake.rebootPayloads')}`);
  // found in update mode: one button out, no confirmation
  await connectedPage(`${q}&airMode=clean`);
  if (!await js("!document.querySelector('#update-mode').hidden && document.querySelector('#advanced').hidden")) fail.push('update mode notice');
  await shot('device-mode-update');
  await js("document.querySelector('#mode-restart').click()");
  await until("document.querySelector('#start-note').textContent.includes('restarting normally')", 5000, 'restart');
  if (String(await js('window.__fake.rebootPayloads')) !== 'reboot') fail.push('restart request');
  // a refused switch keeps the unit and says why
  await connectedPage(`${q}&refuseMode=1`);
  await js("document.querySelector('#mode-bridge').click()");
  await until("document.querySelector('#ask').open", 3000, 'refused confirm');
  await js("document.querySelector('#ask-ok').click()");
  await until("!document.querySelector('#result').hidden", 5000, 'refusal shown');
  if (!await js("document.querySelector('#result').dataset.ok === 'false' && /refused bridge mode/.test(document.querySelector('#result').textContent) && !document.querySelector('#device').hidden")) fail.push('refusal');
  // stock's updater has no modes
  await connectedPage();
  if (!await js("document.querySelector('#advanced').hidden && document.querySelector('#update-mode').hidden")) fail.push('device modes shown for stock');
  return fail;
}

async function looks() {
  console.log('--- looks: dark, phone width, an unsupported L_Gnd image');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
  await connectedPage();
  const bad = path.join(out, 'Ascent_L_Gnd_17_5_8.img');
  fs.writeFileSync(bad, airImage([17, 5, 8], 1));
  await chooseFile(bad);
  await until("document.querySelectorAll('#checks li[data-level=error]').length > 0", 5000, 'error shown');
  const disabled = await js("document.querySelector('#flash').disabled");
  const overflow = await js('document.documentElement.scrollWidth > window.innerWidth');
  await shot('looks-dark-phone-bad-image');
  const fail = [];
  if (!disabled) fail.push('flash enabled for an unsupported ground image');
  if (overflow) fail.push('horizontal scroll at 390 px');
  return fail;
}

async function rejectedProfile(name, query, file) {
  console.log(`--- ${name}`);
  await connectedPage(query);
  await chooseFile(file);
  await until("document.querySelectorAll('#checks li[data-level=error]').length > 0", 10000, 'profile mismatch');
  await shot(name);
  const disabled = await js("document.querySelector('#flash').disabled");
  const commands = await js('window.__fake.log');
  return disabled && commands.every((c) => /FIND_DEVICE/.test(c)) ? [] : [`${name}: mismatch allowed a flash`];
}

async function offlineArchive(bundle) {
  console.log('--- mixed archive with no device connected');
  await connectedPage();
  await js("document.querySelector('#disconnect').click()");
  await until("document.querySelector('#unit-status').dataset.kind === 'idle'", 5000);
  await chooseFile(bundle);
  await until("document.querySelector('#checks').textContent.includes('different hardware')", 10000, 'ambiguous bundle rejected');
  if (!await js("document.querySelector('#flash').disabled")) return ['flash enabled while disconnected'];
  await shot('offline-archive');
  return [];
}

async function failedTransfer(install = false) {
  console.log(install ? '--- negative install status with empty detail fails immediately' : '--- failed chunk releases the device');
  await connectedPage(`?${install ? 'installFailure' : 'rejectData'}=1`);
  await chooseFile(img);
  await until("!document.querySelector('#flash').disabled", 10000);
  await js("document.querySelector('#flash').click()");
  await until("document.querySelector('#ask').open", 3000);
  await js("document.querySelector('#ask-ok').click()");
  await until("!document.querySelector('#result').hidden", 10000);
  const ok = await js(`document.querySelector('#result').dataset.ok === 'false'
    && document.querySelector('#result').textContent.includes(${JSON.stringify(install ? 'update failure (status -6)' : 'rejected or miscounted chunk')})
    && document.querySelector('#unit-status').dataset.kind === 'idle'
    && document.querySelector('#flash').disabled
    && ${install ? "window.__fake.log.filter(c => /UPGRADE_STATUS/.test(c)).length === 1" : "!window.__fake.log.some(c => /FILE_END/.test(c))"}`);
  await shot(install ? 'failed-install-disconnected' : 'failed-chunk-disconnected');
  return ok ? [] : ['failed transfer/install did not stop/release the updater session'];
}

async function failedUnlock(file) {
  console.log('--- unlock verification blocks firmware upload');
  await connectedPage('?device=vrx&fw=18_21_10&unlockFails=1');
  await chooseFile(file);
  await until("!document.querySelector('#flash').disabled", 10000);
  await js("document.querySelector('#unlock-before-flash').checked = true; document.querySelector('#unlock-before-flash').dispatchEvent(new Event('change')); document.querySelector('#flash').click()");
  await until("document.querySelector('#ask').open", 3000);
  await js("document.querySelector('#ask-ok').click()");
  await until("!document.querySelector('#result').hidden", 10000);
  const ok = await js("document.querySelector('#result').dataset.ok === 'false' && window.__fake.starts.length === 2 && !window.__fake.log.some(c => /FILE_END/.test(c))");
  return ok ? [] : ['failed unlock proof allowed firmware upload'];
}

async function unlockSelection(file, invalidFile) {
  console.log('--- automatic unlock selection, manual override and context reset');
  const failures = [];
  const selected = () => js("document.querySelector('#unlock-before-flash').checked");
  const loaded = (name = path.basename(file)) => until(`document.querySelector('#file-name').textContent === ${JSON.stringify(name)}
    && !document.querySelector('#file-meta').hidden && [...document.querySelectorAll('#file-meta dt')].some(e => e.textContent === 'MD5')
    && !document.querySelector('#file-status').textContent`, 10000, 'valid image loaded');
  const anotherFile = path.join(out, 'reselected-vrx.img');
  fs.copyFileSync(file, anotherFile);
  await connectedPage('?device=vrx&fw=18_21_10');
  if (await selected()) failures.push('unlock selected without an image');
  await chooseFile(file); await loaded();
  if (!await selected()) failures.push('older image did not select unlock');
  await js("document.querySelector('#unlock-before-flash').click(); document.querySelector('#verbose').click()");
  if (await selected()) failures.push('manual disable was overwritten');
  await chooseFile(anotherFile); await loaded(path.basename(anotherFile));
  if (!await selected()) failures.push('new file selection did not restore automatic unlock');
  await js("document.querySelector('#disconnect').click()");
  await until("document.querySelector('#unit-status').dataset.kind === 'idle'", 5000);
  if (await selected()) failures.push('unlock remained selected while disconnected');
  await js("document.querySelector('#connect').click()");
  await until("document.querySelector('#unit-status').dataset.kind === 'ok'", 10000); await loaded(path.basename(anotherFile));
  if (!await selected()) failures.push('reconnection did not re-evaluate the existing image');
  for (const fw of ['17_5_8', '16_5_7', '19_0_0']) {
    await connectedPage(`?device=vrx&fw=${fw}`);
    await chooseFile(file); await loaded();
    if (await selected() !== (fw === '19_0_0')) failures.push(`wrong automatic selection for current ${fw}`);
    if (fw === '17_5_8') {
      await js("document.querySelector('#unlock-before-flash').click(); document.querySelector('#verbose').click()");
      if (!await selected()) failures.push('manual enable was overwritten');
    }
  }
  await chooseFile(invalidFile);
  await until("document.querySelector('#checks').textContent.includes('RSA signature')", 10000);
  if (await selected()) failures.push('invalid image auto-selected unlock');
  if (!await js("window.__fake.log.every(c => /FIND_DEVICE/.test(c))")) failures.push('selection tests wrote to the device');
  return failures;
}

// a zip shaped like the vendor's download, and an .img.xz
const zip = path.join(out, 'Firmware_V18.21.10.zip');
execFileSync('python3', ['-c', `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('Firmware_V18.21.10/Readme.txt', 'read me')
    z.writestr('Firmware_V18.21.10/Ascent_G_Gnd_18_21_10.img', b'ground' * 1000)
    z.write(sys.argv[2], 'Firmware_V18.21.10/' + sys.argv[3])
`, zip, img, path.basename(img)]);
const xzFile = path.join(out, `${path.basename(img)}.xz`);
fs.writeFileSync(xzFile, execFileSync('xz', ['-c', '-6', img], { maxBuffer: 1 << 30 }));
const syntheticVrx = path.join(out, 'Ascent_G_Gnd_17_5_8.img');
fs.writeFileSync(syntheticVrx, vrxImage());
const syntheticBundle = path.join(out, 'synthetic-mixed.zip');
fs.writeFileSync(syntheticBundle, storedZip([[path.basename(img), fs.readFileSync(img)], [path.basename(syntheticVrx), fs.readFileSync(syntheticVrx)]]));
const fwu = path.join(out, 'fpvos.fwu');
const fwuHeader = Buffer.alloc(512), fwuParts = ['kernel','dtb','root'].map((s) => Buffer.from(s));
fwuHeader.write('FPVOSUP1'); [1,485,525,3].forEach((n,i) => fwuHeader.writeUInt32LE(n,8+i*4)); fwuHeader.write('browser-test',24);
fwuParts.forEach((p,i) => { const at=96+104*i; fwuHeader.write(['kernel.img','ascent-gnd485.dtb','rootfs.cpio.uboot'][i],at);
  fwuHeader.writeUInt32LE(p.length,at+32); fwuHeader.write(createHash('sha256').update(p).digest('hex'),at+36); });
fwuHeader.writeUInt32LE(crc32(fwuHeader),508); fs.writeFileSync(fwu,Buffer.concat([fwuHeader,...fwuParts]));

const p1Fwu = path.join(out, 'fpvos-p1-air.fwu');
const p1Header = Buffer.from(fwuHeader);
p1Header.writeUInt32LE(1345409867, 12);
['kernel.img', 'betafpv-p1-air.dtb', 'rootfs.cpio.gz'].forEach((name, i) => {
  const at = 96 + 104 * i; p1Header.fill(0, at, at + 32); p1Header.write(name, at);
});
p1Header.fill(0, 508); p1Header.writeUInt32LE(crc32(p1Header), 508);
fs.writeFileSync(p1Fwu, Buffer.concat([p1Header, ...fwuParts]));

// two published releases for the firmware choice: the synthetic air image
const catalog = path.join(out, 'catalog.json');
const published = (release) => ({ release, images: [{ devices: ['ascent-air'], file: `${release}/air.img`,
  name: 'Ascent_H_Sky_18_21_10.img', size: fs.statSync(img).size, md5: createHash('md5').update(fs.readFileSync(img)).digest('hex') }] });
fs.writeFileSync(catalog, JSON.stringify({ releases: [published('test-new'), published('test-old')] }));
// test builds in test-firmware/, as python3 -m http.server lists them: a build
// folder with an air image and a note, a goggle image and an unversioned air image
const listing = (name, links) => {
  fs.writeFileSync(path.join(out, name), `<html><body><ul>${links.map((l) => `<li><a href="${l}">${l}</a></li>`).join('')}</ul></body></html>`);
  return path.join(out, name);
};
const build = '2026-11-06-fpvOS-abc1234', buildImg = 'fpvOS-abc1234-Ascent_H_Sky_18_21_10.img';
const testRoot = [`${build}/`, 'fpvOS-vrxpro-abc1234.img.xz', 'fpvOS-old-Ascent_H_Sky.img', '?C=N;O=D'];
const harness = await openBrowser({ root, out, extra: { 'firmware/catalog.json': catalog,
  'firmware/test-new/air.img': img, 'firmware/test-old/air.img': img,
  'test-firmware/': listing('test-root.html', testRoot), 'test-firmware/fpvOS-new-Ascent_H_Sky.img': img,
  [`test-firmware/${build}/`]: listing('test-build.html', [buildImg, 'notes.txt', '../']),
  [`test-firmware/${build}/${buildImg}`]: img, 'test-firmware/fpvOS-old-Ascent_H_Sky.img': img } });
const { cdp, evaluate: js, until, screenshot: shot, chooseFile, problems } = harness;
const base = `${harness.origin}/`;
let failures = [];
try {
  for (const name of PUBLIC_ASSETS) {
    const response = await fetch(`${base}${name}`);
    if (!response.ok) throw new Error(`Missing public asset: ${name}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (name.startsWith('assets/p1-updater/browser-v1/')
      && !data.equals(fs.readFileSync(path.join(root, name)))) throw new Error('P1 recovery asset differs from the repository.');
  }
  for (const name of ['test/fake-serial.js', 'test/browser-harness.mjs', 'transports/node-serial.mjs', '.git/config']) {
    if ((await fetch(`${base}${name}`)).status !== 404) throw new Error(`Private asset served: ${name}`);
  }
  await cdp('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__fake = { regrant: !location.search.includes('regrant=0') };\n${fake}`,
  });
  // The stock-preparation gate (prepare-support.js) is OS-gated, and this check
  // may run on any host. Pin a Linux UA so the stock-detection scenarios test the
  // supported path deterministically; the gate itself is covered separately.
  const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
  await cdp('Emulation.setUserAgentOverride', { userAgent: LINUX_UA });
  await p1PreparationControls();
  failures.push(...await p1StockDetection());
  failures.push(...await steadyDigitalStockDetection());
  failures.push(...await preparationBlockedOffLinux(LINUX_UA));
  failures.push(...await scenario('kept', '?fw=17_5_3', { reselect: false }));
  failures.push(...await scenario('zip', '', { reselect: false, file: zip }));
  failures.push(...await scenario('xz', '', { reselect: false, file: xzFile }));
  failures.push(...await scenario('lost', '?regrant=0', { reselect: true }));
  failures.push(...await scenario('stock-to-fpvos', '?device=vrx&fw=18_21_10', { reselect: true, file:fwu, source:fwu, profile:'ascent-vrx', bootstrap:true }));
  failures.push(...await scenario('fpvos-update', '?device=fpvos', { reselect:false, file:fwu, source:fwu, profile:'fpvos-ar9311' }));
  failures.push(...await scenario('p1-update', '?device=p1&startupDelay=8000', { reselect:false, file:p1Fwu, source:p1Fwu, profile:'fpvos-p1-air' }));
  failures.push(...await scenario('p1-reselect', '?device=p1&regrant=0', { reselect:true, file:p1Fwu, source:p1Fwu, profile:'fpvos-p1-air' }));
  failures.push(...await rejectedProfile('p1-rejects-vrx', '?device=p1', fwu));
  failures.push(...await rejectedProfile('fpvos-vrx-rejects-p1', '?device=fpvos', p1Fwu));
  failures.push(...await rejectedProfile('vrx-rejects-air', '?device=vrx', img));
  failures.push(...await rejectedProfile('pro-rejects-air', '?device=pro', img));
  failures.push(...await rejectedProfile('vrx-rejects-untrusted-signature', '?device=vrx', syntheticVrx));
  failures.push(...await offlineArchive(syntheticBundle));
  failures.push(...await failedTransfer());
  failures.push(...await failedTransfer(true));
  if (process.env.VRX_IMG) {
    const vrx = path.resolve(process.env.VRX_IMG);
    const bundle = path.join(out, 'mixed-hardware.zip');
    fs.writeFileSync(bundle, storedZip([[path.basename(img), fs.readFileSync(img)], [path.basename(vrx), fs.readFileSync(vrx)]]));
    failures.push(...await scenario('vrx-mixed-zip', '?device=vrx', { reselect: false, file: bundle, source: vrx, profile: 'ascent-vrx' }));
    failures.push(...await scenario('vrx-lost', '?device=vrx&regrant=0', { reselect: true, file: vrx, source: vrx, profile: 'ascent-vrx' }));
    failures.push(...await unlockSelection(vrx, syntheticVrx));
    failures.push(...await scenario('vrx-unlock-downgrade', '?device=vrx&fw=18_21_10&enforceRollback=1', { reselect: false, file: vrx, source: vrx, profile: 'ascent-vrx', unlock: true }));
    failures.push(...await failedUnlock(vrx));
    failures.push(...await rejectedProfile('air-rejects-vrx', '', vrx));
  }
  failures.push(...await catalogInstall());
  failures.push(...await catalogInstallStillStock());
  failures.push(...await testBuilds());
  failures.push(...await deviceModes());
  failures.push(...await p1OnFpvos());
  failures.push(...await looks());
} catch (e) {
  failures.push(e.message);
}
failures.push(...problems);
console.log(`screenshots: ${out}`);
console.log(failures.length ? `FAIL\n  ${failures.join('\n  ')}` : 'PASS');
await harness.close();
process.exit(failures.length ? 1 : 0);
