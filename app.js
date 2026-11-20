// fpvOS Flasher: Web Serial transport and UI over hardware profiles. Connected,
// the page shows the unit and one button that installs the fpvOS image published
// for it (firmware/catalog.json); a file of your own is under More options.
// Served from a build computer, it also offers the test builds in test-firmware/.
import { LinkLostError, deviceModeOf, deviceModeRequest } from './transports/ascent.js';
import { WebSerialLink } from './transports/web-serial.js';
import {
  USB_FILTERS, CONNECT_FILTERS, getProfile, profileForUsb, profileForDevice, preparationForUsb,
} from './devices/index.js';
import { prepareFirmware, evaluateSelection, flashFirmware, installResult } from './flasher.js';
import { formatBytes } from './devices/common.js';
import { browserPrepareSupport } from './prepare-support.js';

const isOurs = (port) => !!profileForUsb(port.getInfo());
const hex4 = (n) => (n ?? 0).toString(16).padStart(4, '0');
const usbId = (port) => `${hex4(port.getInfo().usbVendorId)}:${hex4(port.getInfo().usbProductId)}`;

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ state --

const state = {
  link: null,
  session: null,
  info: null,
  profile: null,     // positively identified connected hardware, never a UI override
  unlockOverride: null, // null = version-based automatic selection; boolean = manual choice
  prepAssets: null,  // the recovery set being fetched for step 2 (a promise)
  prepProfile: null, // the stock board being prepared (its profile's preparation block)
  p1Stage: null,     // stock P1 preparation: null | 'restart' (step 1 next) | 'recovery' (step 2 next) | 'done'
  connecting: false,
  image: null,       // { file, bytes, parsed, md5 }
  operation: null,
  preparing: false,
  downloading: false,
  catalog: undefined, // published releases, newest first; undefined while loading, null when none
  pick: '',          // what the main button flashes: a release tag, 'file', 'test:<path>', or '' for nothing
  localFile: null,   // the file the user chose, kept to go back to it from a release
  tests: [],         // test builds in test-firmware/: [{ path, url }], newest folder first
  testDir: false,    // whether the server has test-firmware/ (a build computer, not the published site)
  testFile: null,    // the test build last downloaded: { path, file }
  notice: null,      // shown above Connect after a device mode switch let go of the unit
  expectMode: null,  // the device mode just asked for: the unit can come back before it is in it
  get busy() { return this.operation !== null || this.preparing || this.downloading; },
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
    port = await navigator.serial.requestPort({ filters: CONNECT_FILTERS });
  } catch {
    return;   // chooser closed
  }
  // A stock unit that must be prepared first (a P1 or SteadyDigital on its
  // Sirius port) is not yet an fpvOS device, so it cannot just be opened: hand
  // it to preparation, which works from the profile the port belongs to.
  const stock = isOurs(port) ? null : preparationForUsb(port.getInfo());
  if (stock) { await beginPreparation(port, stock); return; }
  await openPort(port);
}

async function openPort(port) {
  if (state.link || state.busy || state.connecting || !isOurs(port)) return;
  state.connecting = true;
  const usbProfile = profileForUsb(port.getInfo());
  const link = new WebSerialLink(port, {
    // fpvOS boards share USB IDs and the same strict transport. Resolve the
    // board from FIND_DEVICE; each stage supplies its reconnect policy.
    acceptPort: (info) => profileForUsb(info) === usbProfile,
    serial: usbProfile.transport.serial,
    filters: usbProfile.meta.usb,
    log,
    onNeedPort: askForPort,
    onPortBack: () => { $('reselect').hidden = true; portRequest = null; },
  });
  setUnitStatus('connecting', 'Connecting…');
  render();
  try {
    await link.open();
  } catch (e) {
    setUnitStatus('error', "Could not open the port. Is another program (the vendor's PC tool, a terminal) using it?");
    log(`open: ${e.message}`, 'error');
    state.connecting = false;
    render();
    return;
  }
  state.link = link;
  state.session = usbProfile.transport.protocol.createSession(link, log, usbProfile.transport);
  watchLink(link);
  // which device this is, and whether another one with the same id is
  // allowed too (the browser does not tell their serial numbers)
  const same = (await navigator.serial.getPorts().catch(() => [])).filter((p) => usbId(p) === usbId(port)).length;
  log(`opened the port of USB device ${usbId(port)}${same > 1 ? ` (${same} such devices allowed on this page)` : ''}`);
  try {
    state.info = await state.session.deviceInfo({ timeoutMs: usbProfile.transport.timeouts.connect ?? 6000 });
    state.profile = profileForDevice(state.info, port.getInfo());
    state.unlockOverride = null;
    log(`connected: ${state.info.firmware || state.info.name} (hw ${state.info.hardware}, sn ${state.info.serial})`);
    // Back from bridge mode, the unit is on USB again before it has reloaded
    // its radio, and says bridge until then: ask until it says the mode asked for.
    const want = state.expectMode;
    state.expectMode = null;
    for (let i = 0; want && state.profile && deviceModeOf(state.info) && deviceModeOf(state.info) !== want && i < 15; i++) {
      setUnitStatus('connecting', `Waiting for ${want} mode…`);
      await new Promise((r) => setTimeout(r, 1000));
      state.info = await state.session.deviceInfo({ timeoutMs: 3000 });
    }
    if (want) log(`the unit says ${deviceModeOf(state.info) ?? state.info.detail}`);
    setUnitStatus(state.profile ? 'ok' : 'error', state.profile ? 'Connected' : 'Connected device has no supported hardware profile.');
  } catch (e) {
    log(`no answer to FIND_DEVICE: ${e.message}`, 'error');
    setUnitStatus('error', 'The port opened but the device does not answer. Wait for it to finish booting, then reconnect. '
      + 'If other USB devices are plugged in (a flight controller, an ESP32 board), unplug them and plug the unit straight into the computer.');
    await link.close();
    state.link = state.session = state.info = state.profile = null;
  }
  state.connecting = false;
  // a downloaded image belongs to the unit it was fetched for; a chosen file is
  // checked again against whatever is connected now
  if (state.image?.catalog) { state.image = null; state.flashed = null; }
  if (!releasesFor(state.profile).some((e) => e.release === state.pick) && state.pick !== 'file'
    && !state.tests.some((t) => `test:${t.path}` === state.pick)) state.pick = '';
  render();
  if (state.profile && state.image?.file) loadFile(state.image.file);
  loadTests();
}

