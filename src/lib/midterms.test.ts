import { describe, expect, it } from "vitest";
import { timeUntilMidterms, midtermsStatus } from "./midterms";

describe("2026 midterms countdown", () => {
  it("counts days, hours, minutes, and seconds to November 3, 2026", () => {
    expect(timeUntilMidterms(new Date(2026, 10, 1, 12, 34, 56))).toEqual({ days: 1, hours: 11, minutes: 25, seconds: 4 });
  });

  it("decrements seconds and rolls over minutes", () => {
    expect(timeUntilMidterms(new Date(2026, 10, 2, 23, 58, 59))).toEqual({ days: 0, hours: 0, minutes: 1, seconds: 1 });
    expect(timeUntilMidterms(new Date(2026, 10, 2, 23, 59, 0))).toEqual({ days: 0, hours: 0, minutes: 1, seconds: 0 });
    expect(timeUntilMidterms(new Date(2026, 10, 2, 23, 59, 1))).toEqual({ days: 0, hours: 0, minutes: 0, seconds: 59 });
  });

  it("marks the entire local election date as Election Day", () => {
    expect(timeUntilMidterms(new Date(2026, 10, 3))).toEqual({ days: 0, hours: 0, minutes: 0, seconds: 0 });
    expect(midtermsStatus(new Date(2026, 10, 3, 23, 59))).toBe("today");
  });

  it("never displays negative days after the midterms", () => {
    expect(timeUntilMidterms(new Date(2026, 10, 4))).toEqual({ days: 0, hours: 0, minutes: 0, seconds: 0 });
    expect(midtermsStatus(new Date(2026, 10, 4))).toBe("past");
    expect(midtermsStatus(new Date(2026, 9, 19))).toBe("upcoming");
  });
});