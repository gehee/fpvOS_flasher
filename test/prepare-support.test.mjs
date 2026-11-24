// The one-time stock preparation is Linux/ChromeOS-only; the page gates it by
// user-agent. These pin which OSes are allowed and that the rest get a message
// that names the OS and points at Linux/ChromeOS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { browserPrepareSupport, recoveryAppDownload, recoveryAppUrl, recoveryTerminalCommand } from '../prepare-support.js';

const UA = {
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
  chromeos: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36',
};

test('Linux and ChromeOS are the supported preparation hosts', () => {
  const linux = browserPrepareSupport(UA.linux);
  assert.equal(linux.supported, true);
  assert.equal(linux.os, 'Linux');
  const cros = browserPrepareSupport(UA.chromeos);
  assert.equal(cros.supported, true);
  assert.equal(cros.os, 'ChromeOS');   // CrOS wins even though its UA also says Linux
});

test('macOS and Windows are not supported, with a message naming the OS and Linux/ChromeOS', () => {
  for (const [key, os] of [['mac', 'macOS'], ['windows', 'Windows']]) {
    const r = browserPrepareSupport(UA[key]);
    assert.equal(r.supported, false, key);
    assert.equal(r.os, os, key);
    assert.match(r.message, /Linux or ChromeOS/, key);
    assert.match(r.message, new RegExp(os), key);
  }
});

test('Android (mobile Linux) is not treated as a desktop Linux host', () => {
  const r = browserPrepareSupport(UA.android);
  assert.equal(r.supported, false);
  assert.equal(r.os, 'Android');
});

test('an empty or unknown user-agent is unsupported and never throws', () => {
  for (const ua of ['', undefined, 'something weird']) {
    const r = browserPrepareSupport(ua);
    assert.equal(r.supported, false);
    assert.ok(r.message.includes('Linux or ChromeOS'));
  }
});

// The macOS/Windows hand-off: where the browser can't prepare, the page offers
// the native recovery app instead. These pin which OSes get a download and that
// each names the release asset the recovery-app workflow publishes.
test('recoveryAppDownload offers the native app on macOS and Windows', () => {
  const mac = recoveryAppDownload(UA.mac);
  assert.equal(mac.os, 'macOS');
  assert.equal(mac.file, 'fpvOS-Recovery-macOS.zip');
  assert.match(mac.label, /Download/);
  assert.ok(mac.note);
  const win = recoveryAppDownload(UA.windows);
  assert.equal(win.os, 'Windows');
  assert.match(win.file, /^fpvOS-recovery-win-\d+\.\d+\.\d+\.zip$/);
  assert.match(win.label, /Windows/);
  assert.ok(win.note);
});

test('first-launch guidance names what each OS actually shows', () => {
  const mac = recoveryAppDownload(UA.mac);
  // macOS 15+: right-click Open no longer bypasses Gatekeeper; Settings does.
  assert.match(mac.firstRun, /Privacy & Security/);
  assert.match(mac.firstRun, /Open Anyway/);
  assert.match(mac.firstRun, /Trash/);
  assert.doesNotMatch(mac.firstRun, /right-click/i);
  assert.match(mac.note, /password once/);
  assert.match(recoveryAppDownload(UA.windows).firstRun, /More info.*Run anyway/);
});

// The macOS main path: a Terminal command. curl-downloaded files carry no
// quarantine flag, so Gatekeeper never blocks the app (no Trash dialog, no
// Privacy & Security trip). Verified by hand on macOS 26: the app opens.
test('macOS gets a Terminal command that fetches the app and opens it', () => {
  const mac = recoveryAppDownload(UA.mac);
  assert.equal(mac.terminal, recoveryTerminalCommand(recoveryAppUrl(mac.file)));
  // A fresh temporary folder, curl (not the browser), ditto, then open the
  // bundle at the zip's top level - nothing installed, nothing else touched.
  assert.match(mac.terminal, /^D=\$\(mktemp -d\) && curl -fsSL '/);
  assert.ok(mac.terminal.includes(`'${recoveryAppUrl(mac.file)}' -o "$D/app.zip"`));
  assert.match(mac.terminal, /&& ditto -xk "\$D\/app\.zip" "\$D" && open "\$D\/fpvOS Recovery\.app"$/);
  // No privilege or security-setting changes: the app asks for the password itself.
  assert.doesNotMatch(mac.terminal, /sudo|xattr|spctl|chmod/);
  assert.equal(recoveryAppDownload(UA.windows).terminal, undefined);
});

test('recoveryAppDownload is null where the browser path works or has no build', () => {
  for (const key of ['linux', 'chromeos', 'android']) {
    assert.equal(recoveryAppDownload(UA[key]), null, key);
  }
  for (const ua of ['', undefined, 'something weird']) {
    assert.equal(recoveryAppDownload(ua), null);
  }
});

test('recoveryAppUrl builds a latest-release asset URL from a file name', () => {
  assert.equal(
    recoveryAppUrl('fpvOS-Recovery-macOS.zip'),
    'https://github.com/gehee/fpvOS_recovery/releases/latest/download/fpvOS-Recovery-macOS.zip',
  );
  // Every offered download names a file the URL builder can resolve.
  for (const key of ['mac', 'windows']) {
    const dl = recoveryAppDownload(UA[key]);
    assert.ok(recoveryAppUrl(dl.file).endsWith(`/download/${dl.file}`), key);
  }
});