// closed is a new promise after every reopen, and a flash reopens on its own
function watchLink(link) {
  link.closed.then(() => {
    if (state.link === link && !state.busy) disconnected();
  });
}

function disconnected() {
  state.link = state.session = state.info = state.profile = null;
  state.unlockOverride = null;
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
    const port = await navigator.serial.requestPort({ filters: state.link?.filters ?? USB_FILTERS });
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

// Reached only from a Connect click where the chosen port is a stock board's
// Sirius serial id (profile.meta.preparation.serialFilter), never from
// auto-open on plug. Confirm, then run the first step with the port we already
// have, so the restart needs no second chooser.
function showPreparationUi(profile) {
  const { ui } = profile.meta.preparation;
  state.prepProfile = profile;
  $('prep-summary').textContent = `Prepare a ${ui.title.replace(/^Stock /, 'stock ')}`;
  for (const el of document.querySelectorAll('.prep-name')) el.textContent = ui.name;
  $('prep-confirm').textContent = ui.confirm;
  $('p1-enter-bootloader').textContent = ui.restart;
  $('p1-load-recovery').textContent = ui.load;
}
async function beginPreparation(port, profile) {
  if (state.busy || state.connecting || state.link) return;
  const { ui } = profile.meta.preparation;
  // The stock preparation step only works on Linux/ChromeOS (see prepare-support.js).
  // On macOS/Windows, explain why rather than dropping the user into a flow that
  // cannot talk to the bootloader; keep a deliberate opt-out for edge cases.
  const osSupport = browserPrepareSupport(navigator.userAgent);
  if (!osSupport.supported
    && !await ask('Use Linux or ChromeOS for this step', osSupport.message, 'Try anyway')) return;
  const ok = await ask(ui.title, ui.ask, 'Prepare');
  if (!ok) return;
  showPreparationUi(profile);
  $('p1-preparation').open = true;
  $('p1-stock-confirm').checked = true;
  state.p1Stage = 'restart';
  render();
  await prepareStock(false, port);
}

// A stock unit uses Web Serial to enter U-Boot, then WebHID for RAM recovery.
// Each chooser must run directly from its own user gesture after re-enumeration;
// the restart can reuse the port Connect already picked (presetPort).
let preparationAbort = null;
async function prepareStock(loadRecovery, presetPort = null) {
  if (state.busy || state.connecting || state.link || !$('p1-stock-confirm').checked) return;
  const profile = state.prepProfile ?? getProfile('fpvos-p1-air');
  const preparation = profile.meta.preparation, { ui } = preparation;
  state.preparing = true;
  preparationAbort = new AbortController();
  const signal = preparationAbort.signal;
  const progress = (text) => { $('p1-preparation-status').textContent = text; };
  render();
  try {
    if (loadRecovery) {
      // The recovery images were fetched and checked while step 1 ran, so the
      // bootloader is spoken to the moment its device is chosen: it is only
      // up for a limited while, and the working order is assets first, chooser, I/O.
      const assets = await (state.prepAssets ?? preparation.loadAssets({ signal })).catch(() => null) ?? undefined;
      const [device] = await navigator.hid.requestDevice({ filters: [preparation.hidFilter] });
      if (!device) { progress(`No bootloader selected. Select the same ${ui.serialName} when it appears as USB download gadget.`); return; }
      await preparation.loadRecovery(device, { stockVersion: preparation.stockVersion, assets, signal, progress, log });
      state.prepAssets = null;
      state.p1Stage = 'done';
      progress(`Recovery boot requested. Wait for USB to reconnect, then click Connect above and select the ${ui.serialName} serial port. Choose your ${ui.name} .fwu file and click Flash.`);
      log(`${ui.name} recovery loaded through WebHID; connect its new serial port to install firmware.`);
    } else {
      const port = presetPort ?? await navigator.serial.requestPort({ filters: [preparation.serialFilter] });
      state.prepAssets = preparation.loadAssets({ signal });   // fetched and verified now, used by step 2
      state.prepAssets.catch(() => {});
      await preparation.enterBootloader(port, { signal });
      state.p1Stage = 'recovery';
      progress(`Restart requested. Wait for USB download gadget, then select it with “${ui.load.replace(/^\d+\. /, '')}”. If it stays as Sirius, allow stock firmware to finish starting and retry “${ui.restart.replace(/^\d+\. /, '')}”.`);
      log(`Requested stock ${ui.name} USB bootloader through Web Serial.`);
    }
  } catch (e) {
    const message = e.name === 'NotFoundError' ? 'No device selected. You can try again.'
      : `${e.message} If the unit is still in USB download mode, retry “${ui.load.replace(/^\d+\. /, '')}”; power-cycle it to return to its installed firmware.`;
    progress(message); log(`${ui.name} preparation: ${message}`, 'warn');
  } finally { state.preparing = false; preparationAbort = null; render(); }
}

// --------------------------------------------------------------- firmware --

// An image as is, or the one inside a .zip / .xz / .gz / .tar. catalog is the
// published entry it was downloaded for, null for a file the user chose.
async function loadFile(file, catalog = null) {
  if (!file || state.busy) return;
  state.unlockOverride = null;
  state.flashed = null;
  const current = { file, catalog, loading: 'Opening' };
  state.image = current;
  render();
  let opened;
  try {
    opened = await prepareFirmware(file, {
      profile: state.profile,
      onProgress: (text) => {
        if (state.image !== current) return;
        current.loading = text;
        $('file-status').textContent = `${text}…`;
      },
    });
  } catch (e) {
    if (state.image !== current) return;
    state.image = { file, catalog, error: e.message };
    log(`file ${file.name}: ${e.message}`, 'error');
    render();
    return;
  }
  if (state.image !== current) return;   // another file was dropped meanwhile
  const { bytes, name, trail, parsed, md5 } = opened;
  state.image = { file, catalog, ...opened };
  if (catalog && opened.md5 && opened.md5 !== catalog.md5) {
    state.image = { file, catalog, error: 'The downloaded firmware is not the published one (MD5 differs). Reload the page and try again.' };
  }
  log(`file ${[...trail, name].join(' > ')}: ${bytes.length} bytes, ${parsed.boardName ?? 'not an image'} `
    + `${parsed.versionText ?? ''}${md5 ? `, md5 ${md5}` : ''}`);
  render();
}

// ---------------------------------------------------------------- catalog --

// The images this page offers, published next to it from the fpvOS releases:
// firmware/catalog.json = { releases: [{ release, images: [{ devices: [profile id], file, name, size, md5 }] }] },
// newest release first; file relative to firmware/, name the one it is sent as.
async function loadCatalog() {
  let catalog = null;
  try {
    const r = await fetch('firmware/catalog.json', { cache: 'no-cache' });
    if (r.ok) catalog = await r.json();
  } catch { /* none */ }
  state.catalog = Array.isArray(catalog?.releases)
    ? catalog.releases.filter((r) => r.release && Array.isArray(r.images)) : null;
  if (state.catalog) log(`firmware releases: ${state.catalog.map((r) => r.release).join(', ')}`);
  render();
}

// The published images for a unit, newest first: [{ release, ...image }]
const releasesFor = (profile) => ((profile && state.catalog) || []).flatMap((r) => {
  const image = r.images.find((i) => i.devices?.includes(profile.meta.id));
  return image ? [{ ...image, release: r.release }] : [];
});
const pickedRelease = () => releasesFor(state.profile).find((e) => e.release === state.pick) ?? null;
// a file of your own or a test build: flashed as it is, with all its checks shown
const pickedIsFile = () => state.pick === 'file' || state.pick.startsWith('test:');
const pickedFile = () => state.pick === 'file' ? state.localFile
  : state.testFile && state.pick === `test:${state.testFile.path}` ? state.testFile.file : null;

async function download(url, name, size, onProgress) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`the server answered ${r.status}`);
  const total = size || Number(r.headers.get('content-length')) || 0;
  const reader = r.body.getReader();
  const parts = [];
  for (let got = 0; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (total) onProgress(Math.min(got / total, 1));
  }
  return new File(parts, name);
}

