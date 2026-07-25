import { describe, it, expect } from "vitest";
import { partitionField, type FieldEntry } from "@/lib/field";

const entry = (
  name: string,
  raised: number,
  opts: { pollPct?: number | null; status?: string } = {},
): FieldEntry => ({
  id: name,
  name,
  status: opts.status ?? "active",
  raised,
  pollPct: opts.pollPct ?? null,
});

describe("field partitioning", () => {
  it("hides candidates with no money on record", () => {
    const { shown, withoutFilings } = partitionField(
      [entry("Funded", 250_000), entry("Unfunded", 0)],
      { polled: false, financeReady: true },
    );
    expect(shown.map((e) => e.name)).toEqual(["Funded"]);
    expect(withoutFilings.map((e) => e.name)).toEqual(["Unfunded"]);
  });

  it("keeps the whole field visible until finance totals land", () => {
    // Totals arrive after candidates; filtering early would blank the grid.
    const { shown, withoutFilings } = partitionField(
      [entry("Funded", 0), entry("Unfunded", 0)],
      { polled: false, financeReady: false },
    );
    expect(shown).toHaveLength(2);
    expect(withoutFilings).toHaveLength(0);
  });

  it("ranks polled races by poll average, unpolled by money", () => {
    const field = [
      entry("Broad support", 10_000, { pollPct: 40 }),
      entry("Deep pockets", 900_000, { pollPct: 12 }),
    ];
    expect(
      partitionField(field, { polled: true, financeReady: true }).shown.map((e) => e.name),
    ).toEqual(["Broad support", "Deep pockets"]);
    expect(
      partitionField(field, { polled: false, financeReady: true }).shown.map((e) => e.name),
    ).toEqual(["Deep pockets", "Broad support"]);
  });

  it("drops unpolled candidates from a polled race before the money rule", () => {
    // No polling average and no filings: reported once, as unpolled, not as a
    // finance gap — otherwise the note would name people the race never showed.
    const { shown, withoutFilings } = partitionField(
      [entry("Polled", 5_000, { pollPct: 22 }), entry("Fringe", 0)],
      { polled: true, financeReady: true },
    );
    expect(shown.map((e) => e.name)).toEqual(["Polled"]);
    expect(withoutFilings).toHaveLength(0);
  });

  it("keeps withdrawn candidates out of unpolled fields", () => {
    const { shown } = partitionField(
      [entry("Running", 100, { status: "running" }), entry("Gone", 500, { status: "withdrawn" })],
      { polled: false, financeReady: true },
    );
    expect(shown.map((e) => e.name)).toEqual(["Running"]);
  });
});
