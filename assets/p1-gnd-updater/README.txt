P1 ground units browser recovery — BETAFPV VR04 goggles and P1 HD VRX
=====================================================================

NOT YET RUN ON HARDWARE. The recovery kernel, its device tree and the fpvOS
image it installs (fpvOS p1-gnd) have only been built and checked offline.

One recovery for both units, and one fpvOS image in two bundles. The units
differ in their screen (the goggles' panel, the VRX's HDMI output), which
is the device tree, so each bundle carries one unit's tree:

  fpvos-p1-gnd-goggles-<version>.fwu    BETAFPV VR04 HD FPV Goggles
  fpvos-p1-gnd-vrx-<version>.fwu        BETAFPV P1 HD VRX, Standard and Nano:
                                        stock has one firmware (P1_GND_VRX)
                                        and one board for both

  fpvos-p1-gnd-goggles-pro-<version>.fwu   BETAFPV VR04 HD Pro FPV Goggles:
                                        another display (a panel behind a
                                        GM8773C bridge); the goggles bundle
                                        is expected to show no picture on
                                        them. No brightness control, and the
                                        USB-C DisplayPort output is not driven

The recovery here starts with a tree for any ground unit (betafpv,p1-gnd:
console, USB, the flash, and no screen) and does not work out which unit it
is on: it takes any of these bundles, and the file you pick names the unit.

A wrong one starts the unit with the wrong screen: no picture.
Stock is still on the other bank; switch back to it from this page.
Once fpvOS is installed, the unit knows which it is from its installed tree
and takes only its own bundle.

A stock P1 ground unit has the same USB serial port as a stock P1 Air
(1d6b:0101) and the same USB download gadget (1d6b:0100), and the air unit has
a different recovery: Connect asks whether this is a P1 Air or a VR04 goggles or
P1 HD VRX. (The fpvOS Recovery app reads it from the unit's USB interfaces.)

Supported stock versions, by their bootloader: 1.0.44 (the v1 bootloader), and
2.0.5, 2.0.6, 2.0.8 and 2.1.4 (v2). These are the P1 Air's two bootloaders: the
vendor's ground packages (P1_GND_VR04_PRO 1.0.44, P1_GND_VR04 2.0.5 and 2.0.6,
P1_GND_VRX 2.0.8, P1_GND 2.1.4) carry the same U-Boot code, checked offline.
The page detects which one answers and checks its fingerprints on the unit
before anything is loaded.

The steps, the permissions and the Linux udev rule are the P1 Air's: see
../p1-updater/README.txt. The step works from Linux and ChromeOS in the browser,
and through the fpvOS Recovery app on macOS and Windows.

Preparation only writes RAM. Firmware is installed by the p1-gnd updater, which
installs on the bank that does not hold stock and preserves the stock bank,
factory calibration and user settings.

Source and assets
-----------------
Kernel and device tree: https://github.com/gehee/fpvOS
Commit: f6de3231e0ef2805b85c989d07a311fbb42df236 (manifest.json source_commit), on the
p1-gnd branch.
Build: ./build.sh p1-gnd && ./build.sh p1-gnd recovery
Files: output/p1-gnd/images/kernel-recovery.img (shipped here as kernel.img)
and betafpv-p1-gnd.dtb
The kernel is the slim upload recovery kernel (no display, decoder or input).
It embeds the independent fpvos-recovery root and the p1-gnd updater. Its
command line is built in and forced: one CPU and clk_ignore_unused, as the P1
Air recovery, with the ground units' mem=148M. The bootloader's own bootargs
are not read.

browser-v1/manifest.json pins exact sizes, SHA-256 hashes, RAM destinations and
supported bootloader fingerprints. The flasher pins the manifest hash too.

browser-v1/recovery-init is fpvos-recovery/src/init at the source commit above,
with NAND-root loading disabled so preparation always enters recovery.
Run python3 tools/package-p1-gnd-recovery.py to rebuild recovery-initrd.img, or
add --check to verify it. See COPYING for GPL-2.0.