// ------------------------------------------------------------ test builds --

// Images just built, before any release: on the build computer, test-firmware/
// next to index.html (a folder, or a link to the build output) served with a
// directory listing (python3 -m http.server). Every firmware file in it and in
// the folders in it is offered as a test build, whichever unit is connected:
// picking one shows its checks, which say whether this unit can take it. The
// published site has no such folder.
const TEST_DIR = new URL('test-firmware/', location.href);
const TEST_FILE = /\.(img|fwu|zip|xz|gz|tgz|tar)$/i;

// the links of a directory listing to what is inside it, null for no listing
async function listDir(dir) {
  const r = await fetch(dir, { cache: 'no-cache' });
  if (!r.ok || !/html/.test(r.headers.get('content-type') ?? '')) return null;
  const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
  const urls = [...doc.querySelectorAll('a[href]')].map((a) => new URL(a.getAttribute('href'), dir))
    .filter((u) => !u.search && !u.hash && u.href.startsWith(dir.href) && u.href !== dir.href);
  return [...new Map(urls.map((u) => [u.href, u])).values()];
}

// Read when the page opens and again on Connect, when the firmware list opens
// and when the page comes back to the front, so a build copied in after the page
// was opened shows up without a reload. One read at a time.
let testScan = null;
function loadTests() {
  if (state.busy) return Promise.resolve();
  testScan ??= scanTests().finally(() => { testScan = null; });
  return testScan;
}

