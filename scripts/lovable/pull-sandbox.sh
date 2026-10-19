#!/usr/bin/env bash
# Fetch a Lovable design sandbox's GitHub repo and list what changed in the
# website code compared with this repo, so the changes can be brought over
# as a reviewed PR (docs/lovable-sandbox.md). Writes nothing in this repo:
# the sandbox is fetched into a temporary directory.
#
#   scripts/lovable/pull-sandbox.sh <lovable-repo-url> [our-ref]
#
# Prints a stat of changed files and writes the full diff to
# dist-lovable/sandbox.diff (sandbox changes as they would apply here).
set -euo pipefail
url="${1:?usage: pull-sandbox.sh <lovable-repo-url> [our-ref]}"
ours="${2:-HEAD}"
root="$(git rev-parse --show-toplevel)"
cd "$root"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git clone --quiet --depth 1 "$url" "$tmp/sandbox"
src="$tmp/sandbox"
[ -d "$src/state-politics-tracker-frontend" ] && src="$src/state-politics-tracker-frontend"
mkdir -p "$tmp/ours" dist-lovable
git archive "$ours" -- src shared public index.html tailwind.config.ts | tar -x -C "$tmp/ours"
rm -rf "$tmp/ours/src/test"
paths=(src shared public index.html tailwind.config.ts)
mkdir -p "$tmp/theirs"
for p in "${paths[@]}"; do [ -e "$src/$p" ] && cp -R "$src/$p" "$tmp/theirs/"; done
rm -rf "$tmp/theirs/src/test"
( cd "$tmp" && git diff --no-index --stat ours theirs || true )
( cd "$tmp" && git diff --no-index ours theirs > "$root/dist-lovable/sandbox.diff" || true )
echo "full diff: dist-lovable/sandbox.diff ($(wc -l < dist-lovable/sandbox.diff | tr -d ' ') lines)"
