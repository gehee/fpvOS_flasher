// Fetch and verify all recovery assets before any bootloader RAM modification.
import { P1HidRecovery, P1_RAM_FILES, P1_GND_RAM_FILES, STEADYDIGITAL_RAM_FILES, p1Bootloader, sha256 } from '../transports/p1-hid.js';
export { enterP1Bootloader, enterSteadyDigitalBootloader, P1_STOCK_USB, STEADYDIGITAL_STOCK_USB, P1_HID_FILTER, P1_STOCK_VERSIONS, P1_GND_STOCK_VERSIONS, P1_AUTO } from '../transports/p1-hid.js';
export const P1_RECOVERY_BASE = new URL('../assets/p1-updater/browser-v1/', import.meta.url);
export const P1_RECOVERY_MANIFEST_SHA256 = '0e67849fc275e1a341a104eb662e881c2b70b235976c9b9ebee051fa75220e5b';
export const P1_GND_RECOVERY_BASE = new URL('../assets/p1-gnd-updater/browser-v1/', import.meta.url);
export const P1_GND_RECOVERY_MANIFEST_SHA256 = '8398175b06463cf9358de6fb559dfebc9f52fc7e952b9c7bc126f89c827a4a2d';
export const STEADYDIGITAL_RECOVERY_BASE = new URL('../assets/steadydigital-updater/browser-v1/', import.meta.url);
export const STEADYDIGITAL_RECOVERY_MANIFEST_SHA256 = '6b8f2b1e2ef8bf5603db10e0767177ce2c9daf93a45215ad8829bc04804f46f3';
async function fetchBytes(name, limit, fetcher, signal, base = P1_RECOVERY_BASE) {
  const response = await fetcher(new URL(name, base), { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`Cannot load P1 recovery ${name}: HTTP ${response.status}.`);
  const reader = response.body.getReader(), parts = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > limit) throw new Error(`P1 recovery ${name} exceeds its size limit.`);
      parts.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
// Fetch and verify one board's recovery set before any bootloader RAM is touched.
async function loadRecovery({ label, base, manifestSha256, boardId, ramFiles, fetcher, signal }) {
  const raw = await fetchBytes('manifest.json', 8192, fetcher, signal, base);
  if (await sha256(raw) !== manifestSha256) throw new Error(`${label} recovery manifest SHA-256 mismatch.`);
  const manifest = JSON.parse(new TextDecoder().decode(raw));
  if (manifest.format !== 1 || manifest.board_id !== boardId || manifest.version !== 'browser-v1') throw new Error(`Unsupported ${label} recovery manifest.`);
  const files = [];
  for (const [name, [address, limit]] of Object.entries(ramFiles)) {
    const entry = manifest.files[name];
    if (!Number.isInteger(entry?.size) || entry.size < 1 || entry.size > limit || entry.address !== address || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`Invalid ${label} recovery asset metadata.`);
    const bytes = await fetchBytes(name, entry.size, fetcher, signal, base);
    if (bytes.length !== entry.size || await sha256(bytes) !== entry.sha256) throw new Error(`${label} recovery ${name} size/SHA-256 mismatch.`);
    files.push({ name, bytes });
  }
  return { manifest, files };
}
export const loadP1Recovery = ({ fetcher = globalThis.fetch, signal } = {}) => loadRecovery({ label: 'P1', base: P1_RECOVERY_BASE,
  manifestSha256: P1_RECOVERY_MANIFEST_SHA256, boardId: 1345409867, ramFiles: P1_RAM_FILES, fetcher, signal });
// The P1 ground units share one recovery set, device tree included.
export const loadP1GndRecovery = ({ fetcher = globalThis.fetch, signal } = {}) => loadRecovery({ label: 'P1 ground', base: P1_GND_RECOVERY_BASE,
  manifestSha256: P1_GND_RECOVERY_MANIFEST_SHA256, boardId: 1345406788, ramFiles: P1_GND_RAM_FILES, fetcher, signal });
export const loadSteadyDigitalRecovery = ({ fetcher = globalThis.fetch, signal } = {}) => loadRecovery({ label: 'SteadyDigital', base: STEADYDIGITAL_RECOVERY_BASE,
  manifestSha256: STEADYDIGITAL_RECOVERY_MANIFEST_SHA256, boardId: 21316, ramFiles: STEADYDIGITAL_RAM_FILES, fetcher, signal });
export const prepareP1Recovery = (device, options = {}) => prepareP1(device, options, P1_RAM_FILES, loadP1Recovery);
// The same bootloaders and steps as the P1 Air, with the ground recovery set.
export const prepareP1GndRecovery = (device, options = {}) => prepareP1(device, options, P1_GND_RAM_FILES, loadP1GndRecovery);
async function prepareP1(device, { stockVersion, signal, fetcher, assets: preloaded, progress = () => {}, log = () => {}, readTimeout, commandPause }, ramFiles, load) {
  // 'auto' (P1_AUTO): the bootloader is found by probing, v1 first.
  const { candidates } = p1Bootloader(stockVersion);
  progress('Downloading and checking P1 recovery…');
  const assets = preloaded ?? await load({ fetcher, signal });
  const link = new P1HidRecovery(device, { stockVersion, ramFiles, signal, log, ...(readTimeout && { readTimeout }), ...(commandPause != null && { commandPause }),
    progress: ({ bytes, total }) => progress(`Loading P1 recovery: ${Math.round(bytes * 100 / total)}%`) });
  try {
    await link.open(); progress('Checking the P1 bootloader…');
    await link.identify(Object.fromEntries(candidates.map((id) => [id, assets.manifest.bootloaders[id].fingerprints])));
    for (const { name, bytes } of assets.files) { progress(`Loading ${name} into RAM…`); await link.upload(name, bytes); }
    progress('Starting P1 recovery…'); await link.boot();
  } catch (e) { log(link.diagnostics(), 'warn'); throw e; } finally { await link.close(); }
}
// SteadyDigital: same v2 bootloader, but it reads and commits 8 data bytes per
// frame and truncates commands over 16 characters, so the images are written
// directly (bootm checks the uImage CRCs) and booted with short `set` commands.
export async function prepareSteadyDigitalRecovery(device, { signal, fetcher, assets: preloaded, progress = () => {}, log = () => {}, readTimeout } = {}) {
  progress('Downloading and checking SteadyDigital recovery…');
  const assets = preloaded ?? await loadSteadyDigitalRecovery({ fetcher, signal });
  const link = new P1HidRecovery(device, { stockVersion: '2.1.2', ramFiles: STEADYDIGITAL_RAM_FILES, readChunk: 8, writeChunk: 8, signal, log, ...(readTimeout && { readTimeout }),
    progress: ({ bytes, total }) => progress(`Loading SteadyDigital recovery: ${Math.round(bytes * 100 / total)}%`) });
  const command = async (text) => { await link.send(6, new TextEncoder().encode(text)); await new Promise((r) => setTimeout(r, 200)); };
  try {
    await link.open(); progress('Checking the SteadyDigital bootloader…');
    try { await link.identify(assets.manifest.bootloaders.v2.fingerprints); } catch (e) {
      throw new Error(`${e.message} (SteadyDigital bootloader check; no firmware was written.)`);
    }
    for (const { name, bytes } of assets.files) { progress(`Loading ${name} into RAM (8 bytes per frame; the kernel takes a few minutes)…`); await link.write(STEADYDIGITAL_RAM_FILES[name][0], bytes); }
    progress('Starting SteadyDigital recovery…');
    await command('set a 24400000'); await command('set r 26000000'); await command('set f 22080000'); await command('bootm $a $r $f');
  } catch (e) { log(link.diagnostics(), 'warn'); throw e; } finally { await link.close(); }
}