async function scanTests() {
  const found = [];
  let top = null;
  try {
    top = await listDir(TEST_DIR);
    for (const u of top ?? []) {
      found.push(...((u.pathname.endsWith('/') ? await listDir(u) : [u]) ?? []).filter((f) => !f.pathname.endsWith('/')));
    }
  } catch { /* none */ }
  const tests = found.map((url) => ({ url, path: decodeURIComponent(url.href.slice(TEST_DIR.href.length)) }))
    .filter((t) => TEST_FILE.test(t.path))
    .sort((a, b) => (a.path < b.path ? 1 : -1));
  const names = (list) => list.map((t) => t.path).join(', ');
  const listed = names(tests) !== names(state.tests);
  const changed = listed || state.testDir !== !!top;
  state.testDir = !!top;
  state.tests = tests;
  if (listed && tests.length) log(`test builds in ${TEST_DIR.pathname}: ${names(tests)}`);
  // a test build picked before it was taken away
  if (state.pick.startsWith('test:') && !tests.some((t) => `test:${t.path}` === state.pick)) state.pick = '';
  if (changed) render();
}

// Fetched again on every pick, so a rebuilt image under the same name is the new one.
async function loadTest(path) {
  const test = state.tests.find((t) => t.path === path);
  if (!test || state.busy) return;
  const text = `Fetching ${path}`;
  state.downloading = true;
  render();
  setProgress({ stage: 'download', frac: 0, text });
  try {
    const file = await download(test.url, path.split('/').pop(), 0, (frac) => setProgress({ stage: 'download', frac, text }));
    state.testFile = { path, file };
    log(`fetched test build ${path}: ${formatBytes(file.size)}`);
  } catch (e) {
    state.flashed = { ok: false, text: `Could not fetch ${path} (${e.message}).` };
    log(`test build ${path}: ${e.message}`, 'error');
    setProgress({ stage: 'failed', frac: null, text: 'Failed' });
    return;
  } finally {
    state.downloading = false;
    render();
  }
  if (state.pick === `test:${path}`) loadFile(state.testFile.file);
}

// A file of your own: it becomes the selection, checked against the unit.
function chooseLocal(file) {
  if (!file || state.busy) return;
  state.localFile = file;
  state.pick = 'file';
  loadFile(file);
}

function pick(value) {
  if (state.busy) return;
  state.pick = value;
  state.flashed = null;
  state.unlockOverride = null;
  if (value.startsWith('test:')) loadTest(value.slice(5));
  else if (value === 'file' && state.localFile && state.image?.file !== state.localFile) loadFile(state.localFile);
  else render();
}

// The main button: the chosen file as it is, or the chosen release downloaded,
// checked against the published MD5, then the same flash.
async function go() {
  if (pickedIsFile()) { await flash(); return; }
  const entry = pickedRelease();
  if (!entry || !state.session || state.busy || state.connecting) return;
  const text = `Downloading fpvOS ${entry.release}`;
  state.downloading = true;
  state.flashed = null;
  render();
  setProgress({ stage: 'download', frac: 0, text });
  let file;
  try {
    file = await download(new URL(entry.file, new URL('firmware/', location.href)), entry.name, entry.size,
      (frac) => setProgress({ stage: 'download', frac, text }));
    log(`downloaded ${entry.file}: ${formatBytes(file.size)}`);
  } catch (e) {
    state.flashed = { ok: false, text: `The download failed (${e.message}). Check the internet connection and try again.` };
    log(`download ${entry.file}: ${e.message}`, 'error');
    setProgress({ stage: 'failed', frac: null, text: 'Failed' });
    return;
  } finally {
    state.downloading = false;
    render();
  }
  await loadFile(file, entry);
  if (state.image?.catalog === entry && state.pick === entry.release && canFlash()) await flash();
}

// Problems from the image and the unit together: [{level, text}]
function selection() {
  return state.operation?.plan ?? evaluateSelection({ info: state.info, profile: state.profile, image: state.image,
    unlockOverride: state.unlockOverride });
}

// ------------------------------------------------------------------ flash --

const STAGES = ['download', 'unlock', 'clean', 'upload', 'install', 'restart'];
let abort = null;

async function flash() {
  const img = state.image;
  if (!canFlash()) return;
  const profile = state.profile;
  const session = state.session, info = state.info, plan = selection();
  const unlock = plan.unlockSelected;
  const model = profile.meta.describe(info).model;
  const title = img.catalog ? `Install fpvOS ${img.catalog.release} on your ${model}?`
    : `${unlock ? 'Unlock and flash' : 'Flash'} ${img.parsed.remoteName}?`;
  const ok = await ask(title,
    `${plan.bootstrapSelected ? 'Upload the experimental RAM updater, then select this VRX’s new USB port. Disconnect other VRXs. No backup export is performed. ' : ''}${unlock ? profile.meta.unlock.notice + ' ' : ''}${plan.executionProfile.meta.notices.flash} This flasher is experimental: use it at your own risk.`,
    img.catalog ? 'Install' : unlock ? 'Unlock and flash' : 'Flash');
  if (!ok || !canFlash() || state.image !== img || state.profile !== profile || state.session !== session
    || state.info !== info || selection().unlockSelected !== unlock) return;

  state.operation = Object.freeze({ plan, session, info, image: img });
  state.flashed = null;
  abort = new AbortController();
  render();
  setProgress({ stage: 'clean', frac: 0, text: 'Starting' });
  const t0 = Date.now();
  try {
    const after = await flashFirmware(session, profile, img, {
      info, usbInfo: state.link.port.getInfo(),
      unlock,
      progress: setProgress, log, signal: abort.signal,
    });
    const secs = Math.round((Date.now() - t0) / 1000);
    // An fpvOS release: said to run only once the unit, back, says it does.
    const meta = after ? profileForDevice(after, state.link.port.getInfo())?.meta ?? profile.meta : null;
    state.flashed = img.catalog
      ? installResult({ model, release: img.catalog.release, secs, now: after ? meta.describe(after) : null,
        answers: profile.meta.releaseAnswers })
      : { ok: true, text: after ? `Flashed in ${secs} s. The device now reports ${after.firmware || after.name}.`
        : `Flashed in ${secs} s. The device is restarting; reconnect to check it.` };
    if (after) { state.info = after; state.profile = profileForDevice(after, state.link.port.getInfo()); state.unlockOverride = null; }
    log(state.flashed.text);
  } catch (e) {
    state.flashed = { ok: false, text: e.message };
    log(`flash failed: ${e.message}`, 'error');
    setProgress({ stage: 'failed', frac: null, text: 'Failed' });
  } finally {
    state.operation = null;
    abort = null;
    $('reselect').hidden = true;
    if (state.link?.writer) watchLink(state.link);
    else if (state.link) disconnected();
    render();
  }
}

