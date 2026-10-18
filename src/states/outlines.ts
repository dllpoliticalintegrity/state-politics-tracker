// Silhouette of each state for the header logo, one SVG per postal code in
// src/assets/states (Census cartographic boundaries via us-atlas@3.0.1,
// each projected around its own centre, simplified, and scaled to a
// 100-unit box). Used as a CSS mask, so the fill colour comes from the theme.
const files = import.meta.glob("../assets/states/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const BY_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(files).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1, -4), url]),
);

/** URL of a state's outline SVG, or null for an unknown code. */
export function stateOutlineUrl(code: string | null | undefined): string | null {
  return (code && BY_CODE[code.toLowerCase()]) || null;
}
