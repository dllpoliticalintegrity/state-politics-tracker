#!/usr/bin/env bash
# ops/sync_to_external.sh — one-way, non-deleting backup of per-state
# raw/ and cleaned/ files to the external drive.
#
# Different from ops/data_sync.py's load_states/save_states (which mirror
# data/{State}/ with `rsync -a --delete` as part of the daemon's pull-before
# /push-after cycle around a pipeline run): this script never deletes
# anything from the drive (no --delete) — it's meant to be run by hand to
# push local changes out, not to make the drive an exact mirror.
#
# It DOES overwrite a file already on the drive if local has changed —
# plain `rsync -a`'s default "quick check" (size + mtime) decides that, not
# --ignore-existing. That matters because current-year raw CSVs (e.g.
# Expenditures_2026_*.csv) keep growing all year as new filings come in, and
# a reparse can regenerate cleaned/*.csv.gz with a different size for
# reasons that have nothing to do with "newer" (gzip's ratio depends on
# content, not row count) — --ignore-existing would silently leave stale
# copies of exactly those files sitting on the drive forever once a
# same-named file existed there once. Quick-check catches "differs in size
# or mtime" without needing a full checksum read of every already-backed-up
# file (including years of untouched historical data) on every run.
#
# Scope:
#   - Copies data/{State}/raw/**  and data/{State}/cleaned/** (all file
#     types — csv, csv.gz, pdf, zip, xls, json, etc.)
#   - Excludes *.db and *.wal — state databases are local-only and are not
#     backed up here.
#   - A state is skipped entirely if it has no CSVs locally, i.e. no
#     *.csv anywhere under raw/ and no *.csv.gz anywhere under cleaned/.
#     (A folder that only has a stray .db in cleaned/, or empty raw/,
#     counts as empty.)
#   - Per-state manifest.csv and the top-level data/ aggregate files are
#     out of scope, same as data_sync.py.
#
# Destination root defaults to /Volumes/easystore/state-cf-data (matches
# the CF_EXTERNAL_DATA_ROOT convention in data_sync.py); override by
# exporting CF_EXTERNAL_DATA_ROOT before running.
#
# Usage: ops/sync_to_external.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/../data"
DEST_ROOT="${CF_EXTERNAL_DATA_ROOT:-/Volumes/easystore/state-cf-data}"

if [[ ! -d "$DEST_ROOT" ]]; then
    echo "error: $DEST_ROOT not found — is the drive mounted?" >&2
    exit 1
fi

RSYNC_OPTS=(-a --exclude='*.db' --exclude='*.wal')

synced=0
skipped=0

for state_dir in "$DATA_DIR"/*/; do
    state="$(basename "$state_dir")"
    [[ "$state" == .* ]] && continue

    raw_dir="$state_dir/raw"
    cleaned_dir="$state_dir/cleaned"

    has_raw_csv=0
    has_cleaned_csv=0
    [[ -d "$raw_dir" ]] && [[ -n "$(find "$raw_dir" -iname '*.csv' -print -quit 2>/dev/null)" ]] && has_raw_csv=1
    [[ -d "$cleaned_dir" ]] && [[ -n "$(find "$cleaned_dir" -iname '*.csv.gz' -print -quit 2>/dev/null)" ]] && has_cleaned_csv=1

    if [[ "$has_raw_csv" -eq 0 && "$has_cleaned_csv" -eq 0 ]]; then
        echo "skip  $state (no raw or cleaned CSVs locally)"
        skipped=$((skipped + 1))
        continue
    fi

    dest_dir="$DEST_ROOT/$state"

    if [[ -d "$raw_dir" ]]; then
        mkdir -p "$dest_dir/raw"
        rsync "${RSYNC_OPTS[@]}" "$raw_dir/" "$dest_dir/raw/"
    fi
    if [[ -d "$cleaned_dir" ]]; then
        mkdir -p "$dest_dir/cleaned"
        rsync "${RSYNC_OPTS[@]}" "$cleaned_dir/" "$dest_dir/cleaned/"
    fi

    echo "sync  $state"
    synced=$((synced + 1))
done

echo "done: $synced synced, $skipped skipped (empty)."
