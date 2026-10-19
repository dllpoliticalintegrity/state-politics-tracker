#!/usr/bin/env bash
# Package the website code as a ZIP for a Lovable design sandbox
# (docs/lovable-sandbox.md). Only committed files at the given ref go in:
# the app (src/, minus its tests, which import the Worker), shared/ (route
# and site helpers src/ imports), public/, index.html and the build config.
# Pipelines, migrations, the Worker, CI and secrets stay out.
#
#   scripts/lovable/export-sandbox.sh [ref]      # default: HEAD
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
ref="${1:-HEAD}"
out_dir="dist-lovable"
name="state-politics-tracker-frontend"
mkdir -p "$out_dir"
zip_path="$out_dir/$name-$(git rev-parse --short "$ref").zip"
git archive --format=zip --prefix="$name/" \
  --add-file=docs/lovable/LOVABLE.md \
  -o "$zip_path" "$ref" -- \
  src shared public index.html package.json package-lock.json \
  vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json \
  tailwind.config.ts postcss.config.js components.json eslint.config.js \
  ':(exclude)src/test'
echo "$zip_path ($(du -h "$zip_path" | cut -f1)) from $(git rev-parse --short "$ref")"
