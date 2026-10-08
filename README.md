# fpvOS Flasher

**<https://gehee.github.io/fpvOS_flasher/>**

> **Experimental: use it at your own risk.** The flasher is new and not yet
> tested on every device and firmware. Flashing can leave a device that has to
> be recovered by hand.

A web page that flashes FPV devices over USB. It runs in Chrome or Edge on a
desktop computer (Linux, Windows, macOS) through the Web Serial API. There is
nothing to install.

For each device, the page talks to the updater that already runs on it, with
the same messages the vendor's PC tool uses. It checks the image before
anything is sent, and the device does the flashing itself.

## Supported devices

| Device | Images | Status |
| --- | --- | --- |
| Ascent Lite air unit | `Ascent_H_Sky_*.img`, stock or fpvOS | simulated tests only; **not yet on hardware** |
| Ascent Lite+ air unit | `Ascent_H_Sky_*.img`, stock or fpvOS | same image and updater as Lite; **not yet on hardware** |
| Ascent VRX (standard, Proxima-9311) | `Ascent_G_Gnd_*.img`, signed stock ASW/OTRA | hardware-tested upgrades through 18.21.10 and unlocked downgrade to 17.5.8 |

**VRX Pro, Avatar, L_Gnd and goggles are not supported profiles.** The standard
VRX uses board **5 / G_Gnd**.
The Pro's Rockchip container is different, even though its PC upload protocol
is shared. Modified standard VRX images require a signature accepted by its
stock updater; the page rejects images that do not verify with the pinned key.

Selecting a hardware profile does not override the connected device's identity.
See [Architecture](docs/architecture.md) for the device-module contract.

## Use

Open the page above. A local copy also works: Web Serial needs a secure page,
which `http://localhost` is.

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

Then open <http://localhost:8000>:

1. Plug in the device and click **Connect**, then pick its port in the
   browser's list. A device the page was allowed before connects as soon as it
   is plugged in. **Standard VRX needs external DC power as well as USB.**
2. Drop a firmware image on the page, and read the checks it shows. An archive
   holding one works too, so the vendor's `.zip` download can be dropped as it
   is. **Auto · connected device** selects the matching hardware's image. For
   offline checks, choose a **Hardware profile** first when an archive contains
   both air and VRX images. See [Archives](#archives) for the formats.
3. Click **Flash**.

For a standard VRX downgrade, **Unlock before flashing (allow older firmware)**
is selected automatically when the validated image version is below the
version reported on connection. Equal/newer images leave it off. You can
override the checkbox for the current selection, then click **Unlock and flash**.
The unlock temporarily overlays the updater's current version with 0.0.0 in
RAM; firmware bytes and signature checks stay unchanged. See
[VRX preparation](docs/architecture.md#vrx-preparation) for eligibility and recovery.

To use the page from another computer on the LAN, either open it through an
ssh tunnel to `localhost`, or enable "Insecure origins treated as secure" for
its address in `chrome://flags`.

Close the vendor's PC tool and any serial terminal first, because only one
program can open the port. On Linux, your user needs access to
`/dev/ttyACM*` (the `dialout` group).

## Archives

The page takes an image as is, or an archive holding one:

- `.zip`, stored or deflate, with zip64. The vendor's download is a zip of
  this kind.
- `.xz` and `.gz`.
- `.tar`, alone or inside `.gz` or `.xz`.
- Any nesting of these, for example an `.img.xz` inside a zip.

From a zip, only the chosen entry is read, so a 400 MB download costs the size
of one image. The page selects by the connected or selected hardware profile:
`Ascent_H_Sky_<version>.img` for Lite/Lite+, `Ascent_G_Gnd_<version>.img` for
standard VRX. If there are several matching versions, it takes the newest and
says so. A mixed-hardware archive without a target asks for a profile instead
of guessing. If there are no images, it lists what the archive holds.

zip and gzip use the browser's decompressor. `xz.js` handles LZMA2 and its
CRC-32, CRC-64 or SHA-256 check. Archive integrity checks are verified.

## Validation and update behavior

- Air images: ASW board, payload CRC-32, component sizes and partition bounds.
- Standard VRX images: ASW/OTRA layout, bounded partition/segment tables,
  authenticated-body SHA-256 and the pinned standard VRX RSA key. The RSA check
  matches the vendor's digest-tail comparison, not stricter PKCS#1 padding rules.
- Transfers: canonical filename from the image version, whole-file MD5, and
  matching acknowledgments for every chunk. Uncertain data writes are not retried.
- Reboots: update-mode identity is checked before upload; full factory identity
  and the requested firmware are verified afterward. The page offers port
  reselection if permission is lost across a reboot.

**FILE_END starts installation.** Cancellation stops the transfer before that
command; afterward the page continues monitoring and post-reboot verification.
Negative updater status codes fail immediately.

These devices write both shared and banked partitions, including boot
components. Updates are not whole-system atomic A/B swaps, and stock firmware
can replace persistent application/startup modifications. The standard VRX
updater also enforces its own version and rollback rules.

The **Advanced** section can request USB network (RNDIS) mode. Other vendor-tool
features, such as frequency configuration and RC modes, are not covered.

## Development and tests

The app is static ES modules with no build step or runtime packages:

| Location | Responsibility |
| --- | --- |
| `index.html`, `app.js` | UI and operation state |
| `devices/` | Hardware identity, image validation and profiles |
| `flasher.js`, `stages/` | Image preparation, selection planning and sequential flash operations |
| `transports/` | Ascent protocol and browser/Linux serial adapters |
| `archive.js`, `xz.js`, `checksum.js`, `firmware.js` | Archive, integrity and version helpers |
| `test/` | Unit tests, simulated devices, browser checks and explicit hardware tools |

Use Node 22+, Python 3, `xz`, `tar`, and Chrome/Chromium for the full test suite:

```sh
node --test test/test.mjs test/archive.test.mjs test/profiles.test.mjs test/unlock.test.mjs
node test/browser-check.mjs
```

`CHROME` selects a browser executable when `google-chrome` is not on `PATH`.
The browser check uses a synthetic air image by default and saves screenshots
to a temporary directory. It accepts optional `[IMG] [OUTDIR]` arguments.
Tests cover archive extraction, image tampering, identity mismatches, lost
replies, reconnects, cancellation, unlock staging and installation failures.

Optional stock-fixture checks use these environment variables; firmware is not
bundled with the repository:

| Variable | Fixture |
| --- | --- |
| `ASCENT_IMG` | A stock H_Sky air image |
| `VRX_IMG` | Stock `Ascent_G_Gnd_17_5_8.img`; also enables signed VRX browser flows |
| `VENDOR_ZIP` | A vendor ZIP containing an H_Sky image (requires `unzip`) |

Linux hardware access is also available through the CLI:

```sh
node test/flash-node.mjs info
node test/flash-node.mjs flash FIRMWARE
```

`test/hardware-browser.mjs` drives native Web Serial: `--info` queries identity,
`--info --selection-only` checks image/unlock selection, and `--execute` flashes.
Supply `--usb-serial`, `--output`, and (for flashing) `--device-serial` and
`--firmware`. Its local audits include checksums, identity replies and screenshots;
hardware checks are explicit and are not part of CI.

Keep local firmware fixtures and hardware-test output under `.local/`, which
is ignored by Git.

`.github/workflows/pages.yml` runs Node and simulated-browser checks before
publishing the site to GitHub Pages.

## License

GPLv3, as fpvOS ([LICENSE](LICENSE)). The Chakra Petch fonts in `fonts/` are
under the SIL Open Font License ([fonts/OFL.txt](fonts/OFL.txt)).
