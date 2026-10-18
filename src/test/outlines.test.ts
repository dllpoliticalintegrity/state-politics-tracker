import { describe, it, expect } from "vitest";
import { stateOutlineUrl } from "@/states/outlines";
import { STATES } from "@/states/registry";

describe("state outlines", () => {
  it("has an outline for every state in the registry", () => {
    for (const s of STATES) expect(stateOutlineUrl(s.code), s.code).toBeTruthy();
  });

  it("is case-insensitive and null for unknown codes", () => {
    expect(stateOutlineUrl("MI")).toBe(stateOutlineUrl("mi"));
    expect(stateOutlineUrl("zz")).toBeNull();
    expect(stateOutlineUrl(null)).toBeNull();
  });
});
