# State Politics Tracker — Lovable design sandbox

This project is a **design sandbox** for the State Politics Tracker sites
(statepoliticstracker.com and the per-state sites such as
texaspoliticstracker.com). It is a copy of the website code only. The live
sites are built and deployed from the `dllpoliticalintegrity/state-politics-tracker`
repository; changes made here reach them only when they are copied into that
repository as a reviewed pull request.

## Rules for editing here

- **Edit the look and the words, not the data layer.** Pages
  (`src/pages`), components (`src/components`), styles (`src/index.css`,
  `tailwind.config.ts`) and copy are fair game. Leave
  `src/integrations/supabase`, `src/hooks` and `shared/` unchanged unless a
  change truly needs them; they talk to the live database.
- **Do not enable Lovable Cloud or connect a different Supabase project.**
  The app already reads the live tracker database
  (`lohxdfrxnxuxjdvvyfjc.supabase.co`) with its public, read-only key in
  `src/integrations/supabase/client.ts`. Pointing it anywhere else empties
  every page.
- **No new environment variables or secrets.** None are needed.

## What the preview shows

The preview runs the multi-state hub: the landing page at `/`, and every
state's pages under `/<state>`, e.g. `/tx` (overview), `/tx/governor`,
`/mi/state-senate/11`. A per-state site (texaspoliticstracker.com) is the
same pages without the `/tx` prefix and without the state switcher, so what
you design under `/tx` is what that site shows.

Not in this copy, and not needed for design work: the Cloudflare Worker
that serves the domains and search-engine metadata, the data pipelines, the
database migrations and the deploy workflows.

## Handing changes back

Keep Lovable's GitHub sync on. When a change is ready, tell the developer
the Lovable repository's URL; `scripts/lovable/pull-sandbox.sh` in the main
repository lists every changed file so it can be brought over as a PR.

## Floating buttons — keep them floating

Two buttons float over every page **on every screen size, including phones**: **Feedback** bottom-left (`src/components/FloatingFeedback.tsx`) and **Donate** bottom-right (`src/components/FloatingDonate.tsx`). On phones they sit just above the bottom menu (`bottom-20`); from 1280px, where that menu is hidden, they drop to the corner (`xl:bottom-6`). The owner chose this; do not move either button inline, hide it on mobile, or swap sides. A test in the main repository (`src/test/floatingButtons.test.tsx`) checks it.

