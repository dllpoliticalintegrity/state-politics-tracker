# Multi-state politics tracker — draft plan (July 2026)

Goal: build a **State Politics Tracker** — a new site, in a **new repo**,
that covers many states and lets readers switch between them, using
[hderyke/state-level-campaign-finance](https://github.com/hderyke/state-level-campaign-finance)
(SLCF) as the campaign-finance backbone.

**Decisions:**

- **The Texas Politics Tracker stays separate.** This repo, its Supabase
  project, the TEC importer, and texaspoliticstracker.com continue
  unchanged.
- **The CA Governor tracker (ca-gov-polling) stays separate too.**
- **The new repo is the single home for all other state data** — the
  site, the SLCF importer, the curated candidate data, and the sync
  workflows for every state it covers all live together in one repo.

The multi-state site launches beside the two existing single-state
sites, and they cross-link: the Texas and California tiles on the
multi-state landing page point at the existing sites, and those sites
link back to the hub from their header/footer.

This repo is that new repo. This doc is the working plan; the
interactive mock in `docs/design-drafts/multi-state-preview.html`
(self-contained, open directly in a browser, mock data) shows the
target state-switcher UX. Both originated as a draft on the
`claude/multi-state-politics-tracker-1fhk1w` branch of
[tx-politics-tracker](https://github.com/dllpoliticalintegrity/tx-politics-tracker),
where the page formats being reused were designed.

## What we're reusing vs. what SLCF gives us

The new repo bootstraps from this codebase the same way this one
bootstrapped from `ca-gov-polling` (see `docs/tx-repo-bootstrap.md` for
the checklist pattern): keep the stack (Vite/React/shadcn + Supabase +
Cloudflare Pages), the design system, the page formats (home hero,
summary strip, polling chart, field cards, money hub), and generalize
away everything TX-specific.

The SLCF repo is a Python pipeline that scrapes each state's disclosure
site and normalizes everything to one canonical format:

- **Coverage**: 24 states complete (AL, AK, AZ, AR, CA, CO, CT, DE, FL,
  GA, HI, ID, IL, IN, IA, KS, KY, LA, MD, MA, MI, MN, MS, PA), Maine in
  progress. Texas is *not* covered there — and doesn't need to be, since
  the TX site keeps its own TEC importer. California *is* covered, but
  the new site won't publish a CA dashboard while ca-gov-polling remains
  the CA home — CA stays `external` in the registry.
- **Canonical schema**: five tables per state — contributions,
  expenditures, candidates, committees, loans — written to
  `data/{State}/cleaned/*.csv`, per-state SQLite DBs, and a merged
  `data/state-level-cf.db`.
- **Operation**: `python3 src/main.py sync AZ FL GA` (or `sync all`),
  with year-range and data-type flags.

What SLCF does **not** provide: polling (we keep 270toWin per state),
independent/outside spending as a distinct concept in every state, and
candidate curation (photos, slugs, featured flags — still editorial work
per state, as `tx_candidates` is today).

## Site architecture (new repo)

### State registry

One config module drives everything (`src/states/registry.ts`):

```ts
export interface StateConfig {
  code: string;            // "mi"
  name: string;            // "Michigan"
  raceTitle: string;       // "2026 Michigan Governor's race"
  generalDate: string;     // "2026-11-03"
  agency: { name: string; url: string };   // e.g. MI Dept. of State
  pollingSourceUrl?: string;               // 270toWin state page
  status: "live" | "ready" | "planned" | "external";
  externalUrl?: string;    // status "external": TX → texaspoliticstracker.com
}
```

`status` meanings: **live** = dashboard published here; **ready** = SLCF
pipeline implemented, data importable but no curated dashboard yet;
**planned** = no pipeline yet; **external** = tracked on a separate
Political Integrity Project site (Texas and California).

### Routing

- `/` — state picker landing (hero + 50-state grid). Remembered state
  (localStorage) gets a one-click "Back to Michigan" affordance rather
  than an auto-redirect, so the landing stays shareable.
- `/:state` — state home (this repo's `Index` format)
- `/:state/candidates`, `/:state/candidates/:slug`, `/:state/polling`,
  `/:state/money/donors`, `/:state/money/outside-spending`,
  `/:state/about`
- `external` states never get routes — their landing tiles and any
  switcher entries link out.

A `StateProvider` reads `:state` from the route, validates it against
the registry (unknown → NotFound), and exposes `useStateConfig()`. All
data hooks take the state from context.

### Header / switcher

Logo: "State Politics Tracker". Next to it, a state switcher (combobox
with search — 24+ entries is too many for a plain dropdown). Switching
preserves the current sub-page (`/mi/polling` → `/ga/polling`) and
records the choice in localStorage. `ready` states appear under a
"Coming soon" group; `external` states under "Separate sites" as
outbound links; `planned` states appear only on the landing grid.

### SEO / functions

`functions/_middleware.ts` and `sitemap.xml.ts` read the registry to
emit per-state titles, descriptions, and sitemap entries for `live`
states only.

## Data architecture (new repo)

### Fresh Supabase project, state-keyed tables

A separate site means a separate Supabase project — no `tx_*` → `cf_*`
migration, no shared-database coupling, and no risk to the live TX site.
Schema mirrors SLCF's canonical five tables plus the editorial layer,
with `state` (2-letter code) on every row:

- `cf_candidates` — editorial: slug, name, party, office, status,
  featured, headshot, **state**, and a jsonb `filer_refs` for the
  state's committee/filer identifiers (some states need several per
  candidate, like TX's COH + SPAC pairs).
- `cf_filings`, `cf_contributions`, `cf_expenditures`, `cf_loans`,
  `cf_committees` — direct mappings of the canonical columns.
- `cf_independent_expenditures` — added per state as disclosure data
  allows; not all states expose an IE equivalent.
- Polling tables copied from this repo, plus `state`.

Derived views (this repo's `refresh_tx_finance_views()` pattern) group
by state from day one.

### Importer

New `scripts/data-import/slcf/import_slcf_finance.py`:

1. Run (or download artifacts from) the SLCF pipeline for the target
   states — the cleaned per-state CSVs are the interface, so we don't
   fork their scrapers.
2. Map canonical columns → `cf_*` and upsert via the Supabase service
   key, batched like this repo's TEC importer.
3. Match contributions/expenditures to curated `cf_candidates` through
   `filer_refs`, exactly as the TEC importer matches COH/SPAC accounts.

A per-state GitHub Actions workflow matrix (modeled on
`tx-finance-sync.yml`) runs nightly for `live` states only.

### Polling

Port `import-towin-polling` and parameterize the 270toWin page URL from
the registry, looping over live states. States without a tracked
governor's race hide the polling sections (the components already
handle empty data).

## Keeping two repos honest

The cost of the separate-repo decision is drift: this repo and the new
one will share a design system and page formats with no mechanism
keeping them aligned (ca-gov-polling → tx already drifted). Mitigations,
cheapest first:

1. Accept drift for app code, but treat **this repo's design tokens
   (`src/index.css`, `tailwind.config.ts`) as the canonical source** —
   copy changes forward deliberately, noting the sync in commit messages.
2. If the sites converge visually over time, extract a tiny shared
   package (tokens + a few components) — only if drift actually hurts;
   don't pre-build it.
3. TX joining the multi-state site later remains possible (port the TEC
   importer, add a `tx` registry entry, retire the redirect) — nothing
   in this design forecloses it.

## Rollout

1. **Phase 0 — this draft**: plan + interactive preview to settle the
   switcher UX and landing page before touching code.
2. **Phase 1 — bootstrap the new repo**: copy this codebase, write a
   `docs/`-style bootstrap checklist, strip TX copy/assets/data code,
   add the registry, `/:state` routes, and `StateProvider`, stand up the
   new Supabase project and Cloudflare Pages deployment. Ship with zero
   live states (landing grid only, TX tile linking out).
3. **Phase 2 — pilot states**: `cf_*` schema, SLCF importer, and 2–3
   pilots with clean 2026 governor races and good SLCF data (suggest
   **FL, MI, GA**; PA/AZ next). Curate candidates for each — the real
   per-state cost.
4. **Phase 3 — launch**: open the switcher, per-state SEO, cross-link
   from texaspoliticstracker.com's header/footer; announce.
5. **Phase 4 — scale**: remaining SLCF states as curation capacity
   allows; contribute missing states upstream to SLCF so the pipelines
   converge.

## Open questions

- **Name/domain for the new site**: "State Politics Tracker" is the
  working title — statepoliticstracker.com or a Political Integrity
  Project subdomain?
- **CA external URL**: the preview links the California tile to the
  ca-gov-polling GitHub repo; swap in the CA site's production domain.
- **Donations framing**: the donate panel copy here is TX-specific
  (`TxGovSpendStat`); the new site needs a per-state or national
  variant.
- **SLCF freshness**: TEC refreshes daily; some SLCF scrapers are
  bulk/annual. Show a per-state "last synced" stamp so stale states are
  honest about it.
