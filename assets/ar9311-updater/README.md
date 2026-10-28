# AR9311 RAM updater

`v1/` contains matching outputs from the fpvOS source commit recorded in its
manifest. The updater embeds BusyBox and preparation helpers. The launcher is
only the stock clean-hook entry. No firmware image is bundled here.

These artifacts are experimental and have not been hardware-validated. Never
send vendor FileEnd for either staging file, including the executable (>1 MiB).

To update, copy a tested build into a new version directory, record its source
commit, sizes and SHA-256 hashes, and update the manifest pin in
`stages/ar9311-bootstrap.js`. Keep deployment and browser asset lists in sync.
The executable and embedded BusyBox are GPL-licensed; corresponding source is
identified by the pinned fpvOS repository commit (including its Buildroot pins).
Before publishing these binaries, make that corresponding source commit available
at the recorded repository URL. `COPYING` contains the GPLv2 license text.