function canFlash() {
  return !!state.session && !state.busy && !state.connecting && selection().canFlash;
}

let currentStage = null;

function setProgress({ stage, frac, text }) {
  currentStage = stage;
  if (frac != null) $('bar').style.width = `${(frac * 100).toFixed(1)}%`;
  $('bar').dataset.state = stage === 'failed' ? 'failed' : stage === 'done' ? 'done' : 'run';
  $('stage-text').textContent = text;
  $('cancel').hidden = !state.busy || !['unlock', 'clean', 'upload'].includes(stage);
  const idx = STAGES.indexOf(stage);
  document.querySelectorAll('#stages li').forEach((li, i) => {
    li.dataset.state = stage === 'done' || i < idx ? 'done' : i === idx ? 'active' : '';
  });
}

async function networkMode() {
  if (!state.session || !state.profile?.transport.protocol.networkMode || state.busy) return;
  if (!await ask('Enable USB network mode?', state.profile.meta.notices.network, 'Enable')) return;
  try {
    await state.profile.transport.protocol.networkMode(state.session);
  } catch (e) {
    if (!(e instanceof LinkLostError)) log(`network mode: ${e.message}`, 'warn');
  }
  log('asked the device to switch to network mode');
}

// What each mode is, under the switch, and what to expect after switching.
// Bridge mode is kept across power cycles where the unit saves it (the Lite's,
// fpvOS_usb SAVED_MODE); a unit without (the P1, meta.bridgeKept false) starts
// in normal mode again.
const bridgeKept = () => state.profile?.meta.bridgeKept !== false;
const DEVICE_MODE_ABOUT = Object.freeze({
  normal: () => 'Normal: the unit flies with its own radio.',
  bridge: () => 'Bridge: its AR8030 radio chip is on USB, for a computer to use as its own. ' + (bridgeKept()
    ? 'It stays in bridge mode, also after a power cycle, until you switch it back here.'
    : 'It stays in bridge mode until you switch it back here or it restarts: it starts in normal mode.'),
});
const DEVICE_MODE_ASK = Object.freeze({
  normal: () => 'The unit stops being a USB radio and flies with its own radio again.',
  bridge: () => 'The unit stops its own radio and video, and its AR8030 shows up on USB for the device it is '
    + `plugged into. It stays that way${bridgeKept() ? ', also after a power cycle,' : ''} until you switch it back to normal here`
    + (bridgeKept() ? '.' : ' or it restarts.'),
});
// back in normal mode the page shows the unit again by itself: nothing to say
const DEVICE_MODE_DONE = Object.freeze({
  normal: () => null,
  bridge: () => (bridgeKept()
    ? 'The unit is in bridge mode: plug it into the device that uses its radio. To switch it back, connect it here again.'
    : 'The unit is in bridge mode until it restarts: keep it powered if you move its USB cable to the device that '
      + 'uses its radio. To switch it back, connect it here again, or power it off and on.'),
});

