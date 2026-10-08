#!/usr/bin/env node
// Real Web Serial hardware validation through the unmodified webapp.
// Requires explicit --info or --execute; never included in automated CI.
// A disposable Chromium profile holds permission for exactly the supplied
// USB serial number. No fake navigator.serial or transport injection is used.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { getProfile } from '../devices/index.js';
import { prepareFirmware } from '../flasher.js';
import { firmwareVersion, compareVersions } from '../firmware.js';
import { openBrowser } from './browser-harness.mjs';

const { values } = parseArgs({ options: {
  info: { type: 'boolean' }, execute: { type: 'boolean' },
  unlock: { type: 'boolean' },
  'selection-only': { type: 'boolean' },
  firmware: { type: 'string', multiple: true }, output: { type: 'string' },
  'usb-serial': { type: 'string' }, 'device-serial': { type: 'string' },
  'expect-status': { type: 'string' },
} });
if ((!values.info && !values.execute) || !values.output || !values['usb-serial']
  || values.execute && (!values['device-serial'] || !values.firmware?.length)) {
  throw new Error('Use --info or --execute, --output DIR, --usb-serial USB_SERIAL; execute also requires --device-serial SERIAL and --firmware FILE (repeatable).');
}
const expectedStatus = values['expect-status'] == null ? null : Number(values['expect-status']);
if (values.unlock && !values.execute) throw new Error('--unlock requires --execute.');
if (values['selection-only'] && (!values.info || values.execute || !values.firmware?.length)) throw new Error('--selection-only requires --info and firmware files, without --execute.');
if (expectedStatus != null && (!values.execute || values.firmware?.length !== 1 || !Number.isInteger(expectedStatus) || expectedStatus >= 0)) {
  throw new Error('--expect-status needs one firmware and a negative device status code.');
}
if (expectedStatus != null && values.unlock) throw new Error('--expect-status tests normal entry and cannot be combined with --unlock.');
const out = path.resolve(values.output);
fs.mkdirSync(out, { recursive: true });
const profile = getProfile('ascent-vrx');
const root = fileURLToPath(new URL('..', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const audit = { started: new Date().toISOString(), realHardware: true, browserTransport: 'native Web Serial',
  usbSerial: values['usb-serial'], execute: !!values.execute, unlock: !!values.unlock, files: [], flashes: [], errors: [] };
const save = () => fs.writeFileSync(path.join(out, 'audit.json'), JSON.stringify(audit, null, 2) + '\n');
const report = (text) => console.log(`${new Date().toISOString()} ${text}`);
for (const file of values.firmware ?? []) {
  const source = fs.readFileSync(file);
  const image = await prepareFirmware(new File([source], path.basename(file)), { profile });
  if (image.parsed.errors.length || image.parsed.profileId !== profile.meta.id || !image.md5) {
    throw new Error(`Invalid VRX firmware ${file}: ${image.parsed.errors.join(' ')}`);
  }
  audit.files.push({ source: path.resolve(file), sourceSha256: createHash('sha256').update(source).digest('hex'),
    name: image.name, remoteName: image.parsed.remoteName, version: image.parsed.versionText,
    bytes: image.bytes.length, md5: image.md5, imageSha256: createHash('sha256').update(image.bytes).digest('hex'),
    bodySha256: image.parsed.shaCalc, hashOk: image.parsed.hashOk, signatureOk: image.parsed.signatureOk });
  report(`Validated ${image.parsed.remoteName}: SHA-256/RSA OK, ${image.bytes.length} bytes`);
}
save();

let harness;
// Preserve a partial audit and release only our own browser on interruption.
// Device-side programming/reboot can continue independently; never cut power.
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => {
    audit.ok = false; audit.errors.push(`Hardware validation interrupted by ${signal}`);
    audit.finished = new Date().toISOString(); save();
    harness?.stop();
    process.exit(code);
  });
}
const js = (expression) => harness.evaluate(expression);
const until = (...args) => harness.until(...args);
const click = (selector) => harness.click(selector);
const deviceInfo = () => js("document.querySelector('#unit-info').hidden ? null : Object.fromEntries([...document.querySelectorAll('#unit-info dt')].map(e => [e.textContent,e.nextElementSibling.textContent]))");
async function chooseFile(file) {
  await harness.chooseFile(file);
  await until("!document.querySelector('#flash').disabled", 120000, 'firmware validation and Flash enabled');
}
const screenshot = (name) => harness.screenshot(name);

