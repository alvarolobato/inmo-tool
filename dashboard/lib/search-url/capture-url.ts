/**
 * Capture-URL helper (issue #529) — the URL a HARVESTER should OPEN for a search
 * task, which differs from the task's canonical `url` ONLY for an Idealista
 * map-view (drawn-zone) search.
 *
 * Idealista renders a `…/mapa-google?shape=((…))` search as a MAP of PINS, not a
 * list of detail-card anchors, so harvesting it yields zero links and capture
 * never arms (the "≥1 anchor" gate fires one layer before the map→listing
 * normalisation could run). The LISTING (card) view of the SAME search — the
 * identical URL with the `/mapa-google` segment stripped, query + hash preserved
 * byte-for-byte — renders cards and captures cleanly.
 *
 * This is a CONSUMPTION-side transform only. The task's `url` stays verbatim /
 * canonical (`/mapa-google`) everywhere it is displayed, decoded or matched
 * against the stored pin (D-101); only the capture-open path uses this. Dispatch
 * by portal so the next portal that grows a map view has one place to plug in.
 *
 * Idempotent and byte-preserving: `toListingUrl` is a no-op for any URL that is
 * already a listing path or is not an Idealista map URL, and never re-encodes
 * `.search` / `.hash` (the `shape=((…))` value survives character-for-character).
 */

import { toListingUrl } from "./portals/idealista";

/**
 * The URL a harvester should open for a `(portal, url)` search task. Identical to
 * `url` for every portal except Idealista, where a map-view URL is normalised to
 * its listing form. Never throws; returns `url` unchanged when nothing applies.
 */
export function toCaptureUrl(portal: string, url: string): string {
  return portal === "idealista" ? toListingUrl(url) : url;
}
