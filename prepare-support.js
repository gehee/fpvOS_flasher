// Browser stock-preparation drives the vendor U-Boot "USB download gadget" over
// WebHID with a non-standard protocol: it sends reports on HID report IDs the
// device does not declare as outputs. Only Linux and ChromeOS pass those reports
// straight to the device's interrupt endpoint; macOS silently routes them to the
// control endpoint (the gadget never sees them) and Windows rejects them at the
// API. Verified on hardware (SteadyDigital, 2026-11-20). So the one-time
// stock->fpvOS step is Linux/ChromeOS-only; once a unit runs fpvOS, every update
// works on any OS over Web Serial.
export function browserPrepareSupport(userAgent = '') {
  const ua = String(userAgent);
  const chromeOS = /\bCrOS\b/.test(ua);
  const linux = /\bLinux\b/.test(ua) && !/\bAndroid\b/.test(ua);
  if (chromeOS || linux) return { supported: true, os: chromeOS ? 'ChromeOS' : 'Linux', message: '' };
  const os = /\bMac OS X\b|\bMacintosh\b/.test(ua) ? 'macOS'
    : /\bWindows\b/.test(ua) ? 'Windows'
      : /\bAndroid\b/.test(ua) ? 'Android'
        : 'this system';
  return {
    supported: false,
    os,
    message: `The one-time stock→fpvOS preparation works only on Linux or ChromeOS. `
      + `${os}'s USB stack cannot drive the stock bootloader's upload interface, so this first step would fail here. `
      + `Run it once from a Linux or ChromeOS machine (a live USB stick is enough) — after that, you can install updates from ${os} over USB like normal.`,
  };
}

// On macOS/Windows the browser can't drive the stock bootloader, but the native
// "fpvOS Recovery" app can. Pick the download for the user's OS, or null where
// the browser path already works (Linux/ChromeOS) or there is no build (other).
// The apps live in their own repo, fpvOS_recovery, whose recovery-app workflow
// publishes them as release assets; the file names below must match that
// workflow's output. See RELEASING.md there.
// Served from localhost (e.g. local testing over an SSH tunnel), take the apps
// from ./recovery-app/ beside the page instead, so the download works without a
// published release.
const RECOVERY_APP_BASE =
  (typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1|::1)$/.test(location.hostname))
    ? 'recovery-app'
    : 'https://github.com/gehee/fpvOS_recovery/releases/latest/download';

// The Windows download names its app version: the recovery-app release that
// carries fpvOS-recovery-win-<version>.zip (fpvOS_recovery's workflow names it
// from Cargo.toml). Update it with each Windows release.
export const RECOVERY_APP_WINDOWS_VERSION = '0.4.5';

export function recoveryAppUrl(file) {
  return `${RECOVERY_APP_BASE}/${file}`;
}

// The same, absolute (a command run in Terminal has no page to resolve against).
function absoluteRecoveryAppUrl(file) {
  const url = recoveryAppUrl(file);
  return typeof location !== 'undefined' ? new URL(url, location.href).href : url;
}

// macOS: a Terminal command that fetches the app with curl and opens it from a
// fresh temporary folder. Files curl downloads carry no quarantine flag, so
// Gatekeeper never stops the (not notarized) app: no "move to Trash" dialog,
// no trip to Privacy & Security. Nothing is installed, and no sudo: the app
// asks for the password itself. "fpvOS Recovery.app" is the zip's top level
// (the recovery-app workflow zips it with ditto --keepParent).
export function recoveryTerminalCommand(url) {
  return `D=$(mktemp -d) && curl -fsSL '${url}' -o "$D/app.zip" && ditto -xk "$D/app.zip" "$D" && open "$D/fpvOS Recovery.app"`;
}

// note: what happens when Start is pressed. firstRun: getting an app that is
// not signed by a known developer to open the first time. Since macOS 15 a
// right-click Open no longer bypasses Gatekeeper; only System Settings does,
// which the Terminal command avoids altogether.
export function recoveryAppDownload(userAgent = '') {
  const ua = String(userAgent);
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) {
    const file = 'fpvOS-Recovery-macOS.zip';
    return {
      os: 'macOS',
      label: 'Download the app instead',
      file,
      terminal: recoveryTerminalCommand(absoluteRecoveryAppUrl(file)),
      note: 'macOS then asks for your password once: only an administrator can take the USB device from the system.',
      firstRun: 'If you download the app instead, macOS may say the first time that it cannot verify it and offer to '
        + 'move it to the Trash. Choose Done, open System Settings › Privacy & Security, scroll down to Security, '
        + 'click Open Anyway next to fpvOS Recovery and enter your password, then open the app again.',
    };
  }
  if (/\bWindows\b/.test(ua)) {
    return {
      os: 'Windows',
      label: 'Download for Windows',
      file: `fpvOS-recovery-win-${RECOVERY_APP_WINDOWS_VERSION}.zip`,
      note: 'The first time, Windows asks once to let it install the USB driver for the bootloader: choose Yes.',
      firstRun: 'The first time, Windows SmartScreen may say it protected your PC. Choose More info, then Run anyway.',
    };
  }
  return null;
}
