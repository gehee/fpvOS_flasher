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