try {
  harness = await openBrowser({ root, out, permission: { vendorId: 0x1d75, productId: 0x0101, usbSerial: values['usb-serial'] },
    onProblem: (text) => { audit.errors.push(text); save(); } });
  audit.browserPid = harness.browserPid; audit.browser = harness.version; audit.origin = harness.origin; save();
  await harness.cdp('Page.navigate', { url: `${harness.origin}/` });
  await until("document.querySelector('#unit-status') && document.querySelector('#unit-status').dataset.kind === 'ok'", 20000, 'native serial auto-connect');
  const native = await js("navigator.serial.getPorts.toString().includes('[native code]') && !('__fake' in window)");
  if (!native) throw new Error('Native Web Serial was replaced.');
  audit.initial = await deviceInfo();
  report(`Connected real VRX: ${JSON.stringify(audit.initial)}`);
  if (audit.initial.Device !== 'Ascent_VRX' || values['device-serial'] && audit.initial.Serial !== values['device-serial']) {
    throw new Error('The connected receiver does not match the requested device identity.');
  }
  await click('details summary');
  await click('#verbose');
  await screenshot('initial'); save();
  if (values['selection-only']) {
    audit.selections = [];
    for (const [i, file] of audit.files.entries()) {
      await chooseFile(file.source);
      const expected = compareVersions(file.version.split('.').map(Number), firmwareVersion(audit.initial.Firmware)) < 0;
      const selected = await js("document.querySelector('#unlock-before-flash').checked");
      if (selected !== expected) throw new Error('Automatic unlock selection does not match the connected/image version comparison.');
      const hint = await js("document.querySelector('#unlock-hint').textContent");
      audit.selections.push({ image: file.version, current: audit.initial.Firmware, unlockSelected: selected, hint }); save();
      await screenshot(`selection-${i + 1}`);
      report(`SELECTION verified: image ${file.version}, unlock ${selected ? 'on' : 'off'}; no flash requested`);
    }
  }
  if (values.execute) {
    for (const [i, file] of audit.files.entries()) {
      const run = { index: i + 1, target: file.version, before: await deviceInfo(), started: new Date().toISOString(), progress: [] };
      audit.flashes.push(run); save();
      await chooseFile(file.source);
      if (values.unlock) {
        if (await js("document.querySelector('#unlock-before-flash').disabled")) throw new Error('Preflash unlock unavailable for this connected device.');
        if (!await js("document.querySelector('#unlock-before-flash').checked")) await click('#unlock-before-flash');
      }
      if (expectedStatus != null && await js("document.querySelector('#unlock-before-flash').checked")) await click('#unlock-before-flash');
      run.unlockSelected = await js("document.querySelector('#unlock-before-flash').checked"); save();
      const shownMd5 = await js("[...document.querySelectorAll('#file-meta dt')].find(e => e.textContent === 'MD5')?.nextElementSibling.textContent");
      if (shownMd5 !== file.md5) throw new Error('Webapp MD5 differs from independently prepared image.');
      await screenshot(`flash-${i + 1}-ready`);
      await click('#flash');
      await until("document.querySelector('#ask').open", 5000);
      if (!await js(`document.querySelector('#ask-title').textContent.includes(${JSON.stringify(file.remoteName)})`)) throw new Error('Wrong image in confirmation dialog.');
      await screenshot(`flash-${i + 1}-confirm`);
      report(`FLASH ${i + 1}: ${run.before.Firmware} -> ${file.remoteName}`);
      await click('#ask-ok');
      const started = Date.now();
      let last = '';
      while (await js("document.querySelector('#result').hidden")) {
        const text = await js("document.querySelector('#stage-text').textContent");
        if (text !== last) { last = text; run.progress.push({ t: new Date().toISOString(), text }); report(text); save(); }
        if (Date.now() - started > 18 * 60000) throw new Error('Flash exceeded the full update/reboot deadline.');
        if (!run.reselectionOffered && !await js("document.querySelector('#reselect').hidden")) {
          run.reselectionOffered = true; save();
          report('Port reselection offered; continuing to wait for native automatic reconnect (another application may own the port).');
        }
        await sleep(500);
      }
      run.result = await js("({ok: document.querySelector('#result').dataset.ok, text: document.querySelector('#result').textContent})");
      run.after = await deviceInfo();
      run.log = await js("[...document.querySelector('#log').children].map(e => e.textContent).join('\\n')");
      run.finished = new Date().toISOString(); save();
      await screenshot(`flash-${i + 1}-result`);
      if (run.result.ok !== 'true') {
        if (expectedStatus == null || !run.result.text.includes(`status ${expectedStatus}`)) throw new Error(run.result.text);
        run.expectedRejection = true; save();
        report(`VERIFIED rejection: ${run.result.text}; waiting for the receiver's automatic recovery reboot`);
        await until(`!document.querySelector('#unit-info').hidden && document.querySelector('#unit-status').dataset.kind === 'ok'
          && [...document.querySelectorAll('#unit-info dt')].find(e => e.textContent === 'Serial')?.nextElementSibling.textContent === ${JSON.stringify(audit.initial.Serial)}`, 7 * 60000, 'factory identity after rejected update');
        run.after = await deviceInfo();
        if (run.after.Firmware !== run.before.Firmware) throw new Error('Firmware changed after a rejected update.');
        await screenshot(`flash-${i + 1}-rejection-recovered`); save();
        report(`RECOVERED: ${run.after.Firmware}, serial ${run.after.Serial}`);
        continue;
      }
      if (expectedStatus != null) throw new Error('Expected rejection but the device accepted the update.');
      if (run.after.Firmware !== file.remoteName.replace(/\.img$/, '') || run.after.Serial !== audit.initial.Serial
        || run.after.Hardware !== audit.initial.Hardware) throw new Error('Post-flash firmware/identity does not match the requested image.');
      report(`VERIFIED ${i + 1}: ${run.after.Firmware}, serial ${run.after.Serial}`);
    }
  }
  audit.final = await deviceInfo();
  audit.ok = audit.errors.length === 0;
  if (!audit.ok) throw new Error(audit.errors.join('\n'));
} catch (e) {
  audit.ok = false; audit.errors.push(e.message);
  if (harness) {
    try { audit.lastLog = await js("[...document.querySelector('#log').children].map(e => e.textContent).join('\\n')"); await screenshot('failure'); } catch { /* browser unavailable */ }
  }
  report(`FAILED: ${e.message}`);
} finally {
  audit.finished = new Date().toISOString(); save();
  await harness?.close();
}
report(`Audit: ${path.join(out, 'audit.json')}`);
process.exit(audit.ok ? 0 : 1);
