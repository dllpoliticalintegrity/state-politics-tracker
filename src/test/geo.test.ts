import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { featureLabelAnchor, featurePath, fitMercator, outerRings, type FeatureCollection } from "@/lib/geo";
import { getState } from "@/states/registry";

const square = (x0: number, y0: number, size: number, district: string) => ({
  type: "Feature" as const,
  properties: { district },
  geometry: {
    type: "Polygon" as const,
    coordinates: [[[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size], [x0, y0]] as [number, number][]],
  },
});

describe("geo helpers", () => {
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [square(-90, 40, 2, "1"), square(-88, 40, 2, "2")],
  };

  it("fits the bounding box to the viewBox width and flips y", () => {
    const proj = fitMercator(fc, 600, 0);
    expect(proj.width).toBe(600);
    expect(proj.project([-90, 40])[0]).toBeCloseTo(0, 5);
    expect(proj.project([-86, 40])[0]).toBeCloseTo(600, 5);
    // North is up: the higher latitude projects to the smaller y.
    expect(proj.project([-90, 42])[1]).toBeLessThan(proj.project([-90, 40])[1]);
    expect(proj.project([-90, 42])[1]).toBeCloseTo(0, 5);
    expect(proj.height).toBeGreaterThan(0);
  });

  it("builds closed SVG paths and drops holes", () => {
    const proj = fitMercator(fc, 600, 0);
    const d = featurePath(fc.features[0], proj);
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d.split("L")).toHaveLength(5);
    const withHole = {
      ...fc.features[0],
      geometry: { type: "Polygon" as const, coordinates: [...fc.features[0].geometry.coordinates as [number, number][][], [[-89.5, 40.5], [-89, 40.5], [-89, 41], [-89.5, 40.5]] as [number, number][]] },
    };
    expect(outerRings(withHole)).toHaveLength(1);
  });

  it("anchors labels at the centroid of the largest ring", () => {
    const proj = fitMercator(fc, 600, 0);
    const a = featureLabelAnchor(fc.features[0], proj);
    expect(a.x).toBeCloseTo(150, 0);
    expect(a.width).toBeCloseTo(300, 0);
    const multi = {
      type: "Feature" as const,
      properties: { district: "3" },
      geometry: {
        type: "MultiPolygon" as const,
        coordinates: [square(-90, 40, 0.2, "x").geometry.coordinates, square(-88, 40, 2, "y").geometry.coordinates],
      },
    };
    expect(featureLabelAnchor(multi, proj).x).toBeGreaterThan(300); // the big eastern part wins
  });
});

describe("Michigan district map files", () => {
  const mi = getState("mi")!;
  for (const chamber of mi.chambers ?? []) {
    it(`${chamber.office} map has one feature per district`, () => {
      expect(chamber.map).toBeTruthy();
      const fc = JSON.parse(readFileSync(`public${chamber.map}`, "utf8")) as FeatureCollection;
      const districts = fc.features.map((f) => String(f.properties.district));
      expect(new Set(districts).size).toBe(chamber.districts);
      for (let i = 1; i <= chamber.districts; i++) expect(districts).toContain(String(i));
      const proj = fitMercator(fc, 600);
      for (const f of fc.features) expect(featurePath(f, proj).length).toBeGreaterThan(10);
    });
  }
});
