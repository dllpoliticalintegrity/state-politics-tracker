import { describe, expect, it } from "vitest";
import { describeRiverRow, pageWindow, parseRiverParams, riverParamsToSearch } from "@/lib/moneyRiver";

describe("parseRiverParams", () => {
  it("defaults everything when the URL is bare", () => {
    expect(parseRiverParams(new URLSearchParams(""))).toEqual({ kind: "all", candidate: "", page: 1 });
  });

  it("reads valid values", () => {
    const p = new URLSearchParams("kind=outside&candidate=11111111-1111-1111-1111-111111111111&page=3");
    expect(parseRiverParams(p)).toEqual({
      kind: "outside",
      candidate: "11111111-1111-1111-1111-111111111111",
      page: 3,
    });
  });

  it("falls back on junk instead of throwing", () => {
    const p = new URLSearchParams("kind=bribes&candidate=abbott&page=-2");
    expect(parseRiverParams(p)).toEqual({ kind: "all", candidate: "", page: 1 });
    expect(parseRiverParams(new URLSearchParams("page=abc")).page).toBe(1);
    // The Texas site's old race filter is simply ignored (the race is in the path now).
    expect(parseRiverParams(new URLSearchParams("race=ATTYGEN&kind=loan"))).toEqual({ kind: "loan", candidate: "", page: 1 });
  });

  it("round-trips through riverParamsToSearch, omitting defaults", () => {
    const f = { kind: "loan" as const, candidate: "", page: 2 };
    const s = riverParamsToSearch(f);
    expect(s.toString()).toBe("kind=loan&page=2");
    expect(parseRiverParams(s)).toEqual(f);
    expect(riverParamsToSearch({ kind: "all", candidate: "", page: 1 }).toString()).toBe("");
  });
});

describe("describeRiverRow", () => {
  const base = { candidate_name: "Greg Abbott", support_oppose: null };
  it("reads each kind as a sentence", () => {
    expect(describeRiverRow({ ...base, kind: "contribution", counterparty: "Jane Doe" })).toEqual({
      subject: "Jane Doe", verb: "gave to", object: "Greg Abbott",
    });
    expect(describeRiverRow({ ...base, kind: "expenditure", counterparty: "Anedot Inc" })).toEqual({
      subject: "Greg Abbott", verb: "paid", object: "Anedot Inc",
    });
    expect(describeRiverRow({ ...base, kind: "loan", counterparty: "Greg Abbott" })).toEqual({
      subject: "Greg Abbott", verb: "lent to", object: "Greg Abbott",
    });
    expect(describeRiverRow({ ...base, kind: "outside", counterparty: "Some PAC", support_oppose: "O" }).verb)
      .toBe("spent to oppose");
    expect(describeRiverRow({ ...base, kind: "outside", counterparty: "Some PAC", support_oppose: "S" }).verb)
      .toBe("spent to support");
  });

  it("labels a missing counterparty rather than printing blank", () => {
    expect(describeRiverRow({ ...base, kind: "contribution", counterparty: "  " }).subject).toBe("Unitemized");
  });
});

describe("pageWindow", () => {
  it("clamps the page and reports the visible range", () => {
    expect(pageWindow(1, 50, 0)).toEqual({ pages: 1, current: 1, from: 0, to: 0 });
    expect(pageWindow(2, 50, 120)).toEqual({ pages: 3, current: 2, from: 51, to: 100 });
    expect(pageWindow(9, 50, 120)).toEqual({ pages: 3, current: 3, from: 101, to: 120 });
  });
});
