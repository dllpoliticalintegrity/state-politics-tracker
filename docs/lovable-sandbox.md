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
2. **Import into Lovable.** Create a new project from the ZIP (Lovable:
   import / upload a ZIP).
   - If Lovable offers **Lovable Cloud** or a Supabase connection, decline.
     The app already reads the tracker database with its public read-only
     key, and connecting anything else empties every page.
   - Turn on **GitHub sync** for the project. Lovable creates its own repo,
     e.g. `dllpoliticalintegrity/state-politics-tracker-design`.
3. **Check the preview.** `/` shows the hub; `/tx`, `/tx/governor`,
   `/mi/state-senate/11` show state pages with live data. A per-state site
   (texaspoliticstracker.com) is the same pages without the `/tx` prefix.

## The loop

1. Edit visually in Lovable. Lovable commits to its own repo.
2. When a change is ready, run from this repo:

   ```bash
   scripts/lovable/pull-sandbox.sh https://github.com/dllpoliticalintegrity/state-politics-tracker-design
   ```

   It fetches the sandbox into a temporary folder and prints the files that
   differ from ours, with the full diff in `dist-lovable/sandbox.diff`.
3. Bring the wanted changes over on a branch, run the tests and build, and
   open a PR. Leave out anything Lovable changed in the data layer
   (`src/integrations/supabase`, `src/hooks`, `shared/`) unless it is meant.
4. Merge the PR; the normal deploy publishes the hub and every state site.

## Keeping the sandbox current

The sandbox drifts as this repo changes. Before a new round of design work,
re-export and import a fresh project, or paste updated files into the
existing one. Re-exporting is the simple, safe default; the old Lovable
project can be archived.

## What the sandbox cannot show

The Cloudflare Worker is not in it, so it never shows the per-domain
pinning or the search-engine metadata, and the legislative maps load only if
`public/maps` was exported (it is). Data is live, so treat it as read-only.
