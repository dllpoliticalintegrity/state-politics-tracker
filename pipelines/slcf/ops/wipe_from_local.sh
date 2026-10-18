#!/usr/bin/env bash
# ops/wipe_from_local.sh — free internal disk space by deleting each state's
# local raw/ and cleaned/ contents (everything except *.db and *.wal), once
# it's verified that content is already safely on the external drive.
#
# Sister script to sync_to_external.sh, kept separate on purpose rather than
# folded in: sync_to_external.sh's whole contract, stated in its own header,
# is "never overwrites or deletes anything." A script whose entire job is to
# be a safe, no-surprises push shouldn't also be the one deleting your local
# copies — that would make its behavior no longer match its own docs, and
# invite running it casually assuming nothing local ever gets touched. This
# script is the deliberate, separate, destructive counterpart: run by hand,
# only when you actually want to reclaim space.
#
# Verifies before deleting, rather than trusting that sync_to_external.sh
# was run recently or completed cleanly: for each state, does a checksum
# rsync --dry-run comparison against the drive (same *.db/*.wal exclusions
# as sync_to_external.sh) and only wipes if nothing would need transferring
# — i.e. the drive copy is a true match, not just "was synced at some
# point." A state that isn't fully backed up yet is skipped with a warning
# instead of wiped. (Checksum, not size/mtime, on purpose: a re-parsed
# cleaned/*.csv.gz can land on the same size/mtime as a stale drive copy —
# this is a delete, so it's worth the extra I/O to be sure.)
#
# Scope (mirrors sync_to_external.sh's, plus manifest.csv):
#   - Deletes everything under data/{State}/raw/ and data/{State}/cleaned/
#     EXCEPT *.db and *.wal — those are local-only (never backed up by
#     sync_to_external.sh either) and are always left alone.
#   - Also deletes data/{State}/manifest.csv. Once raw/ is gone, a leftover
#     manifest.csv isn't just stale, it's actively dangerous: scrapers key
#     off it to decide what's already downloaded (e.g.
#     src/pipeline/scrapers/alabama.py's load_manifest() / done_ids) and
#     will silently skip re-fetching anything manifest.csv still lists, even
#     though the file backing that entry is gone. Wiping it forces the next
#     `sync` for that state to do a clean full re-download instead of
#     quietly running against a manifest that lies about what's on disk.
#   - A state is skipped entirely if it has no raw/ or cleaned/ locally —
#     nothing to wipe.
#
# Destination root defaults to /Volumes/easystore/state-cf-data (matches
# CF_EXTERNAL_DATA_ROOT convention in data_sync.py / sync_to_external.sh);
# override by exporting CF_EXTERNAL_DATA_ROOT before running.
#
# Usage: ops/wipe_from_local.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/../data"
DEST_ROOT="${CF_EXTERNAL_DATA_ROOT:-/Volumes/easystore/state-cf-data}"

if [[ ! -d "$DEST_ROOT" ]]; then
    echo "error: $DEST_ROOT not found — is the drive mounted?" >&2
    exit 1
fi

# -i (itemize-changes) with default (non-verbose) output prints one line per
# file that would be created/updated on dst — i.e. still needs backing up.
# Deliberately no --delete here: extra files on the drive that aren't local
# (e.g. left over from a previous run) are irrelevant to "is it safe to wipe
# local," so they shouldn't cause a false "not backed up" skip.
RSYNC_CHECK_OPTS=(-r --checksum --dry-run -i --exclude='*.db' --exclude='*.wal')

wiped=0
skipped_empty=0
skipped_unbacked=0

_fully_backed_up() {
    # True if a checksum dry-run shows nothing that would need to change —
    # i.e. the drive copy already matches local exactly (excluding db/wal).
    local src="$1" dst="$2"
    [[ -d "$src" ]] || return 0   # nothing local under this subdir — trivially "backed up"
    mkdir -p "$dst"
    [[ -z "$(rsync "${RSYNC_CHECK_OPTS[@]}" "$src/" "$dst/")" ]]
}

for state_dir in "$DATA_DIR"/*/; do
    state="$(basename "$state_dir")"
    [[ "$state" == .* ]] && continue

    raw_dir="$state_dir/raw"
    cleaned_dir="$state_dir/cleaned"
    dest_dir="$DEST_ROOT/$state"

    if [[ ! -d "$raw_dir" && ! -d "$cleaned_dir" ]]; then
        echo "skip  $state (nothing local to wipe)"
        skipped_empty=$((skipped_empty + 1))
        continue
    fi

    if ! _fully_backed_up "$raw_dir" "$dest_dir/raw" || \
       ! _fully_backed_up "$cleaned_dir" "$dest_dir/cleaned"; then
        echo "skip  $state (not fully backed up to $dest_dir yet — run sync_to_external.sh first)"
        skipped_unbacked=$((skipped_unbacked + 1))
        continue
    fi

    for dir in "$raw_dir" "$cleaned_dir"; do
        [[ -d "$dir" ]] || continue
        find "$dir" -type f ! -name '*.db' ! -name '*.wal' -delete
        find "$dir" -depth -type d -empty -delete
    done
    rm -f "$state_dir/manifest.csv"

    echo "wipe  $state"
    wiped=$((wiped + 1))
done

echo "done: $wiped wiped, $skipped_unbacked skipped (not fully backed up), $skipped_empty skipped (empty)."
