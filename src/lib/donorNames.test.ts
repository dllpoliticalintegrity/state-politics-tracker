import { describe, expect, it } from "vitest";
import { donorKey, hasSplitName, normalizeNamePart } from "./donorNames";

describe("donorKey", () => {
  it("keys a whole name in the last-name field and a split name as one person", () => {
    // Mike Cox (Michigan governor): loans filed as "MICHAEL COX" / null,
    // gifts as "COX" / "MICHAEL".
    expect(donorKey("INDIVIDUAL", "MICHAEL COX", null)).toBe("COX MICHAEL");
    expect(donorKey("INDIVIDUAL", "COX", "MICHAEL")).toBe("COX MICHAEL");
    expect(donorKey("INDIVIDUAL", "Cox", "Michael")).toBe("COX MICHAEL");
  });

  it("reads a comma-separated whole name and a last-first whole name the same way", () => {
    expect(donorKey("INDIVIDUAL", "Jones, William Burton", null)).toBe(
      donorKey("INDIVIDUAL", "JONES", "WILLIAM BURTON"),
    );
    expect(donorKey("INDIVIDUAL", "STEELE KEVIN M", null)).toBe(donorKey("INDIVIDUAL", "Steele", "Kevin M."));
  });

  it("treats a lender without a type as a person", () => {
    expect(donorKey(null, "MICHAEL COX", null)).toBe("COX MICHAEL");
  });

  it("keeps different people apart", () => {
    expect(donorKey("INDIVIDUAL", "LAURA COX", null)).not.toBe(donorKey("INDIVIDUAL", "COX", "MICHAEL"));
    expect(donorKey("INDIVIDUAL", "COX", "MICHAEL J")).not.toBe(donorKey("INDIVIDUAL", "COX", "MICHAEL"));
  });

  it("keeps an organisation's word order", () => {
    expect(donorKey("ENTITY", "COX MAJORITY PAC", null)).toBe("COX MAJORITY PAC");
    expect(donorKey("ENTITY", "Realtors PAC of Michigan", null)).toBe("REALTORS PAC OF MICHIGAN");
    expect(donorKey("entity", "PAC MAJORITY COX", null)).not.toBe(donorKey("ENTITY", "COX MAJORITY PAC", null));
  });

  it("is empty for a nameless row", () => {
    expect(donorKey("INDIVIDUAL", null, null)).toBe("");
    expect(donorKey("INDIVIDUAL", " . ", "")).toBe("");
  });
});

describe("normalizeNamePart", () => {
  it("upper-cases, strips punctuation and collapses spaces", () => {
    expect(normalizeNamePart("  O'Brien-Smith,  Jr. ")).toBe("OBRIENSMITH JR");
    expect(normalizeNamePart(null)).toBe("");
  });
});

describe("hasSplitName", () => {
  it("prefers the row that carries a first name", () => {
    expect(hasSplitName({ contributor_first_name: "MICHAEL" })).toBe(true);
    expect(hasSplitName({ contributor_first_name: " " })).toBe(false);
    expect(hasSplitName({ contributor_first_name: null })).toBe(false);
  });
});
