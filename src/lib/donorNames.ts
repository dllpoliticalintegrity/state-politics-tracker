/**
 * Donor identity across the site's contribution rows.
 *
 * The importers do not agree on where a person's name goes. Most split it
 * ("COX" / "MICHAEL"), but the SLCF loader stores a lender's whole name in
 * the last-name field ("MICHAEL COX", first null), Georgia files
 * "Jones, William Burton", Wisconsin "STEELE KEVIN M", and Texas and
 * California publish their own shapes into cf_*. Grouped on (last, first)
 * the same self-funder ranked twice: Mike Cox's $3.0M of loans beside his
 * $1.0M of gifts on the Michigan governor's Top Donors page.
 *
 * `donorKey` is the one grouping rule: the name parts joined, normalised
 * (upper case, letters/digits/spaces only) and, for a person, sorted word by
 * word so that word order — and which field each word sat in — stops
 * mattering: "MICHAEL COX", "COX, MICHAEL" and ("COX", "MICHAEL") all key as
 * "COX MICHAEL". Organisations keep their word order ("COX MAJORITY PAC").
 * Middle names and initials still tell donors apart, as before.
 *
 * Mirrors `public.cf_donor_key()` in the tracker database (migration
 * 20261028180000_cf_top_donors_full_name_key.sql), which `cf_top_donors`
 * groups on; the two must agree so that rows the matview already merged per
 * candidate merge the same way across candidates here.
 */

/** Upper case, letters/digits/spaces only, single spaces. */
export function normalizeNamePart(s: string | null | undefined): string {
  return (s ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The key two contribution rows share when they name the same donor. "" when
 * the row names nobody. `contributorType` "ENTITY" keeps word order; any
 * other value (INDIVIDUAL, null — a lender without a type) is a person.
 */
export function donorKey(
  contributorType: string | null | undefined,
  lastName: string | null | undefined,
  firstName: string | null | undefined,
): string {
  const joined = normalizeNamePart(`${lastName ?? ""} ${firstName ?? ""}`);
  if (!joined) return "";
  if ((contributorType ?? "").toUpperCase() === "ENTITY") return joined;
  return joined.split(" ").sort().join(" ");
}

/** True when `row` carries a split name (a first name), the form worth showing. */
export function hasSplitName(row: { contributor_first_name: string | null }): boolean {
  return !!(row.contributor_first_name ?? "").trim();
}
