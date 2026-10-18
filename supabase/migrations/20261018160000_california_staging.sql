-- California joins the multi-state hub, the way Texas did (20261007150000).
--
-- California's governor race was tracked on its own site (cagovtracker.com,
-- the ca-poll-boost repo) reading ca_* tables in the Integrity Index project
-- (qjsesvdduoriofiodumm), which the ca-gov-polling repo's CAL-ACCESS importer
-- filled. That importer carries California-only semantics that have no place
-- in the generic cf_* schema: amendments that restate whole filings (keep the
-- highest amend_id per filing), Form 497 late reports re-reported on the next
-- Form 460, "informational only" memo rows, Schedule A's unitemized line,
-- independent expenditures reported on both 496s and 460/461s, and IE
-- committees found by name. So, like Texas, California keeps its own staging
-- layer here and a nightly publish copies its settled rows into cf_*:
--
--   scripts/data-import/cal-access/import_ca_finance.py (moved from
--   ca-gov-polling; ca-finance-sync.yml, 09:00 UTC)
--     -> ca_* staging tables below (same shapes as the qjses originals)
--     -> ca_cf_* views below: the rows to publish, already in cf_* shape
--     -> publish_california_to_cf() (20261018160100; pg_cron 10:30 UTC)
--     -> cf_* (state 'ca', source 'calaccess'), which the site reads.
--
-- What is different from Texas: California's candidates are not staged.
-- cf_candidates is their editorial record from the start (the admin console
-- edits it through spt-tracker-admin, like every state but Texas), and
-- ca_candidate_filers only maps each candidate to the CAL-ACCESS filer ids
-- the importer needs. The importer still reads `ca_candidates`, now a view
-- over the two, so its code is unchanged.
--
-- Left behind in qjses (not ported): ca_late_contributions,
-- ca_filing_summary and ca_candidate_controlled_committees (nothing writes
-- them), the is_latest flags and their recompute function (the deduped views
-- below don't use them), and the site-only matviews (cf_* has its own). The
-- qjses tables stay where they are until cagovtracker.com moves to the hub.
--
-- Applied to the shared tracker project (lohxdfrxnxuxjdvvyfjc) via the
-- Supabase MCP. Idempotent.

-- ---------------------------------------------------------------------------
-- The race and its candidates (seeded once from qjses; edited in cf_* after)
-- ---------------------------------------------------------------------------

-- Same race_id as in qjses, so the two projects' polling rows line up.
insert into public.races (race_id, state, district, slug, year)
values ('2530707e-c944-4e18-892d-e5ca3f4bfbff', 'California', 'Governor',
        'california-governor-2026', 2026)
on conflict do nothing;

-- Same uuids and slugs as ca_candidates in qjses, so cagovtracker.com's
-- candidate URLs and the importer's rows carry over. Party spelled the way
-- cf_candidates spells it; NULL is California's "no party preference".
-- Status: California's primary is top-two, and Becerra and Hilton advanced
-- (the only names in the general-election polls); everyone else who was
-- still running is lost_primary.
insert into public.cf_candidates as k (
  id, state, office, slug, name, party, filer_refs, committee_name,
  election_year, status, title, bio, photo_url, photo_url_large,
  photo_url_medium, photo_url_thumb, website, twitter_user, instagram_user,
  facebook_user, youtube_user, featured
)
select
  v.id::uuid, 'ca', 'governor', v.slug, v.name,
  case v.party when 'D' then 'Democrat' when 'R' then 'Republican' else v.party end,
  to_jsonb(array['ca:' || v.committee_filer_id]), v.committee_name, 2026,
  case
    when v.status <> 'active' then v.status
    when v.slug in ('xavier-becerra', 'steve-hilton') then 'active'
    else 'lost_primary'
  end,
  v.title, v.bio, v.photo_url, v.photo_url_large, v.photo_url_medium,
  v.photo_url_thumb, v.website, v.twitter_user, v.instagram_user,
  v.facebook_user, v.youtube_user, v.featured
from (values
  ('911a8f42-ec9d-4585-bdeb-9e6a885a0d7d', 'antonio-villaraigosa', 'Antonio Villaraigosa', 'D', 1004202, 1471635, 'Villaraigosa for Governor 2026', 'active', NULL, NULL, 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a2/AntonioVillaraigosaHWOFMay2013.jpg/500px-AntonioVillaraigosaHWOFMay2013.jpg', NULL, 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a2/AntonioVillaraigosaHWOFMay2013.jpg/500px-AntonioVillaraigosaHWOFMay2013.jpg', NULL, NULL, NULL, NULL, NULL, NULL, false),
  ('312a8be8-0a2b-4cbc-a1b6-f569ebc8522e', 'betty-yee', 'Betty T. Yee', 'D', 1273041, 1465732, 'Yee for Governor 2026', 'withdrawn', NULL, NULL, 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c5/Betty_Yee_official_photo.jpg/500px-Betty_Yee_official_photo.jpg', NULL, 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c5/Betty_Yee_official_photo.jpg/500px-Betty_Yee_official_photo.jpg', NULL, NULL, NULL, NULL, NULL, NULL, false),
  ('d9e51683-5a30-48bb-bf10-0ae9b049e954', 'chad-bianco', 'Chad Bianco', 'R', 1479043, 1479095, 'Bianco for Governor 2026', 'active', NULL, NULL, 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9b/Chad_Bianco%2C_2025.jpg/500px-Chad_Bianco%2C_2025.jpg', NULL, 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9b/Chad_Bianco%2C_2025.jpg/500px-Chad_Bianco%2C_2025.jpg', NULL, NULL, NULL, NULL, NULL, NULL, false),
  ('067e69b9-f702-4259-baea-acc90890619b', 'daniel-mercuri', 'Daniel R. Mercuri', NULL, 1433524, 1480107, 'Mercuri for California Governor 2026', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false),
  ('1e7fa957-ff51-42c8-bd0e-856119e111b2', 'dawit-kellel', 'Dawit A. Kellel', NULL, 1486205, 1486702, 'Kellel for Governor 2026', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false),
  ('40aa6a8b-7bc2-4ffa-a484-5cbcb4dce4cc', 'elaine-culotti', 'Elaine Culotti', 'R', 1486416, 1486415, 'Culotti for Governor 2026', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false),
  ('447f845b-2280-4966-bbe1-2ca2c3a814f0', 'eric-swalwell', 'Eric Swalwell', 'D', 1485127, 1485146, 'Swalwell for Governor 2026', 'withdrawn', NULL, NULL, 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fa/Eric_Swalwell_114th_official_photo.jpg/500px-Eric_Swalwell_114th_official_photo.jpg', NULL, 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fa/Eric_Swalwell_114th_official_photo.jpg/500px-Eric_Swalwell_114th_official_photo.jpg', NULL, NULL, NULL, NULL, NULL, NULL, false),
  ('9dc193ad-2865-43c8-8de5-924f5cc7438d', 'jon-henderson', 'Jon Henderson', NULL, 1484520, 1484529, 'Henderson for Governor 2026', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false),
  ('fcf79e6d-b9e1-4198-8743-6e8ad970dbee', 'katie-porter', 'Katie Porter', 'D', 1479598, 1479597, 'Porter for Governor 2026', 'active', NULL, NULL, 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/02/Katie_Porter_Official_Portrait_%28slight_crop%29.jpg/500px-Katie_Porter_Official_Portrait_%28slight_crop%29.jpg', NULL, 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/02/Katie_Porter_Official_Portrait_%28slight_crop%29.jpg/500px-Katie_Porter_Official_Portrait_%28slight_crop%29.jpg', NULL, NULL, NULL, NULL, NULL, NULL, false),
  ('3532965f-88ac-4bd5-a50e-cb0ba31bfb89', 'leo-zacky', 'Leo S. Zacky', 'R', 1439063, 1460341, 'Zacky for Governor 2026', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false),
  ('e1ef4182-73fb-4d8c-b94a-0a186a355568', 'lewis-norman-herms', 'Lewis Norman Herms', NULL, 1481557, 1482256, 'Herms for Governor 2026', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false),
  ('afa1e047-c853-437e-bcbe-ac3f542a4289', 'matt-mahan', 'Matt Mahan', 'D', 1486859, 1486858, 'Mahan for Governor 2026', 'active', NULL, NULL, 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8d/Matt_Mahan_Farmer%27s_Market_4_April_2026_%28cropped%29.jpg/500px-Matt_Mahan_Farmer%27s_Market_4_April_2026_%28cropped%29.jpg', NULL, 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8d/Matt_Mahan_Farmer%27s_Market_4_April_2026_%28cropped%29.jpg/500px-Matt_Mahan_Farmer%27s_Market_4_April_2026_%28cropped%29.jpg', NULL, NULL, NULL, NULL, NULL, NULL, false),
  ('60ff68fb-a197-46a5-8dd7-ec3b63840138', 'nancy-young', 'Nancy D. Young', NULL, 1488342, 1488484, 'Young for Governor 2026', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false),
  ('c9d31130-fb5a-4125-aa7a-369d53b739cb', 'raji-rab', 'Raji Rab', NULL, 1468886, 1469628, 'Rab for Governor 2026', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false),
  ('95067275-b154-4e2c-bc7b-968e0f976e6d', 'ramsey-robinson', 'Ramsey Robinson', NULL, 1481349, 1481346, 'Robinson for Governor 2026', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false),
  ('a30b3d24-a49c-450e-b691-6713e834143f', 'reza-safarnejad', 'Reza Safarnejad', NULL, 1481368, 1487566, 'Safarnejad for Governor 2026', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false),
  ('feef535a-32fe-45ed-ac19-23e705ffe280', 'serge-fiankan', 'Serge Fiankan', NULL, 1444990, 1485387, 'Fiankan for Governor 2026', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false),
  ('517be7b5-0519-4512-871d-b49e2fcc5d2f', 'steve-hilton', 'Steve Hilton', 'R', 1480426, 1480425, 'Hilton for Governor 2026', 'active', NULL, NULL, 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6a/Steve_Hilton_%2854233451292%29_%28cropped%29.jpg/500px-Steve_Hilton_%2854233451292%29_%28cropped%29.jpg', NULL, 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6a/Steve_Hilton_%2854233451292%29_%28cropped%29.jpg/500px-Steve_Hilton_%2854233451292%29_%28cropped%29.jpg', NULL, NULL, NULL, NULL, NULL, NULL, false),
  ('dc901b1f-ae0a-4198-9ad8-23fa2c2d54bb', 'thunder-parley', 'Thunder Parley', NULL, 1482430, 1482429, 'Parley for Governor 2026', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false),
  ('ae28fd59-ea3c-4c16-babe-3799c76dac05', 'timothy-nelson', 'Timothy D. Nelson', NULL, 1488271, 1488446, 'Nelson for Governor 2026', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false),
  ('f56d251f-eb82-4061-bf5d-aa30172dd1a7', 'tom-steyer', 'Tom Steyer', 'D', 1485078, 1485077, 'Steyer for Governor 2026', 'active', NULL, NULL, 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/82/NYCW_2025_-_Tom_Steyer_05_%28cropped%29.jpg/500px-NYCW_2025_-_Tom_Steyer_05_%28cropped%29.jpg', NULL, 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/82/NYCW_2025_-_Tom_Steyer_05_%28cropped%29.jpg/500px-NYCW_2025_-_Tom_Steyer_05_%28cropped%29.jpg', NULL, NULL, NULL, NULL, NULL, NULL, false),
  ('7059d6f4-ce65-4700-bdb3-938cd059b880', 'tony-thurmond', 'Tony Thurmond', 'D', 1295704, 1461509, 'Thurmond for Governor 2026', 'active', NULL, NULL, 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/bf/Assemblymember_Tony_Thurmond_%28cropped%29.jpg/500px-Assemblymember_Tony_Thurmond_%28cropped%29.jpg', NULL, 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/bf/Assemblymember_Tony_Thurmond_%28cropped%29.jpg/500px-Assemblymember_Tony_Thurmond_%28cropped%29.jpg', NULL, NULL, NULL, NULL, NULL, NULL, false),
  ('0dd55236-95e5-4620-b786-29ecff399a29', 'william-derek-grasty', 'William Derek Grasty', NULL, 1483316, 1483315, 'Grasty for Governor 2026', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false),
  ('dd1be8f5-facf-4b9e-bd96-1728782c2bbd', 'xavier-becerra', 'Xavier Becerra', 'D', 1003436, 1480025, 'Becerra for Governor 2026', 'active', NULL, NULL, 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/85/HHS_Xavier_Becerra.jpg/500px-HHS_Xavier_Becerra.jpg', NULL, 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/85/HHS_Xavier_Becerra.jpg/500px-HHS_Xavier_Becerra.jpg', NULL, NULL, NULL, NULL, NULL, NULL, false)
) as v (id, slug, name, party, candidate_filer_id, committee_filer_id,
        committee_name, status, title, bio, photo_url, photo_url_large,
        photo_url_medium, photo_url_thumb, website, twitter_user,
        instagram_user, facebook_user, youtube_user, featured)
on conflict (id) do nothing;

-- Candidate -> CAL-ACCESS filer ids. candidate_filer_id is the person (it is
-- what Form 496 independent expenditures name as their target);
-- committee_filer_id is the controlled committee whose filings carry the
-- money (cf_candidates.filer_refs holds it as "ca:<id>").
create table if not exists public.ca_candidate_filers (
  candidate_id uuid primary key references public.cf_candidates(id) on delete cascade,
  candidate_filer_id integer not null unique,
  committee_filer_id integer unique,
  created_at timestamptz not null default now()
);

insert into public.ca_candidate_filers (candidate_id, candidate_filer_id, committee_filer_id)
select k.id, f.candidate_filer_id, f.committee_filer_id
from (values
  ('antonio-villaraigosa', 1004202, 1471635), ('betty-yee', 1273041, 1465732),
  ('chad-bianco', 1479043, 1479095), ('daniel-mercuri', 1433524, 1480107),
  ('dawit-kellel', 1486205, 1486702), ('elaine-culotti', 1486416, 1486415),
  ('eric-swalwell', 1485127, 1485146), ('jon-henderson', 1484520, 1484529),
  ('katie-porter', 1479598, 1479597), ('leo-zacky', 1439063, 1460341),
  ('lewis-norman-herms', 1481557, 1482256), ('matt-mahan', 1486859, 1486858),
  ('nancy-young', 1488342, 1488484), ('raji-rab', 1468886, 1469628),
  ('ramsey-robinson', 1481349, 1481346), ('reza-safarnejad', 1481368, 1487566),
  ('serge-fiankan', 1444990, 1485387), ('steve-hilton', 1480426, 1480425),
  ('thunder-parley', 1482430, 1482429), ('timothy-nelson', 1488271, 1488446),
  ('tom-steyer', 1485078, 1485077), ('tony-thurmond', 1295704, 1461509),
  ('william-derek-grasty', 1483316, 1483315), ('xavier-becerra', 1003436, 1480025)
) as f (slug, candidate_filer_id, committee_filer_id)
join public.cf_candidates k on k.slug = f.slug and k.state = 'ca'
on conflict (candidate_id) do nothing;

-- What the importer reads (load_seed_candidates: id, slug, name,
-- candidate_filer_id, committee_filer_id). Names and slugs come from
-- cf_candidates, so an edit in the console reaches the importer's
-- committee-name matching too.
create or replace view public.ca_candidates with (security_invoker = true) as
select k.id, k.slug, k.name, k.party, k.status, k.committee_name,
       f.candidate_filer_id, f.committee_filer_id
from public.ca_candidate_filers f
join public.cf_candidates k on k.id = f.candidate_id;

-- ---------------------------------------------------------------------------
-- Staging tables (the importer's upsert keys, as in qjses)
-- ---------------------------------------------------------------------------

create table if not exists public.ca_filings (
  filing_id bigint not null,
  amend_id integer not null,
  filer_id integer not null,
  form_type text,
  stmt_type text,
  rpt_start date,
  rpt_end date,
  elect_date date,
  filed_date date,
  office_cd text,
  cand_filer_id integer,
  cand_last_name text,
  cand_first_name text,
  sup_opp_cd text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (filing_id, amend_id)
);
create index if not exists idx_ca_filings_filer on public.ca_filings (filer_id);
create index if not exists idx_ca_filings_form_type on public.ca_filings (form_type);

create table if not exists public.ca_contributions (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references public.cf_candidates(id) on delete cascade,
  committee_filer_id integer not null,
  filing_id bigint not null,
  amend_id integer not null,
  tran_id text not null,
  contributor_type text,
  contributor_last_name text,
  contributor_first_name text,
  employer text,
  occupation text,
  amount numeric(14,2) not null,
  contribution_date date,
  cumulative_ytd numeric(14,2),
  city text,
  state text,
  zip text,
  cycle text,
  source_form_type text,
  elec_date date,
  tran_type text,
  cmte_id integer,
  memo_code text,
  memo_refno text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (filing_id, amend_id, tran_id)
);
create index if not exists idx_ca_contributions_candidate on public.ca_contributions (candidate_id);

create table if not exists public.ca_expenditures (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references public.cf_candidates(id) on delete cascade,
  committee_filer_id integer not null,
  filing_id bigint not null,
  amend_id integer not null,
  tran_id text not null,
  payee_last_name text,
  payee_first_name text,
  payee_city text,
  payee_state text,
  payee_zip text,
  amount numeric(14,2) not null,
  expenditure_date date,
  expn_code text,
  expn_description text,
  cumulative_ytd numeric(14,2),
  cycle text,
  source_form_type text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (filing_id, amend_id, tran_id)
);
create index if not exists idx_ca_expenditures_candidate on public.ca_expenditures (candidate_id);

-- Cover-page (SMRY_CD) lines; F460 Schedule A line 2 is the unitemized total.
create table if not exists public.ca_summaries (
  filing_id bigint not null,
  amend_id integer not null,
  line_item text not null,
  form_type text not null,
  amount_a numeric(14,2),
  amount_b numeric(14,2),
  elec_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (filing_id, amend_id, line_item, form_type)
);

create table if not exists public.ca_loans (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references public.cf_candidates(id) on delete cascade,
  committee_filer_id integer not null,
  filing_id bigint not null,
  amend_id integer not null,
  tran_id text not null,
  lender_type text,
  lender_last_name text,
  lender_first_name text,
  lender_city text,
  lender_state text,
  lender_zip text,
  lender_employer text,
  lender_occupation text,
  amount_received numeric(14,2),
  outstanding_balance numeric(14,2),
  amount_forgiven numeric(14,2),
  amount_repaid numeric(14,2),
  cumulative_loaned numeric(14,2),
  loan_rate text,
  loan_date date,
  due_date date,
  loan_type text,
  cycle text,
  source_form_type text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (filing_id, amend_id, tran_id)
);
create index if not exists idx_ca_loans_candidate on public.ca_loans (candidate_id);

create table if not exists public.ca_ie_committees (
  filer_id integer primary key,
  name text not null,
  filer_type text,
  status text,
  sponsor text,
  party_affiliation text,
  city text,
  state text,
  zip text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Curated IE committee -> candidate attributions the name match misses.
create table if not exists public.ca_ie_committee_targets (
  ie_committee_filer_id integer not null,
  target_candidate_id uuid not null references public.cf_candidates(id) on delete cascade,
  support_oppose text not null check (support_oppose in ('S', 'O')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (ie_committee_filer_id, target_candidate_id)
);

insert into public.ca_ie_committee_targets (ie_committee_filer_id, target_candidate_id, support_oppose, notes)
values
  (1487425, 'afa1e047-c853-437e-bcbe-ac3f542a4289', 'S', 'CALIFORNIA BACK TO BASICS SUPPORTING MATT MAHAN FOR GOVERNOR 2026'),
  (1488176, 'afa1e047-c853-437e-bcbe-ac3f542a4289', 'S', 'DELIVER FOR CALIFORNIA - MATT MAHAN FOR GOVERNOR 2026'),
  (1489677, 'f56d251f-eb82-4061-bf5d-aa30172dd1a7', 'O', 'California is Not for Sale, No on Steyer for Governor 2026'),
  (1490885, 'dd1be8f5-facf-4b9e-bd96-1728782c2bbd', 'S', 'WORKING FAMILIES FOR HEALTHY COMMUNITIES SUPPORTING BECERRA FOR GOVERNOR 2026')
on conflict do nothing;

create table if not exists public.ca_independent_expenditures (
  id uuid primary key default gen_random_uuid(),
  ie_committee_filer_id integer references public.ca_ie_committees(filer_id) on delete cascade,
  target_candidate_id uuid references public.cf_candidates(id) on delete cascade,
  filing_id bigint not null,
  amend_id integer not null,
  tran_id text not null,
  support_oppose text,
  amount numeric(14,2) not null,
  expenditure_date date,
  description text,
  expn_code text,
  cycle text,
  source_form_type text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (filing_id, amend_id, tran_id)
);
create index if not exists idx_ca_ie_target on public.ca_independent_expenditures (target_candidate_id);
create index if not exists idx_ca_ie_committee on public.ca_independent_expenditures (ie_committee_filer_id);

create table if not exists public.ca_ie_contributions (
  id uuid primary key default gen_random_uuid(),
  ie_committee_filer_id integer not null references public.ca_ie_committees(filer_id) on delete cascade,
  filing_id bigint not null,
  amend_id integer not null,
  tran_id text not null,
  contributor_type text,
  contributor_last_name text,
  contributor_first_name text,
  employer text,
  occupation text,
  amount numeric(14,2) not null,
  contribution_date date,
  cumulative_ytd numeric(14,2),
  city text,
  state text,
  zip text,
  cycle text,
  source_form_type text,
  tran_type text,
  cmte_id integer,
  memo_code text,
  memo_refno text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (filing_id, amend_id, tran_id)
);
create index if not exists idx_ca_ie_contribs_committee on public.ca_ie_contributions (ie_committee_filer_id, tran_id);

-- Staging is service-role only: RLS on, no policies. The site reads cf_*.
alter table public.ca_candidate_filers enable row level security;
alter table public.ca_filings enable row level security;
alter table public.ca_contributions enable row level security;
alter table public.ca_expenditures enable row level security;
alter table public.ca_summaries enable row level security;
alter table public.ca_loans enable row level security;
alter table public.ca_ie_committees enable row level security;
alter table public.ca_ie_committee_targets enable row level security;
alter table public.ca_independent_expenditures enable row level security;
alter table public.ca_ie_contributions enable row level security;

-- ---------------------------------------------------------------------------
-- Dedup rules, ported verbatim from qjses (ca-gov-polling migrations
-- 20260501000000 .. 20260527140000). These are what made cagovtracker.com's
-- totals match CAL-ACCESS PowerSearch.
-- ---------------------------------------------------------------------------

-- Contributions: highest amendment per filing; F497 late-report rows dropped
-- once a Form 460 covers their date; "X" (memo) rows dropped; Schedule B
-- loans received this period unioned in as contribution rows.
create or replace view public.ca_contributions_deduped with (security_invoker = true) as
with max_amend as (
  select filing_id, max(amend_id) as max_amend_id
  from public.ca_contributions
  where candidate_id is not null
  group by filing_id
), contrib_filtered as (
  select c.*
  from public.ca_contributions c
  join max_amend m on m.filing_id = c.filing_id and m.max_amend_id = c.amend_id
  where c.candidate_id is not null
), filer_coverage as (
  select filer_id as committee_filer_id, max(rpt_end) as max_f460_rpt_end
  from public.ca_filings
  where form_type = 'F460' and rpt_end is not null
  group by filer_id
), itemized as (
  select a.id, a.candidate_id, a.committee_filer_id, a.filing_id, a.amend_id,
         a.tran_id, a.contributor_type, a.contributor_last_name,
         a.contributor_first_name, a.employer, a.occupation, a.amount,
         a.contribution_date, a.cumulative_ytd, a.city, a.state, a.zip,
         a.cycle, a.source_form_type
  from contrib_filtered a
  left join filer_coverage fc on fc.committee_filer_id = a.committee_filer_id
  where not (upper(coalesce(a.source_form_type, '')) = 'F497P1'
             and fc.max_f460_rpt_end is not null
             and (a.contribution_date is null or a.contribution_date <= fc.max_f460_rpt_end))
    and upper(coalesce(a.tran_type, '')) <> 'X'
), loans as (
  select l.id, l.candidate_id, l.committee_filer_id, l.filing_id, l.amend_id,
         l.tran_id,
         coalesce(l.lender_type, 'IND') as contributor_type,
         l.lender_last_name as contributor_last_name,
         l.lender_first_name as contributor_first_name,
         l.lender_employer as employer,
         l.lender_occupation as occupation,
         coalesce(l.amount_received, 0) as amount,
         l.loan_date as contribution_date,
         l.cumulative_loaned as cumulative_ytd,
         l.lender_city as city, l.lender_state as state, l.lender_zip as zip,
         l.cycle,
         'LOAN-' || coalesce(l.source_form_type, 'B1') as source_form_type
  from public.ca_loans l
  join max_amend m on m.filing_id = l.filing_id and m.max_amend_id = l.amend_id
  where coalesce(l.amount_forgiven, 0) = 0
    and not (coalesce(l.amount_received, 0) = 0 and coalesce(l.outstanding_balance, 0) > 0)
    and coalesce(l.amount_received, 0) > 0
)
select * from itemized
union all
select * from loans;

-- Outside spending: highest amendment per filing; 496 rows dropped once the
-- committee's periodic 460/461 covers their date.
create or replace view public.ca_independent_expenditures_deduped with (security_invoker = true) as
with max_amend as (
  select filing_id, max(amend_id) as max_amend_id
  from public.ca_independent_expenditures
  group by filing_id
), amend_deduped as (
  select ie.*
  from public.ca_independent_expenditures ie
  join max_amend m on m.filing_id = ie.filing_id and m.max_amend_id = ie.amend_id
), periodic_coverage as (
  select ie_committee_filer_id, max(expenditure_date) as periodic_end
  from amend_deduped
  where source_form_type in ('F460', 'F461')
  group by ie_committee_filer_id
)
select d.id, d.ie_committee_filer_id, d.target_candidate_id, d.filing_id,
       d.amend_id, d.tran_id, d.support_oppose, d.amount, d.expenditure_date,
       d.description, d.expn_code, d.cycle, d.source_form_type
from amend_deduped d
left join periodic_coverage c on c.ie_committee_filer_id = d.ie_committee_filer_id
where d.source_form_type in ('F460', 'F461')
   or c.periodic_end is null
   or d.expenditure_date is null
   or d.expenditure_date > c.periodic_end;

-- Money into IE committees: highest amendment per filing, then one row per
-- (committee, tran_id) — the same receipt re-reported on a later filing
-- counts once.
create or replace view public.ca_ie_contributions_deduped with (security_invoker = true) as
with max_amend as (
  select filing_id, max(amend_id) as max_amend_id
  from public.ca_ie_contributions
  group by filing_id
)
select distinct on (c.ie_committee_filer_id, c.tran_id)
       c.id, c.ie_committee_filer_id, c.filing_id, c.amend_id, c.tran_id,
       c.contributor_type, c.contributor_last_name, c.contributor_first_name,
       c.employer, c.occupation, c.amount, c.contribution_date, c.city,
       c.state, c.zip, c.cycle, c.source_form_type
from public.ca_ie_contributions c
join max_amend m on m.filing_id = c.filing_id and m.max_amend_id = c.amend_id
order by c.ie_committee_filer_id, c.tran_id, c.filing_id desc, c.amend_id desc;

-- ---------------------------------------------------------------------------
-- The rows to publish, in cf_* shape (publish_california_to_cf() copies
-- these; reconciliation queries can read them directly)
-- ---------------------------------------------------------------------------
-- source_txn_id is CAL-ACCESS's own key without the amendment number
-- ("<filing_id>-<tran_id>"), so an amended filing updates its rows in place
-- instead of replacing them. Contributor types: IND is a person, everything
-- else (COM, OTH, PTY, SCC, RCP) an organisation — the hub's INDIVIDUAL /
-- ENTITY split. (cagovtracker.com counted OTH as individuals.)

create or replace view public.ca_cf_contributions with (security_invoker = true) as
select
  d.id, d.candidate_id, 'ca:' || d.committee_filer_id as committee_id,
  d.filing_id::text || '-' || d.tran_id as source_txn_id,
  case when upper(d.contributor_type) = 'IND' then 'INDIVIDUAL' else 'ENTITY' end as contributor_type,
  d.contributor_last_name, d.contributor_first_name, d.employer, d.occupation,
  d.amount, d.contribution_date, d.city, d.state, d.zip,
  coalesce(d.cycle, 'unknown') as cycle, d.source_form_type
from public.ca_contributions_deduped d
where coalesce(d.source_form_type, '') not like 'LOAN-%'
union all
-- Small gifts CAL-ACCESS doesn't itemize: one row per Form 460 (its latest
-- amendment), Schedule A line 2, dated the end of the period it covers —
-- the line cagovtracker.com added to make total raised match PowerSearch.
-- No contributor type, like the pilot's unitemized lump sums.
select
  null::uuid, f.candidate_id, 'ca:' || f.filer_id,
  'unitemized-' || f.filing_id::text,
  null, 'Unitemized (small-dollar) contributions', null, null, null,
  s.amount_a, f.rpt_end, null, null, null,
  case
    when f.rpt_end is null then 'unknown'
    when f.rpt_end < date '2025-01-01' then 'pre-cycle'
    when f.rpt_end <= date '2026-06-02' then 'primary-2026'
    when f.rpt_end <= date '2026-11-03' then 'general-2026'
    else 'post-2026'
  end,
  'A-UNITEMIZED'
from (
  select distinct on (lf.filer_id, lf.filing_id)
         lf.filer_id, lf.filing_id, lf.amend_id, lf.rpt_end, cf.candidate_id
  from public.ca_filings lf
  join public.ca_candidate_filers cf on cf.committee_filer_id = lf.filer_id
  where lf.form_type = 'F460'
  order by lf.filer_id, lf.filing_id, lf.amend_id desc
) f
join public.ca_summaries s
  on s.filing_id = f.filing_id and s.amend_id = f.amend_id
 and s.form_type = 'A' and s.line_item = '2'
where coalesce(s.amount_a, 0) <> 0;

create or replace view public.ca_cf_loans with (security_invoker = true) as
select
  d.id, d.candidate_id, 'ca:' || d.committee_filer_id as committee_id,
  d.filing_id::text || '-' || d.tran_id as source_txn_id,
  case when upper(d.contributor_type) = 'IND' then 'INDIVIDUAL' else 'ENTITY' end as lender_type,
  d.contributor_last_name as lender_last_name,
  d.contributor_first_name as lender_first_name,
  d.amount, d.contribution_date as loan_date, false as is_guarantor,
  coalesce(d.cycle, 'unknown') as cycle
from public.ca_contributions_deduped d
where d.source_form_type like 'LOAN-%';

-- Spending: highest amendment per filing (each amendment restates the whole
-- filing; summing every amendment counted most payments two or three times).
create or replace view public.ca_cf_expenditures with (security_invoker = true) as
with max_amend as (
  select filing_id, max(amend_id) as max_amend_id
  from public.ca_expenditures
  group by filing_id
)
select
  e.id, e.candidate_id, 'ca:' || e.committee_filer_id as committee_id,
  e.filing_id::text || '-' || e.tran_id as source_txn_id,
  null::text as payee_type, e.payee_last_name, e.payee_first_name,
  e.payee_city, e.payee_state, e.payee_zip, e.amount, e.expenditure_date,
  e.expn_code as category, e.expn_description as description,
  coalesce(e.cycle, 'unknown') as cycle
from public.ca_expenditures e
join max_amend m on m.filing_id = e.filing_id and m.max_amend_id = e.amend_id
where e.candidate_id is not null;

create or replace view public.ca_cf_independent_expenditures with (security_invoker = true) as
select
  d.id, 'ca:' || d.ie_committee_filer_id as ie_filer_ident,
  d.target_candidate_id,
  d.filing_id::text || '-' || d.tran_id as source_txn_id,
  upper(d.support_oppose) as support_oppose, d.amount, d.expenditure_date,
  -- cf has no category column; keep CAL-ACCESS's code in the description,
  -- as Texas does.
  nullif(concat_ws(' · ', nullif(d.description, ''), nullif(d.expn_code, '')), '') as description,
  coalesce(d.cycle, 'unknown') as cycle
from public.ca_independent_expenditures_deduped d
where d.target_candidate_id is not null
  and d.ie_committee_filer_id is not null;

create or replace view public.ca_cf_ie_contributions with (security_invoker = true) as
select
  d.id, 'ca:' || d.ie_committee_filer_id as ie_filer_ident,
  d.ie_committee_filer_id::text || '-' || d.tran_id as source_txn_id,
  case when upper(d.contributor_type) = 'IND' then 'INDIVIDUAL' else 'ENTITY' end as contributor_type,
  d.contributor_last_name, d.contributor_first_name, d.employer, d.occupation,
  d.amount, d.contribution_date, d.city, d.state,
  coalesce(d.cycle, 'unknown') as cycle
from public.ca_ie_contributions_deduped d;

-- Views are staging too: not for the anon key.
revoke all on public.ca_candidates, public.ca_contributions_deduped,
  public.ca_independent_expenditures_deduped, public.ca_ie_contributions_deduped,
  public.ca_cf_contributions, public.ca_cf_loans, public.ca_cf_expenditures,
  public.ca_cf_independent_expenditures, public.ca_cf_ie_contributions
  from anon, authenticated;
