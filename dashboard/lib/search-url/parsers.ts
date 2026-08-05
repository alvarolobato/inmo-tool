/**
 * Registry of per-portal URL parsers (capture-to-infer, issue #293).
 *
 * The parse-side mirror of index.ts's BUILDERS. Client-safe: pure code, no
 * `pg`. `parseSearchUrl` is what the save route (server) and the resolver both
 * call to decode a real navigated search URL into `{filters, categoryKey,
 * template}`.
 */

import { idealistaParser } from "./portals/idealista";
import { alisedaParser } from "./portals/aliseda";
import type { ParsedSearchUrl, PortalSearchUrlParser } from "./types";

/** Registered parsers, keyed by portal. Mirror of index.ts's BUILDERS. */
export const PARSERS: Record<string, PortalSearchUrlParser> = {
  [idealistaParser.portal]: idealistaParser,
  [alisedaParser.portal]: alisedaParser,
};

/**
 * Decode a real search URL for `portal`, or null if the portal has no parser
 * or the URL isn't that portal's search grammar. A null is not an error — the
 * save route logs it and no-ops (a URL we can't decode simply isn't learned).
 */
export function parseSearchUrl(portal: string, url: string): ParsedSearchUrl | null {
  const parser = PARSERS[portal];
  if (!parser) return null;
  return parser.parse(url);
}
