#!/usr/bin/env bash
# Two-way sync between this repo and the Lovable design sandbox
# (dllpoliticalintegrity/state-politics-tracker-template; docs/lovable-sandbox.md).
#
#   scripts/lovable/sync.sh pull <sandbox-dir>
#       Design changes made in Lovable -> branch `lovable/sync` in this repo,
#       for a PR. The branch is the sandbox's app files laid over the commit
#       the sandbox was last synced from (.sandbox-base in the sandbox repo),
#       so the PR shows only Lovable's changes and GitHub merges them over
#       anything that changed here since. Prints "no-changes" or "pushed".
#
#   scripts/lovable/sync.sh push <sandbox-dir>
#       This repo's main -> the sandbox, so Lovable designs on current code.
#       Refuses (prints "pending") while the sandbox holds design changes
#       that main does not have yet, so Lovable edits are never overwritten;
#       pull and merge those first. Prints "up-to-date", "pending" or "pushed".
#
# <sandbox-dir> is a git checkout of the sandbox repo with push access.
# DRY_RUN=1 does everything except the final git push.
# Only the app files sync (APP_PATHS below). src/test stays here; the
# sandbox's .lovable/, vite.config.ts (port 8080) and package files stay there.
set -euo pipefail
cmd="${1:?usage: sync.sh pull|push <sandbox-dir>}"
box="$(cd "${2:?usage: sync.sh pull|push <sandbox-dir>}" && pwd)"
root="$(git rev-parse --show-toplevel)"
cd "$root"
APP_PATHS=(src shared public index.html tailwind.config.ts)

base="$(tr -d '[:space:]' < "$box/.sandbox-base" 2>/dev/null || true)"
[ -n "$base" ] || { echo "sandbox has no .sandbox-base" >&2; exit 1; }
git cat-file -e "$base^{commit}" 2>/dev/null || git fetch -q origin "$base"

# A tree of the app files: from a commit of this repo, or from the sandbox.
snapshot_commit() {  # <commit> <dir>
  rm -rf "$2"; mkdir -p "$2"
  git archive "$1" -- "${APP_PATHS[@]}" | tar -x -C "$2"
  rm -rf "$2/src/test"
}
snapshot_box() {  # <dir>
  rm -rf "$1"; mkdir -p "$1"
  for p in "${APP_PATHS[@]}"; do [ -e "$box/$p" ] && cp -R "$box/$p" "$1/"; done
  rm -rf "$1/src/test"
}
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
snapshot_commit "$base" "$tmp/base"
snapshot_box "$tmp/box"

# Files the sandbox changed since its base (added, modified or deleted).
changed() { (cd "$tmp" && git diff --no-index --name-only base box 2>/dev/null || true) | sed -E 's#^(base|box)/##' | sort -u; }

case "$cmd" in
pull)
  files="$(changed)"
  if [ -z "$files" ]; then echo "no-changes"; exit 0; fi
  work="$tmp/work"
  git worktree add -q --detach "$work" "$base"
  ( cd "$work"
    for p in "${APP_PATHS[@]}"; do
      if [ "$p" = src ]; then
        find src -mindepth 1 -maxdepth 1 ! -name test -exec rm -rf {} +
      else
        rm -rf "$p"
      fi
      [ -e "$tmp/box/$p" ] && cp -R "$tmp/box/$p" "$(dirname "$p")/" 2>/dev/null || true
    done
    git add -A -- "${APP_PATHS[@]}"
    git -c user.name="lovable-sandbox-sync" -c user.email="lovable-sync@users.noreply.github.com" \
      commit -q -m "Design updates from Lovable" -m "Files changed in the Lovable design sandbox since $base:" -m "$(echo "$files" | sed 's/^/- /')"
    [ -n "${DRY_RUN:-}" ] || git push -q --force origin HEAD:refs/heads/lovable/sync )
  git worktree remove --force "$work"
  echo "pushed"
  echo "$files" > "$root/.lovable-sync-files"
  ;;
push)
  head="$(git rev-parse HEAD)"
  # Every file the sandbox changed since its base must already be in main
  # as the sandbox has it; otherwise those design edits are not merged yet.
  snapshot_commit "$head" "$tmp/head"
  pending=""
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if ! cmp -s "$tmp/box/$f" "$tmp/head/$f" 2>/dev/null; then
      { [ ! -e "$tmp/box/$f" ] && [ ! -e "$tmp/head/$f" ]; } || pending+="$f"$'\n'
    fi
  done <<< "$(changed)"
  if [ -n "$pending" ]; then
    echo "pending"; printf '%s' "$pending" | sed 's/^/  unmerged: /' >&2; exit 0
  fi
  if (cd "$tmp" && git diff --no-index --quiet box head 2>/dev/null) && [ "$base" = "$head" ]; then
    echo "up-to-date"; exit 0
  fi
  cd "$box"
  for p in "${APP_PATHS[@]}"; do
    if [ "$p" = src ]; then
      [ -d src ] && find src -mindepth 1 -maxdepth 1 ! -name test -exec rm -rf {} +
    else
      rm -rf "$p"
    fi
    [ -e "$tmp/head/$p" ] && cp -R "$tmp/head/$p" ./
  done
  echo "$head" > .sandbox-base
  git add -A -- "${APP_PATHS[@]}" .sandbox-base
  if git diff --cached --quiet; then echo "up-to-date"; exit 0; fi
  git -c user.name="lovable-sandbox-sync" -c user.email="lovable-sync@users.noreply.github.com" \
    commit -q -m "Sync website code from state-politics-tracker ${head:0:7}"
  [ -n "${DRY_RUN:-}" ] || git push -q origin HEAD
  echo "pushed"
  ;;
*) echo "unknown command: $cmd" >&2; exit 2 ;;
esac
