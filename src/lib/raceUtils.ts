/**
 * Generates a URL path from a race slug
 */
export const getRaceUrl = (slug: string | null): string => {
  if (!slug) return "/races";
  return `/race/${slug}`;
};

/**
 * Parse a primary_date stored as "M/D" (e.g., "5/19") into a Date object.
 * Uses the race year (default 2026) to construct a full date.
 */
export function parsePrimaryDate(primaryDate: string, year: number = 2026): Date | null {
  if (!primaryDate) return null;
  const parts = primaryDate.split('/').map(Number);
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return new Date(year, parts[0] - 1, parts[1]);
}

/**
 * Format a primary_date string for display.
 */
export function formatPrimaryDate(
  primaryDate: string | null,
  year: number = 2026,
  options: Intl.DateTimeFormatOptions = { month: 'long', day: 'numeric', year: 'numeric' }
): string | null {
  if (!primaryDate) return null;
  const date = parsePrimaryDate(primaryDate, year);
  if (!date) return null;
  return date.toLocaleDateString('en-US', options);
}

/**
 * Format race title like "CO SEN" or "TX-5"
 */
export function formatRaceTitle(state: string | null, district: string | null): string {
  if (district?.includes("Senate")) return `${state} SEN`;
  return district ? `${state}-${district}` : `${state}`;
}
