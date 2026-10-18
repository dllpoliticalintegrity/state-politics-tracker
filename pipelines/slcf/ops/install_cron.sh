#!/usr/bin/env bash
# Installs ops/crontab as this machine's crontab.
#
# WARNING: this does a FULL RESET — it runs `crontab -r` first, wiping the
# ENTIRE existing crontab (every job, not just campaign-finance ones), then
# installs only the campaign-finance block below. If you have any other cron
# jobs on this user, they will be destroyed. This is intentional per request;
# if you ever want the non-destructive behavior back, replace the `crontab -r`
# step with the old strip-only-the-marked-block approach.
#
# Usage: ops/install_cron.sh

set -euo pipefail

START="# >>> campaign-finance-cron >>>"
END="# <<< campaign-finance-cron <<<"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/crontab"

if [[ ! -f "$SRC" ]]; then
    echo "error: $SRC not found" >&2
    exit 1
fi

# Full reset: wipe the entire existing crontab, then install only our block.
# `crontab -r` errors if there's no crontab yet, so the `|| true` keeps a
# first-time install from aborting under `set -e`.
crontab -r 2>/dev/null || true

{
    echo "$START"
    cat "$SRC"
    echo "$END"
} | crontab -

echo "Installed (full reset). Current crontab:"
crontab -l