async function switchDeviceMode(to) {
  const from = deviceModeOf(state.info), name = deviceModeRequest(from, to);
  const session = state.session;
  if (!session || !name || state.busy || !state.profile?.transport.protocol.deviceMode) return;
  const restart = from === 'update';
  if (!restart && !await ask(`Switch to ${to} mode?`, DEVICE_MODE_ASK[to](), 'Switch')) return;
  if (state.session !== session || state.busy) return;
  try {
    const r = await state.profile.transport.protocol.deviceMode(session, name);
    if (r.status !== 0) {
      state.flashed = { ok: false, text: `The unit refused ${to} mode: ${r.detail || `status ${r.status}`}.` };
      log(`${to} mode refused: ${r.detail || `status ${r.status}`}`, 'error');
      render();
      return;
    }
    log(`the unit is switching to ${to} mode${r.detail ? ` (${r.detail})` : ''}`);
  } catch (e) {
    if (!(e instanceof LinkLostError)) {
      state.flashed = { ok: false, text: `Switching to ${to} mode failed: ${e.message}` };
      log(`${to} mode: ${e.message}`, 'error');
      render();
      return;
    }
    log(`the unit went away while switching to ${to} mode`, 'warn');
  }
  // The unit re-enumerates (bridge mode under other USB IDs): this port is done.
  state.notice = restart ? 'The unit is restarting normally. Connect it again in a few seconds.' : DEVICE_MODE_DONE[to]();
  state.expectMode = to;
  await state.link?.close().catch(() => {});
  render();
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

function render() {
  const plan = selection();
  const supported = 'serial' in navigator;
  $('unsupported').hidden = supported;
  if (!supported && !window.isSecureContext) {
    $('unsupported').textContent = `Chrome only allows USB serial on https:// pages and on localhost, and this page `
      + `was opened from ${location.origin}. Open it as http://localhost on the computer that serves it, or in `
      + `chrome://flags enable "Insecure origins treated as secure" for ${location.origin}, then relaunch Chrome.`;
  }

  // nothing connected: Connect and its help; connected: the unit
  const info = state.info;
  $('start').hidden = !!state.link;
  $('device').hidden = !state.link;
  $('connect').disabled = !supported || state.busy || state.connecting;
  $('disconnect').disabled = state.busy || state.connecting;
  $('developer').hidden = !new URLSearchParams(location.search).has('dev');
  if (state.link) state.notice = null;
  $('start-note').hidden = !state.notice;
  $('start-note').textContent = state.notice ?? '';

  // fpvOS's device modes: the switch, or the way out of update mode. In bridge
  // mode the radio is another device's: nothing to install until it is back.
  const deviceMode = state.session && state.profile?.transport.protocol.deviceMode ? deviceModeOf(state.info) : null;
  // the switch, under Advanced, on firmware that keeps bridge mode, and always
  // for a unit already in it: then the only way back, so Advanced opens
  $('advanced').hidden = !(deviceMode === 'bridge' || deviceMode === 'normal' && state.profile.meta.deviceModes?.(state.info));
  if (deviceMode === 'bridge' && $('advanced').dataset.mode !== 'bridge') $('advanced').open = true;
  $('advanced').dataset.mode = deviceMode ?? '';
  for (const to of ['normal', 'bridge']) {
    $(`mode-${to}`).setAttribute('aria-checked', String(deviceMode === to));
    $(`mode-${to}`).disabled = state.busy || state.connecting || !deviceModeRequest(deviceMode, to) && deviceMode !== to;
  }
  $('device-mode-note').textContent = DEVICE_MODE_ABOUT[deviceMode]?.() ?? '';
  $('update-mode').hidden = deviceMode !== 'update';
  $('mode-restart').disabled = state.busy || state.connecting;
  $('firmware').hidden = deviceMode === 'bridge';
  const about = info && state.profile ? state.profile.meta.describe(info) : null;
  $('device-name').textContent = about?.model ?? (info ? 'Unsupported device' : 'Connecting…');
  $('device-firmware').textContent = about ? `Runs ${about.firmware}` : '';

  // what to flash: the newest release for this unit unless something else was chosen
  const releases = releasesFor(state.profile);
  if (!state.pick && releases.length) state.pick = releases[0].release;
  if (!state.pick && state.localFile) state.pick = 'file';
  const options = [...releases.map((e, i) => [e.release, `fpvOS ${e.release}${i ? '' : ' · latest'}`]),
    // a test build's folder (one per build) is a line under its name in the list
    ...state.tests.map((t) => [`test:${t.path}`, `${t.path.split('/').pop()} · test`,
      t.path.includes('/') ? t.path.slice(0, t.path.lastIndexOf('/')) : '']),
    ...(state.localFile ? [['file', `Local file: ${state.localFile.name}`]] : [])];
  // only test builds: none is fetched before it is chosen
  if (!state.pick && options.length) options.unshift(['', 'Choose a test build']);
  if (!options.length) options.push(['', state.catalog === undefined ? 'Looking for fpvOS releases…' : 'No fpvOS release for this device']);
  const key = JSON.stringify(options);
  if ($('release').dataset.key !== key) {
    $('release').dataset.key = key;
    $('release').replaceChildren(...options.map(([value, text, sub]) => {
      const o = el('option', text);
      o.value = value;
      if (sub) o.dataset.sub = sub;
      return o;
    }));
  }
  $('release').value = state.pick;
  $('release').disabled = state.busy || state.connecting || options.length < 2;
  renderPicker();
  $('choose-file').disabled = state.busy;
  $('netmode').disabled = !state.session || !state.profile?.transport.protocol.networkMode || state.busy || state.connecting;
  const p1Available = supported && 'hid' in navigator;
  $('p1-preparation').hidden = state.p1Stage == null;
  $('p1-browser-support').hidden = p1Available;
  $('p1-stock-confirm').disabled = state.busy;
  // Walk the two steps: exactly one is the lit, clickable action; the finished
  // step is greyed and ticked, and the later step stays blocked until its turn.
  const p1Ready = p1Available && $('p1-stock-confirm').checked && !state.busy && !state.connecting && !state.link;
  setP1Step($('p1-enter-bootloader'), p1Ready && state.p1Stage === 'restart', state.p1Stage === 'recovery' || state.p1Stage === 'done');
  setP1Step($('p1-load-recovery'), p1Ready && state.p1Stage === 'recovery', state.p1Stage === 'done');
  $('p1-preparation-cancel').hidden = !state.preparing;
  const unlockFeature = state.profile?.meta.unlock;
  $('unlock-options').hidden = !unlockFeature || !pickedIsFile();
  $('unlock-before-flash').disabled = state.busy || !plan.unlockAvailable;
  $('unlock-before-flash').checked = plan.unlockSelected;
  $('unlock-label').textContent = unlockFeature?.label ?? '';
  $('unlock-hint').textContent = !plan.unlockAvailable ? 'Connect a healthy normal-mode standard VRX with a valid reported firmware version to use preflash unlock.'
    : state.unlockOverride != null ? `Manually ${plan.unlockSelected ? 'enabled' : 'disabled'} for this selection. Signed firmware validation remains enabled.`
    : plan.automaticUnlock ? `Automatically selected for downgrade: ${state.image.parsed.versionText} < ${plan.currentVersion.join('.')}. One-shot RAM overlay; signed firmware validation remains enabled.`
    : !state.image?.md5 || state.image.parsed.profileId !== state.profile.meta.id ? 'Choose a valid matching image to compare with the connected firmware. You can also select unlock manually.'
    : 'Automatically off for equal/newer images. You can enable it manually; signed firmware validation remains enabled.';
  $('stage-unlock').hidden = !plan.unlockSelected;
  $('profile-hint').textContent = state.profile ? `Detected: ${state.profile.meta.name}.`
    : 'Connect a device to select its image from an archive.';
  $('unit-info').hidden = !info;
  if (info) {
    const rows = [
      ['Profile', state.profile?.meta.name ?? 'unsupported'],
      // an fpvOS unit reports a stock firmware name for the vendor's tools
      ['Firmware', about?.fpvos ? about.firmware : info.firmware],
      // fpvOS's own updater (VRX, P1) reports the bundle it installed
      [/^[0-9a-f]{64}$/.test(info.firmware) ? 'Installed bundle' : 'Reported as', about?.fpvos ? info.firmware : ''],
      ['Device', info.name],
      ['Hardware', info.hardware],
      ['Serial', info.serial],
      ['SDK', about?.fpvos ? '' : info.sdk],
      // 0: an updater that does not measure it
      ['CPU temperature', info.cpuTemp ? `${info.cpuTemp} °C` : ''],
      ['Max chunk', info.maxChunk ? formatBytes(info.maxChunk) : ''],
    ].filter(([, v]) => v);
    $('unit-info').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', k), el('dd', v)]));
  }

  // the chosen file's details; a downloaded release is shown only by its checks
  const image = state.image;
  const fromCatalog = !!image?.catalog;
  const img = fromCatalog ? null : image;
  const current = pickedIsFile() ? !!img && img.file === pickedFile() : fromCatalog && image.catalog.release === state.pick;
  $('image-details').hidden = !pickedIsFile() || !current;
  $('file').disabled = state.busy;
  $('file-info').hidden = !img;
  $('file-status').hidden = !img?.loading;
  $('file-status').textContent = img?.loading ? `${img.loading}…` : '';
  const p = img?.parsed;
  $('file-meta').hidden = !p;
  $('sections').hidden = !p?.sections.length;
  if (img) $('file-name').textContent = img.name ?? img.file.name;
  if (p) {
    const headings = $('sections').querySelectorAll('th');
    img.view.columns.forEach((text, i) => { headings[i].textContent = text; });
    $('file-meta').replaceChildren(...img.view.facts.flatMap(([k, v, cls]) => [el('dt', k), el('dd', v, cls)]));
    $('sections').querySelector('tbody').replaceChildren(...img.view.rows.map((row) => {
      const tr = document.createElement('tr');
      row.forEach((text, i) => tr.append(el('td', text, i === 1 || i === 2 ? 'num' : '')));
      return tr;
    }));
  }

  // checks of what is selected: all of them for a file, only what needs
  // attention for a published release
  const cs = current ? plan.issues : [];
  const shown = fromCatalog ? cs.filter((c) => c.level !== 'info') : cs;
  $('checks').replaceChildren(...shown.map((c) => {
    const li = el('li', c.text);
    li.dataset.level = c.level;
    return li;
  }));
  $('checks').hidden = !shown.length;

  // the main button
  const entry = pickedRelease();
  const installed = !!state.flashed?.ok && current;
  const errors = cs.some((c) => c.level === 'error');
  $('flash').hidden = installed;
  $('flash').disabled = state.busy || state.connecting || !state.session
    || (pickedIsFile() ? !current || !canFlash() : !entry);
  $('flash').textContent = state.downloading ? 'Downloading…'
    : state.operation ? (fromCatalog ? 'Installing…' : 'Flashing…')
    : pickedIsFile() ? (plan.unlockSelected ? 'Unlock and flash' : 'Flash this file')
    : entry ? `Install fpvOS ${entry.release}` : 'Install';
  $('cancel').hidden = !state.operation || !['unlock', 'clean', 'upload'].includes(currentStage);
  $('progress').hidden = !state.operation && !state.downloading && !state.flashed;
  $('keep-plugged').hidden = !state.operation;
  $('stage-download').hidden = !fromCatalog && !state.downloading;
  $('result').hidden = !state.flashed;
  $('result-log').hidden = !state.flashed || state.flashed.ok;
  if (state.flashed) {
    $('result').dataset.ok = state.flashed.ok;
    $('result').textContent = state.flashed.text;
  }
  $('hint').textContent = !state.link ? 'Connect a device first.'
    : state.busy || state.connecting ? ''
    : installed ? 'Done. You can unplug the device.'
    : !state.pick ? (state.catalog === undefined ? 'Looking for fpvOS releases…'
      : state.tests.length ? 'Choose a test build, or a local file.'
      : state.testDir ? 'No fpvOS release for this device, and no test build in test-firmware/. Choose a local file.'
      : 'This page has no fpvOS release for this device yet. Choose a local file.')
    : pickedIsFile() ? (!current ? 'Choose a firmware image.' : img.loading ? 'Unpacking the firmware.'
      : errors ? 'Fix the problems above first.' : '')
    : errors ? 'This release cannot be installed on this device.'
    : about?.fpvos ? 'It already runs fpvOS: this installs the chosen release over it.' : '';
}

// The firmware list, drawn by the page over the hidden select: a button that
// shows the choice, and a list that opens under it (mouse or arrow keys).
// A long name is cut short in the button and wraps in the list; tags stay whole.
function pickerItem(option, i) {
  const [name, ...tags] = option.textContent.split(' · ');
  const li = document.createElement('li');
  const label = el('span', name, 'name');
  if (option.dataset.sub && i >= 0) label.append(el('small', option.dataset.sub));
  li.append(label);
  li.id = `release-option-${i}`;
  li.setAttribute('role', 'option');
  li.dataset.value = option.value;
  li.setAttribute('aria-selected', String(option.value === $('release').value));
  for (const t of tags) li.append(el('span', t, 'tag'));
  return li;
}

function renderPicker() {
  const select = $('release'), button = $('release-button'), list = $('release-list');
  const options = [...select.options];
  const chosen = options.find((o) => o.value === select.value) ?? options[0];
  button.replaceChildren(...(chosen ? [...pickerItem(chosen, -1).childNodes] : []));
  button.disabled = select.disabled;
  if (select.disabled) closePicker();
  list.replaceChildren(...options.map(pickerItem));
}

let pickerActive = -1;
function openPicker() {
  if ($('release-button').disabled) return;
  loadTests();
  const items = [...$('release-list').children];
  $('release-list').hidden = false;
  $('release-button').setAttribute('aria-expanded', 'true');
  setPickerActive(Math.max(0, items.findIndex((li) => li.getAttribute('aria-selected') === 'true')));
}
function closePicker() {
  $('release-list').hidden = true;
  $('release-button').setAttribute('aria-expanded', 'false');
}
function setPickerActive(i) {
  const items = [...$('release-list').children];
  pickerActive = Math.min(Math.max(i, 0), items.length - 1);
  items.forEach((li, n) => li.classList.toggle('active', n === pickerActive));
  items[pickerActive]?.scrollIntoView({ block: 'nearest' });
  $('release-button').setAttribute('aria-activedescendant', items[pickerActive]?.id ?? '');
}
function choosePicked(value) {
  closePicker();
  if (value == null) return;
  $('release-button').focus();
  if (value !== $('release').value) { $('release').value = value; $('release').dispatchEvent(new Event('change')); }
}

function el(tag, text, cls) {
  const e = document.createElement(tag);
  e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

// A preparation step is either the lit next action (enabled, lemon green),
// finished (greyed and ticked), or still blocked (plain greyed, not yet).
function setP1Step(btn, active, done) {
  btn.disabled = !active;
  btn.classList.toggle('step-active', active);
  btn.classList.toggle('step-done', !active && done);
}

// ------------------------------------------------------------------ wiring --

function init() {
  render();
  loadCatalog();
  loadTests();
  // a build copied into test-firmware/ while the page was open
  window.addEventListener('focus', () => loadTests());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadTests(); });
  if (!('serial' in navigator)) return;

  $('connect').onclick = connect;
  $('p1-stock-confirm').onchange = () => {
    state.p1Stage = $('p1-stock-confirm').checked ? (state.p1Stage ?? 'restart') : null;
    render();
  };
  $('p1-enter-bootloader').onclick = () => prepareStock(false);
  $('p1-load-recovery').onclick = () => prepareStock(true);
  $('p1-preparation-cancel').onclick = () => preparationAbort?.abort();
  $('disconnect').onclick = disconnect;
  $('netmode').onclick = networkMode;
  for (const to of ['normal', 'bridge']) $(`mode-${to}`).onclick = () => { if (deviceModeOf(state.info) !== to) switchDeviceMode(to); };
  $('mode-restart').onclick = () => switchDeviceMode('normal');
  $('reselect').onclick = reselect;
  $('flash').onclick = go;
  $('release').onchange = () => pick($('release').value);
  $('release-button').onclick = () => ($('release-list').hidden ? openPicker() : closePicker());
  $('release-list').onclick = (e) => { const li = e.target.closest('li'); if (li) choosePicked(li.dataset.value); };
  $('release-list').onmousemove = (e) => {
    const li = e.target.closest('li');
    if (li) setPickerActive([...$('release-list').children].indexOf(li));
  };
  $('release-button').onkeydown = (e) => {
    const open = !$('release-list').hidden;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) openPicker();
      else setPickerActive(pickerActive + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (open && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      choosePicked($('release-list').children[pickerActive]?.dataset.value);
    } else if (open && (e.key === 'Escape' || e.key === 'Tab')) closePicker();
  };
  document.addEventListener('click', (e) => { if (!e.target.closest('.picker')) closePicker(); });
  $('choose-file').onclick = () => $('file').click();
  $('result-log').onclick = () => navigator.clipboard.writeText(logText());
  $('unlock-before-flash').onchange = () => { state.unlockOverride = $('unlock-before-flash').checked; render(); };
  $('cancel').onclick = () => { abort?.abort(); log('cancelling after the current step', 'warn'); };
  // cleared after each pick: choosing the same file again fires no change
  // event otherwise, and the pick would be silently ignored
  $('file').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    chooseLocal(f);
  };
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

  window.addEventListener('beforeunload', (e) => { if (state.busy) e.preventDefault(); });
  // a file dropped anywhere on the page is a local file; the browser would
  // otherwise open it and leave the page
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); chooseLocal(e.dataTransfer.files[0]); });

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
