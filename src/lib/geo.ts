// Minimal GeoJSON → SVG plumbing for the district maps: a Mercator
// projection fitted to a viewBox and a path-string builder. Dependency-free
// on purpose (the maps are small — ~150 simplified polygons — so d3-geo
// would be the only thing it's used for).

export type Position = [number, number];
export type Ring = Position[];
export interface GeoFeature {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry:
    | { type: "Polygon"; coordinates: Ring[] }
    | { type: "MultiPolygon"; coordinates: Ring[][] };
}
export interface FeatureCollection {
  type: "FeatureCollection";
  features: GeoFeature[];
}

/** Outer rings of a feature (holes are dropped: they'd render as gaps). */
export function outerRings(f: GeoFeature): Ring[] {
  return f.geometry.type === "Polygon"
    ? [f.geometry.coordinates[0]]
    : f.geometry.coordinates.map((poly) => poly[0]);
}

const RAD = Math.PI / 180;
// Both axes in radians so one scale keeps the aspect ratio honest.
const mercX = (lon: number) => lon * RAD;
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, lat)) * RAD) / 2));

export interface Projection {
  /** lon/lat → viewBox x/y */
  project: (p: Position) => Position;
  width: number;
  height: number;
}

/**
 * Mercator fitted so the collection's bounding box fills `width` (minus
 * `pad` on each side); height follows the aspect ratio.
 */
export function fitMercator(fc: FeatureCollection, width = 600, pad = 4): Projection {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const f of fc.features) {
    for (const ring of outerRings(f)) {
      for (const [lon, lat] of ring) {
        const x = mercX(lon);
        const y = mercY(lat);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!Number.isFinite(minX)) return { project: () => [0, 0], width, height: width };
  const inner = width - pad * 2;
  const scale = inner / (maxX - minX || 1);
  const height = Math.round((maxY - minY) * scale + pad * 2);
  return {
    width,
    height,
    project: ([lon, lat]) => [
      pad + (mercX(lon) - minX) * scale,
      // Screen y grows downwards; Mercator y grows northwards.
      pad + (maxY - mercY(lat)) * scale,
    ],
  };
}

const fmt = (n: number) => (Math.round(n * 10) / 10).toString();

/** SVG path `d` for a feature's outer rings under a projection. */
export function featurePath(f: GeoFeature, proj: Projection): string {
  return outerRings(f)
    .map((ring) => {
      const pts = ring.map(proj.project);
      return `M${pts.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join("L")}Z`;
    })
    .join("");
}

/**
 * A label anchor for a feature: the centroid of its largest outer ring
 * (area-weighted polygon centroid, in projected space), plus that ring's
 * projected width so callers can decide whether a label fits.
 */
export function featureLabelAnchor(f: GeoFeature, proj: Projection): { x: number; y: number; width: number } {
  let best: { x: number; y: number; width: number; area: number } | null = null;
  for (const ring of outerRings(f)) {
    const pts = ring.map(proj.project);
    let area = 0, cx = 0, cy = 0;
    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % pts.length];
      const cross = x0 * y1 - x1 * y0;
      area += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
      if (x0 < minX) minX = x0;
      if (x0 > maxX) maxX = x0;
    }
    area /= 2;
    const abs = Math.abs(area);
    if (abs < 1e-9) continue;
    const anchor = { x: cx / (6 * area), y: cy / (6 * area), width: maxX - minX, area: abs };
    if (!best || anchor.area > best.area) best = anchor;
  }
  return best ?? { x: 0, y: 0, width: 0 };
}
