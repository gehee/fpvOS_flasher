# Architecture

The app is static ES modules. Browser and Linux entry points share image
preparation, device policy and a sequential stage runner; only serial I/O differs.

```text
app.js / test/flash-node.mjs
  ├─ transports/web-serial.js / transports/node-serial.mjs
  └─ flasher.js
       ├─ devices/           identity, image validation and profiles
       ├─ stages/            ordered flash operations
       └─ transports/ascent.js   framing, sessions and transfer primitives

archive.js → xz.js / checksum.js
firmware.js → container and version helpers
```

## Device profiles

Each module in `devices/` exports a profile with three sections:

```js
{
  meta: {
    id, name, models, usb,
    identity: { matches, normalMatches, updateMatches },
    image: { prefix, pattern, detect, parse, checks, columns },
    deviceVersion,
    unlock: { supported, label, notice }, // optional
    notices: { flash, network },
  },
  transport: { protocol, serial, maxChunk, timeouts, allowZeroDataAckLength },
  stages: {
    preflash: [PREPARE_UPDATE_MODE, VERIFY_UPDATE_MODE],
    flash: [START_FIRMWARE, SEND_FIRMWARE, FINALIZE_FIRMWARE, WAIT_INSTALL],
    postflash: [RECONNECT, VERIFY_INSTALLED_FIRMWARE],
  },
}
```

Stage arrays contain function references and run in order. The VRX preparation
function selects ordinary or unlocked entry internally, using the fixed plan.
Device modules own image layouts and identity rules; the registry in
`devices/index.js` only resolves supported profiles. Shared ASW helpers and
transport defaults live in `devices/common.js` and `transports/ascent.js`.

## Preparation and execution

- `prepareFirmware()` extracts a matching archive entry, identifies its profile
  from contents, validates it and computes transfer MD5. Mixed-device archives
  require a target. Its normalized `view` supplies facts, columns and rows to the UI.
- `evaluateSelection()` is pure: it returns compatibility issues, readiness,
  chunk size and automatic/manual unlock selection. Rendering does not mutate
  the selection. A profile choice cannot override hardware identity.
- The UI snapshots the connection, image and effective plan at confirmation,
  and checks that they still match before starting.
- `flashFirmware()` awaits preflash → flash → postflash. A failed step stops
  execution and closes the link. An installation with no post-reboot reply is
  reported as unverified, rather than a verified success.

Each stage receives `{session, profile, image, originalDevice, plan, signal,
options, report, runtime, step, checkCancelled}`. Original identity and plan are
fixed snapshots; working state belongs in `runtime`.

## Invariants

- Validate the image and connected identity before preparation; verify update
  mode before firmware upload, then factory identity and installed version after reboot.
  `identity.updateMatches` checks the complete update-mode identity, including
  any model-name or factory-field changes; normal-mode matching remains separate.
- Never resend FILE_DATA. Check acknowledged status and cumulative/total byte
  counts. Air firmware transfers accept the updater's zero `Length` field via
  `allowZeroDataAckLength`; other nonmatching lengths are rejected. Staging
  requires exact chunk lengths and valid reply CRCs, and never sends FILE_END.
  Ordinary firmware replies retain vendor-compatible CRC warning/acceptance.
- Complete unlock selector arming and reboot without a cancellation gap.
- Once firmware FILE_END begins, continue installation monitoring and postflash
  checks even if cancellation is requested.
- Serial adapters own port/stream lifetime and receive settings and device
  filters from the caller; they do not import the device registry.

## Adding hardware support

1. Add a module in `devices/` with positive normal/update identities and an
   image validator. Define its transport settings and sequential stage arrays.
2. Register the profile in `devices/index.js` and reuse shared stages where applicable.
3. Add fixtures and tests for malformed images, mismatches, update-mode identity,
   failures and postflash verification. Extend the simulator/browser cases.
4. Add browser-imported modules to `PUBLIC_ASSETS` in `test/browser-harness.mjs`.

The browser harness supplies the localhost server, Chromium/CDP lifecycle and
UI helpers. Only `test/browser-check.mjs` installs fake serial; the explicit
hardware runner keeps native Web Serial.

The air clean updater can report `Ascent` with `FPV-Edu-Sky-V0.0-0.0` and a blank
serial. This is accepted only during preflash after a supported normal-mode air
connection, with unchanged H_Sky firmware and healthy status. It is not a normal
device identity, and postflash still requires the original factory fields.
Normal-mode checks also accept the observed `Ascent_H_Sky`/`Ascent_lite`
presentation change: a `1_` serial prefix and trailing hardware report `1.0`/`1.1`.
The serial identifier, board number and main hardware revision must still match;
other serial prefixes or hardware changes are not normalized.

## VRX preparation

Unlock requires healthy normal-mode board-485 identity and a canonical G_Gnd
version with unsigned 32-bit components. It is selected automatically for valid
matching downgrades; manual choice resets on file/profile/connection changes and
successful flash. Eligibility does not guarantee compatibility with future updaters.

The stock updater caches `/etc/app.version` at startup and compares candidate
filename versions lexicographically, rejecting older tuples with status -6.
Unlock stages a one-shot script and `/factory/sirius-clean-system-flag` selector,
then sends `REBOOT normal` (`clean` would overwrite the selector). The script
execs from RAM, removes its staged copy, overlays only `APP_VERSION=0.0.0`, and
starts the vendor clean updater. Firmware bytes and signature checks stay unchanged.

Normal clean mode uses a blank serial and `485-V0.0-0.0` hardware revisions;
unlocked mode additionally requires SDK `0.0.0` and `Ascent_G_Gnd_0_0_0`.
Both require the original model/board lineage and healthy status before upload.
Full factory identity and the requested real version are required after reboot.

If preparation fails, the script attempts to remove the overlay and reboot.
An ordinary restart restores the real version after the one-shot selector is
consumed; an armed selector may require a second restart. The clean daemon may
acknowledge a serial reboot without restarting, so manual recovery can be needed.
