# fpvOS Flasher

**<https://gehee.github.io/fpvOS_flasher/>**

> **Experimental: use it at your own risk.** Flashing can leave a device that
> has to be recovered by hand.

A web page that flashes FPV devices over USB, in Chrome or Edge on a desktop
computer. There is nothing to install. The page checks the image, then talks to
the updater already on the device, which does the flashing itself.

Flashing the fpvOS air image? Follow
[fpvOS's install guide](https://github.com/gehee/fpvOS/blob/main/docs/INSTALL.md#flash-the-air-unit-optional).

## Supported devices

✅ supported and tested on hardware from that OS · ☑️ supported, not yet tested
on hardware from that OS · ❌ not supported. Every path also runs in the
simulated tests (Node and headless Chrome, on Linux in CI).

### Stock → fpvOS

One row per stock version: check your unit's stock version against it. A
version not listed is not supported (the Ascent Lite's stock updater takes the
image without a version check, so other Lite versions may work).

| Device | Stock version | Linux | macOS | Windows | Notes |
| --- | --- | --- | --- | --- | --- |
| Ascent Lite | 17.5.3 | ☑️ | ☑️ | ☑️ | |
| | 18.21.10 | ✅ | ✅ | ✅ | Linux, macOS and Windows: stock → fpvOS 2026.10.beta4-99 (test build), 2026-11-23 |
| Ascent Lite+ | 18.21.10 | ✅ | ✅ | ✅ | Linux, macOS and Windows: stock → fpvOS 2026.10.beta4-99 (test build), 2026-11-23; keeps its serial number |
| Ascent VRX | 17.5.3 | ☑️ | ☑️ | ☑️ | not yet hardware-tested |
| | 17.5.8 | ☑️ | ☑️ | ☑️ | not yet hardware-tested |
| | 18.21.10 | ☑️ | ☑️ | ☑️ | not yet hardware-tested |
| BETAFPV P1 Air | 1.0.44 | ✅ | ✅ | ✅ | Linux: flashed by gehee (Linux Chromium, 2026-11-03), and again from this page 2026-11-23 (Linux Chromium), its bootloader detected with no version to pick. Windows (app 0.4.2) and macOS (app 0.4.5): through the fpvOS Recovery app, 2026-11-23, its bootloader detected the same way |
| | 2.0.5 | ☑️ | ❌ | ❌ | bootloader checked offline only; needs a P1 build with the U-Boot bank-selection fix |
| | 2.0.6 | ☑️ | ❌ | ❌ | bootloader checked offline only; needs the bank-selection fix |
| | 2.1.2 | ✅ | ✅ | ✅ | Linux: flashed by mh1412 (PR #2), and again from this page 2026-11-23 (Linux Chromium), its bootloader detected with no version to pick. macOS and Windows: through the fpvOS Recovery app, 2026-11-23 (Windows again with app 0.4.1; that time the unit needed a manual restart before the flasher could connect); fpvOS went to the bank stock was not running from, stock 2.1.2 kept on the other |
| BETAFPV VR04 HD FPV Goggles | 1.0.44, 2.0.5, 2.0.6, 2.1.4 | ☑️ | ☑️ | ☑️ | not yet hardware-tested: the bootloaders are the P1 Air's two, checked offline in the vendor's packages only; the fpvOS `p1-gnd` image has not run on a unit |
| BETAFPV VR04 HD Pro FPV Goggles | 1.0.44, 2.0.5, 2.0.6, 2.1.4 | ☑️ | ☑️ | ☑️ | not yet hardware-tested; the same recovery; its own bundle, `fpvos-p1-gnd-goggles-pro`: stock programs a GM8773C bridge over I2C, which sends the panel its init, where the VR04 HD's panel takes it from the SoC. Its display driver is written from the stock firmware alone (the I2C bus and the lane clock are inferred); no brightness control, and the USB-C DisplayPort output is not driven. `fpvos-p1-gnd-goggles` is expected to show no picture on it |
| BETAFPV P1 HD VRX (Standard) | 2.0.8, 2.1.4 | ☑️ | ☑️ | ☑️ | not yet hardware-tested, and never seen on a bench; the same recovery; its bundle is `fpvos-p1-gnd-vrx`, shared with the Nano (one stock product, `P1_GND_VRX`) |
| BETAFPV P1 HD VRX (Nano) | 2.0.8, 2.1.4 | ☑️ | ☑️ | ☑️ | not yet hardware-tested, as the goggles; the same recovery; its bundle is `fpvos-p1-gnd-vrx` |
| Skyzone SteadyDigital | SD10P_V2.0.0B03 | ✅ | ✅ | ✅ | macOS (2026-11-22) and Windows (2026-11-23) through the fpvOS Recovery app: stock → recovery → install, display and video working; fpvOS goes to the bank stock is not running from, stock kept on the other |

A Lite was flashed to fpvOS beta3 on hardware (2026-10-08), but its stock
version and host OS were not recorded.

The P1 Air and SteadyDigital first install starts with a one-time preparation
over WebHID that works **only on Linux and ChromeOS**: macOS and Windows cannot
send the stock bootloader's reports (confirmed on a SteadyDigital, 2026-11-20;
the P1 has the same loader). On macOS and Windows the page hands that step to
the **fpvOS Recovery** app instead (from
[fpvOS_recovery](https://github.com/gehee/fpvOS_recovery)): on macOS through a
one-line Terminal command, on Windows as one `.exe` that installs its USB driver
itself. The app only uses the unit's memory; the page then installs as usual.

### fpvOS → fpvOS (updates)

| Device | How | Linux | macOS | Windows | Notes |
| --- | --- | --- | --- | --- | --- |
| Ascent Lite / Lite+ | fpvOS `.img` through the unit's updater | ☑️ | ☑️ | ☑️ | host OS not recorded |
| Ascent VRX | `.fwu` through fpvOS recovery | ☑️ | ☑️ | ☑️ | not yet hardware-tested |
| BETAFPV P1 Air | `.fwu` through fpvOS recovery | ☑️ | ☑️ | ☑️ | the 2026-11-03 install ran this step on Linux; no later update recorded |
| BETAFPV VR04 goggles / P1 HD VRX | `.fwu` through fpvOS recovery | ☑️ | ☑️ | ☑️ | not yet hardware-tested |
| Skyzone SteadyDigital | `.fwu` through fpvOS recovery | ☑️ | ☑️ | ☑️ | not yet hardware-tested |

Stock → stock (Ascent signed upgrades, the unlocked VRX downgrade to 17.5.8)
works on any OS and was hardware-tested; host OS not recorded.

**Not supported:** VRX Pro (it boots fpvOS from an SD card, see the
[install guide](https://github.com/gehee/fpvOS/blob/main/docs/INSTALL.md)),
Avatar, L_Gnd and the P1 goggles.

### AR9311 custom firmware

On a standard VRX on a supported stock version, pick a full `fpvos-ar9311.fwu`.
The page loads a RAM updater, reboots into it and installs; **when asked, select
this unit's new USB port**, with other VRXs unplugged. A unit already on fpvOS
updates through its built-in recovery. Keep external DC power connected: the
kernel/DTB writes are not power-loss safe. A restoration `.fwu` puts the stock
kernel/DTB back from the unit's original backups. See
[AR9311 fpvOS recovery service](docs/architecture.md#ar9311-fpvos-recovery-service).

### BETAFPV P1 Air and Skyzone SteadyDigital

1. On stock, click **Connect** and pick the unit's Sirius port. The page
   recognises it and offers to prepare it. For the P1 the page finds which
   bootloader it has, 1.0.44's or 2.x's, by probing the 1.0.44 one first.
2. It restarts the unit into its USB download mode; click **2. Load P1 recovery** (or **SteadyDigital recovery**) and
   pick the **USB download gadget**. The page checks the bootloader and loads
   the fpvOS recovery into RAM; nothing is written to flash yet.
3. In recovery, pick the unit's serial port and its `.fwu` (`fpvos-p1-air.fwu`
   or the `skyzone-steadydigital-flash` build). The page installs it, reboots and
   checks the running package's SHA-256.

The **VR04 HD FPV Goggles and the P1 HD VRX (Standard and Nano)** go the same way. A stock P1 ground unit
has the P1 Air's Sirius port and the same USB download gadget, and the two
kinds have different recoveries, so Connect asks one thing: P1 Air, or VR04
goggles or P1 HD VRX. Which ground unit it is is not asked: they share one
recovery. They share one fpvOS image too, in a bundle per unit for its device
tree (a panel, an HDMI output, or a panel behind a bridge): `fpvos-p1-gnd-goggles-<version>.fwu`,
`fpvos-p1-gnd-vrx-<version>.fwu` (the P1 HD VRX, Standard and Nano) or
`fpvos-p1-gnd-goggles-pro-<version>.fwu` (the VR04 HD Pro FPV Goggles). Pick the one for the unit; the recovery
takes any of them, and a wrong one leaves the unit with no picture.
See the [P1 ground recovery guide](assets/p1-gnd-updater/README.txt).

Once on fpvOS, Connect reaches the unit directly. Stock bank, factory
calibration and settings are kept. A unit stuck in USB download mode is
power-cycled back to stock. Keep external power connected. Linux may need a USB
permission rule: see the [P1 recovery guide](assets/p1-updater/README.txt) and
the [P1 firmware README](https://github.com/gehee/fpvOS/blob/main/br-external/board/p1-air/README.md#persistent-installation-and-usb-recovery).

## Use

1. Plug in the device (**a standard VRX needs external DC power too**), click
   **Connect** and pick its port.
2. The page shows the device and what it runs. **Install fpvOS <release>**
   downloads the image published for it, checks it and asks once before
   flashing. Only devices proven on hardware get one (the Ascent Lite / Lite+
   for now).

To flash your own file, open **More options**, drop an image or an archive
holding one (the vendor's `.zip` works as is), read the checks and click
**Flash this file**. An older standard VRX image turns on **Unlock before
flashing** by itself ([VRX preparation](docs/architecture.md#vrx-preparation)).
`?dev` in the address adds developer options.

Close the vendor's PC tool and any serial terminal first: only one program can
open the port. On Linux your user needs `/dev/ttyACM*` access (the `dialout`
group). Firefox and Safari have no Web Serial.

### Local copy and test builds

Web Serial needs a secure page, which `http://localhost` is:

```bash
mkdir -p test-firmware   # optional: builds to offer
tools/fetch-releases.sh  # optional: the published releases, as on Pages
python3 -m http.server 8000 --bind 127.0.0.1
```

Every image or archive in `test-firmware/` (git-ignored) shows up as a **test
build**, re-read on Connect and when the page comes back to the front. From
another computer, tunnel the port so the page stays on localhost:

```bash
ssh -N -L 8000:localhost:8000 user@build-host
```

## What the page checks

- Archives: `.zip` (zip64 too), `.xz`, `.gz`, `.tar` and any nesting; their
  integrity checks are verified. From an archive it picks the connected unit's
  image, the newest if there are several.
- Air images: board, payload CRC-32, sizes and partition bounds.
- Standard VRX stock images: layout, SHA-256 and the pinned VRX RSA key.
- fpvOS bundles: board, the bundle header and its SHA-256, checked again after
  reboot.
- Transfers: whole-file MD5 and an acknowledgment for every chunk; the unit's
  identity before upload and after reboot.
- After a flash, an fpvOS goggle gets this computer's time zone and country if
  its time zone is not set.

Cancel stops the transfer only before the install starts. Updates are not
atomic A/B swaps: keep power connected.

## Development

Static ES modules, no build step. Node 22+, Python 3, `xz`, `tar` and
Chrome/Chromium run the tests:

```sh
node --test test/*.test.mjs test/test.mjs
python3 tools/package-p1-recovery.py --check
python3 tools/package-p1-gnd-recovery.py --check
node test/browser-check.mjs
```

`CHROME` picks the browser. Stock-fixture checks are optional: `ASCENT_IMG`,
`VRX_IMG` (stock `Ascent_G_Gnd_17_5_8.img`) and `VENDOR_ZIP`. Hardware tools
(`test/flash-node.mjs`, `test/hardware-browser.mjs`) are explicit and not in
CI; keep their output under `.local/`. See [Architecture](docs/architecture.md)
for the device-module contract.

### Deploy

A push to `main` runs the tests. GitHub Pages publishes the commit the `live`
tag points to at the root, the `preview` tag at `/preview/` and the `alpha` tag
at `/alpha/` (same origin, so the same browser permissions); every deploy
rebuilds them all.

```bash
git tag -f preview COMMIT && git push -f origin preview
```

```bash
git tag -f live COMMIT && git push -f origin live
```

```bash
git tag -f alpha COMMIT && git push -f origin alpha
```

`git push origin --delete preview` takes the preview down, and the same for
`alpha`. `/alpha/` is for a branch under test: it lists the fpvOS releases, and
first the files its commit names in `tools/alpha-firmware.json`, if it has one
(the format of `tools/preview-firmware.json`). The `github-pages` environment
must allow the `alpha` tag (Settings > Environments). A tagged commit publishes
with its own copy of the workflow: one from before `/alpha/` drops that page
until the workflow is run by hand from `main` (`gh workflow run pages.yml --ref main`).

## License

GPLv3, as fpvOS ([LICENSE](LICENSE)). The Chakra Petch fonts in `fonts/` are
under the SIL Open Font License ([fonts/OFL.txt](fonts/OFL.txt)).
