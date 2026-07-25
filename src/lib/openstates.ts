// Helpers for the Open States officeholder layer (cf_officials).
//
// Open States (https://openstates.org) publishes curated, public-domain (CC0)
// records of everyone currently holding state office —
// https://github.com/openstates/people. `scripts/data-import/openstates/`
// syncs them into cf_officials; this module holds the display-side vocabulary.

export const OPENSTATES_URL = "https://openstates.org";
export const OPENSTATES_PEOPLE_REPO = "https://github.com/openstates/people";

/**
 * Registry office slug -> Open States role type. Mirrors ROLE_TO_OFFICE in
 * `scripts/data-import/openstates/import_openstates_people.py`; kept here so
 * the UI can tell "no incumbent record exists" (Florida's CFO and Agriculture
 * Commissioner have no Open States equivalent) apart from "not synced yet".
 */
export const OFFICE_TO_OS_ROLE: Record<string, string> = {
  governor: "governor",
  "lt-governor": "lt_governor",
  "attorney-general": "attorney general",
  "secretary-of-state": "secretary of state",
};

export function officeIsCoveredByOpenStates(office: string): boolean {
  return office in OFFICE_TO_OS_ROLE;
}

// ---------------------------------------------------------------------------
// Chambers
// ---------------------------------------------------------------------------

export type Chamber = "upper" | "lower";

// Most states call them Senate/House; these don't. (Nebraska's unicameral is
// keyed "legislature" by Open States, so it never reaches this map.)
const LOWER_CHAMBER_NAMES: Record<string, string> = {
  ca: "Assembly",
  nv: "Assembly",
  ny: "Assembly",
  wi: "Assembly",
  nj: "General Assembly",
  md: "House of Delegates",
  va: "House of Delegates",
  wv: "House of Delegates",
};

export function chamberLabel(stateCode: string, chamber: Chamber): string {
  if (chamber === "upper") return "Senate";
  return LOWER_CHAMBER_NAMES[stateCode.toLowerCase()] ?? "House";
}

export function memberLabel(stateCode: string, chamber: Chamber): string {
  if (chamber === "upper") return "Senator";
  const lower = chamberLabel(stateCode, chamber);
  return lower.includes("Delegates") ? "Delegate" : "Representative";
}

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

/**
 * One-letter party code for compact roster rows ("D · District 25"). Colors and
 * full labels come from `@/lib/finance` (partyColor / partyLabel), which the
 * candidate cards already use — Open States spells parties out ("Democratic"),
 * and those helpers accept the long form.
 */
export function partyAbbrev(party: string | null | undefined): string | null {
  const p = (party ?? "").trim();
  if (!p) return null;
  const lower = p.toLowerCase();
  if (lower.startsWith("democrat")) return "D";
  if (lower.startsWith("republican")) return "R";
  if (lower.startsWith("independent")) return "I";
  return p[0].toUpperCase();
}

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

/** "Term ends Jan 2027" — Open States term dates are the constitutional ones. */
export function formatTermEnd(termEnd: string | null | undefined): string | null {
  if (!termEnd) return null;
  const d = new Date(`${termEnd}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return `Term ends ${d.toLocaleDateString("en-US", { month: "short", year: "numeric" })}`;
}

// ---------------------------------------------------------------------------
// Matching officeholders to curated candidates
// ---------------------------------------------------------------------------

const SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"]);

function nameParts(name: string): { first: string; last: string } {
  const parts = name
    .trim()
    .toLowerCase()
    .replace(/[.,]/g, "")
    .split(/\s+/)
    .filter((p) => !SUFFIXES.has(p));
  return { first: parts[0] ?? "", last: parts[parts.length - 1] ?? "" };
}

/**
 * Whether an officeholder and a curated candidate are the same person.
 * Surname plus first-name-or-initial: enough to link "Jocelyn Benson" to her
 * candidate page without collapsing two different Smiths in the same field.
 */
export function isSamePerson(officialName: string, candidateName: string): boolean {
  const a = nameParts(officialName);
  const b = nameParts(candidateName);
  if (!a.last || a.last !== b.last) return false;
  if (a.first === b.first) return true;
  return (
    (a.first.length === 1 && b.first.startsWith(a.first)) ||
    (b.first.length === 1 && a.first.startsWith(b.first))
  );
}
