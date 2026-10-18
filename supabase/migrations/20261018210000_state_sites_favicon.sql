-- state_sites.favicon_url: an uploaded browser-tab icon for a dedicated state
-- site (PNG/SVG/ICO/WebP/JPEG in the admin project's public candidate-photos
-- bucket, under state-sites/<state>/). Null = the build's favicon.ico. Written
-- by the data-diamine admin's Site tab through spt-tracker-admin.
--
-- Applied to the tracker project (lohxdfrxnxuxjdvvyfjc) via the Supabase MCP.

alter table public.state_sites add column if not exists favicon_url text;
