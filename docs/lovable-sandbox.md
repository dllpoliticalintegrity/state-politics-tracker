# Lovable design sandbox

Lovable gives WYSIWYG editing, but it cannot attach to an existing GitHub
repository (it only syncs to repos it creates), and this repo also holds the
data pipelines, migrations, the Worker and the deploy workflows. So Lovable
is a **sandbox for design work**: a copy of the website code in its own
Lovable project and repo, reading the live database read-only. Changes come
back here as ordinary PRs, so they get tests and review before any site
deploys.

## Set up (once)

1. **Export.** From this repo:

   ```bash
   scripts/lovable/export-sandbox.sh
   ```

   This writes `dist-lovable/state-politics-tracker-frontend-<sha>.zip`. It
   holds `src/` (minus tests), `shared/`, `public/`, `index.html`, the
   build config and `LOVABLE.md` (the sandbox's rules), and nothing else.
2. **Put it in the sandbox's repo.** The Lovable project is
   **State Politics Tracker Template**
   (https://lovable.dev/projects/99c80ba2-0077-4976-ba5b-978280ec7123), synced
   with the private repo `dllpoliticalintegrity/state-politics-tracker-template`.
   Lovable created it on its new TanStack Start starter, which cannot take
   our Vite + react-router code through a ZIP upload (Lovable's agent
   unpacked it and stopped rather than rewrite it). So the export was
   pushed to that repo directly, replacing the starter but keeping
   `.lovable/project.json`, and Lovable's sync pulled it in (2026-10-18,
   commit 9184dea). The one sandbox-only change is the dev server on port
   8080, Lovable's preview port. The project's knowledge (Lovable's
   per-project instructions) repeats LOVABLE.md and forbids migrating the
   stack. To refresh the sandbox, unzip a new export over a clone of that
   repo, keep `.lovable/` and the port, and push.
   - Never enable **Lovable Cloud** or a Supabase connection. The app
     already reads the tracker database with its public read-only key, and
     connecting anything else empties every page.
3. **Check the preview.** `/` shows the hub; `/tx`, `/tx/governor`,
   `/mi/state-senate/11` show state pages with live data. A per-state site
   (texaspoliticstracker.com) is the same pages without the `/tx` prefix.

## The loop (automatic)

`.github/workflows/lovable-sandbox.yml` runs `scripts/lovable/sync.sh` both
ways. The sandbox repo's `.sandbox-base` records the main commit its code
was last synced from, so neither direction overwrites the other.

- **Pull: Lovable to here.** Daily at 13:00 UTC, and on demand (Actions >
  Lovable sandbox sync > Run workflow > pull). If Lovable changed any app
  file since `.sandbox-base`, the workflow lays the sandbox's app files over
  that commit on the branch `lovable/sync` and opens or updates one PR,
  "Design updates from Lovable", listing the files. Because the branch
  starts from the sync point, the PR shows only Lovable's changes, and
  GitHub merges them over anything that changed here since. The PR body
  warns when Lovable touched the data layer (`src/integrations`,
  `src/hooks`, `shared/`).
- **Push: here to Lovable.** On every merge to main that touches the app
  files, and daily: main's app files are copied into the sandbox and
  `.sandbox-base` moves to main. It refuses while the sandbox holds Lovable
  edits that main does not have yet, so a design in progress is never
  overwritten; merge the pull PR and the next run updates the sandbox.

Only the app files sync: `src` (not `src/test`), `shared`, `public`,
`index.html`, `tailwind.config.ts`. The sandbox keeps its own
`.lovable/`, `vite.config.ts` (port 8080) and package files; a new npm
package added in Lovable has to be added here by hand.

Access: the secret `LOVABLE_SANDBOX_DEPLOY_KEY` is an SSH deploy key with
write access to the sandbox repo only (created 2026-10-18). Opening the PR
needs the repo setting "Allow GitHub Actions to create and approve pull
requests"; without it the run pushes `lovable/sync` and prints a link to
open the PR by hand.

By hand: `DRY_RUN=1 scripts/lovable/sync.sh pull|push <sandbox checkout>`
previews either direction; `scripts/lovable/pull-sandbox.sh <url>` prints a
plain diff.

## Keeping the sandbox current

The sandbox drifts as this repo changes. Before a new round of design work,
re-export and import a fresh project, or paste updated files into the
existing one. Re-exporting is the simple, safe default; the old Lovable
project can be archived.

## What the sandbox cannot show

The Cloudflare Worker is not in it, so it never shows the per-domain
pinning or the search-engine metadata, and the legislative maps load only if
`public/maps` was exported (it is). Data is live, so treat it as read-only.
