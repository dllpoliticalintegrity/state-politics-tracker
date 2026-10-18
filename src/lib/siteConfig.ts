// Chrome for a dedicated state site: the registry's defaults, overridden by
// the state's published `state_sites` row (edited in the data-diamine admin).
// Pure, so the merge is unit-tested without React or Supabase.
import { siteNameFor } from "../../shared/site";
import type { RaceConfig, StateConfig } from "@/states/registry";

export interface StateSiteRow {
  state: string;
  hostname: string;
  worker_name: string;
  display_name: string;
  tagline: string | null;
  logo_url: string | null;
  accent_color: string | null;
  about_text: string | null;
  credits_text: string | null;
  hidden_races: string[];
  published: boolean;
}

export interface SiteChrome {
  siteName: string;
  tagline: string | null;
  logoUrl: string | null;
  accentColor: string | null;
  aboutText: string | null;
  creditsText: string | null;
  /** The state's races minus the row's hidden_races (never empty if the registry has any). */
  races: RaceConfig[];
}

const blank = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);

export function applySiteConfig(cfg: StateConfig | null, row: StateSiteRow | null): SiteChrome {
  const races = cfg?.races ?? [];
  const base: SiteChrome = {
    siteName: siteNameFor(cfg?.name),
    tagline: null,
    logoUrl: null,
    accentColor: null,
    aboutText: null,
    creditsText: null,
    races,
  };
  if (!cfg || !row || !row.published || row.state !== cfg.code) return base;
  const hidden = new Set(row.hidden_races ?? []);
  const visible = races.filter((r) => !hidden.has(r.raceSlug));
  return {
    siteName: blank(row.display_name) ?? base.siteName,
    tagline: blank(row.tagline),
    logoUrl: blank(row.logo_url),
    accentColor: blank(row.accent_color),
    aboutText: blank(row.about_text),
    creditsText: blank(row.credits_text),
    races: visible.length ? visible : races,
  };
}
