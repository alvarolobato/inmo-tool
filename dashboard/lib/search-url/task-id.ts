/**
 * Deterministic, stable task ids for pre-filtered search tasks (issue #277).
 *
 * A task id must be REPRODUCIBLE: the same profile + filters must always yield
 * the same id, so a separate UI feature can record "last run at" keyed on it.
 * It must also DIFFER when the search differs (a changed price band or location
 * is a different search). We hash the normalized filter tuple with a small pure
 * FNV-1a (no `crypto` import, so the module stays client-safe) and prefix it
 * with a human-readable `portal:section` so ids are debuggable at a glance.
 */

/** FNV-1a 32-bit hash → 8-char lowercase hex. Deterministic and client-safe. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The normalized filters that identify a single search task. */
export interface TaskFilterKey {
  portal: string;
  /** Portal section: idealista operation (`venta-viviendas`) or aliseda tipo-plural (`pisos`). */
  section: string;
  /** The location slug used in the URL (e.g. `estepona-malaga`, `andalucia/malaga`, or ""). */
  location: string;
  priceMin?: number;
  priceMax?: number;
  sizeMin?: number;
  sizeMax?: number;
  roomsMin?: number;
}

/**
 * `${portal}:${section}:${hash}` — a stable id for the task. Deterministic over
 * the normalized filter tuple; two calls with equal keys return equal ids.
 */
export function stableTaskId(k: TaskFilterKey): string {
  const canonical = [
    `portal=${k.portal}`,
    `section=${k.section}`,
    `location=${k.location}`,
    `pmin=${k.priceMin ?? ""}`,
    `pmax=${k.priceMax ?? ""}`,
    `smin=${k.sizeMin ?? ""}`,
    `smax=${k.sizeMax ?? ""}`,
    `rmin=${k.roomsMin ?? ""}`,
  ].join("&");
  return `${k.portal}:${k.section}:${fnv1a(canonical)}`;
}
