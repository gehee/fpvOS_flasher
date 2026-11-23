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

export function recoveryAppUrl(file) {
  return `${RECOVERY_APP_BASE}/${file}`;
}

// note: what happens when Start is pressed. firstRun: getting an app that is
// not signed by a known developer to open the first time. Since macOS 15 a
// right-click Open no longer bypasses Gatekeeper; only System Settings does.
export function recoveryAppDownload(userAgent = '') {
  const ua = String(userAgent);
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) {
    return {
      os: 'macOS',
      label: 'Download for macOS',
      file: 'fpvOS-Recovery-macOS.zip',
      note: 'macOS then asks for your password once: only an administrator can take the USB device from the system.',
      firstRun: 'The first time, macOS may say it cannot verify the app and offer to move it to the Trash. Choose Done, '
        + 'open System Settings › Privacy & Security, scroll down to Security, click Open Anyway next to fpvOS Recovery '
        + 'and enter your password, then open the app again. Later launches open directly.',
    };
  }
  if (/\bWindows\b/.test(ua)) {
    return {
      os: 'Windows',
      label: 'Download for Windows',
      file: 'fpvOS-Recovery-Windows.zip',
      note: 'The first time, Windows asks once to let it install the USB driver for the bootloader: choose Yes.',
      firstRun: 'The first time, Windows SmartScreen may say it protected your PC. Choose More info, then Run anyway.',
    };
  }
  return null;
}
