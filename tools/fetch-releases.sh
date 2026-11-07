#!/bin/sh
# The Pages deploy's firmware step for a local copy of the page: every fpvOS
# release's images, newest first, in firmware/ with firmware/catalog.json, so
# the page served from this folder offers the published releases too.
#   tools/fetch-releases.sh        (needs gh, logged in, and node)
set -eu
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
rm -rf firmware
for tag in $(gh release list -R gehee/fpvOS --exclude-drafts -L 20 --json tagName -q '.[].tagName'); do
  mkdir -p "$tmp/$tag"
  gh release download "$tag" -R gehee/fpvOS -D "$tmp/$tag" -p '*.img' -p '*.fwu' || continue
  node tools/make-catalog.mjs --release "$tag" --out firmware "$tmp/$tag"/*
done
