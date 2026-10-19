import { describe, expect, it } from "vitest";
import { STATES } from "@/states/registry";
import { REPRESENTATIVE_LOOKUP_URLS } from "./representativeLookup";

describe("official state representative lookups", () => {
  it("provides an HTTPS destination for every state", () => {
    expect(STATES).toHaveLength(50);
    for (const state of STATES) {
      const destination = REPRESENTATIVE_LOOKUP_URLS[state.code];
      expect(destination, state.name).toBeDefined();
      expect(new URL(destination ?? "").protocol, state.name).toBe("https:");
    }
  });

  it("sends California visitors to the state legislature's address lookup", () => {
    expect(REPRESENTATIVE_LOOKUP_URLS.ca).toBe("https://findyourrep.legislature.ca.gov/");
  });

  it("sends Texas visitors to the state's Who Represents Me tool", () => {
    expect(REPRESENTATIVE_LOOKUP_URLS.tx).toBe("https://wrm.capitol.texas.gov/");
  });
});