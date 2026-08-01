/**
 * Glossary utility — term matching and React node generation.
 *
 * `applyGlossary()` scans a text string for glossary term matches (case-insensitive,
 * word-boundary aware) and wraps each match with a GlossaryTooltip component.
 * Only the first occurrence of each term per text string is wrapped.
 *
 * Returns a React.ReactNode: either a plain string (when no matches) or a
 * fragment with text + tooltip spans interleaved.
 */

import React from "react";
import { GlossaryTooltip } from "@/components/GlossaryTooltip";
import type { GlossaryItem } from "@/lib/schema";

/**
 * Apply glossary tooltips to a text string.
 *
 * @param text - The plain text to scan.
 * @param glossary - Array of glossary entries. Pass undefined/empty to return plain string.
 * @returns A React.ReactNode — plain string when no matches, ReactFragment otherwise.
 */
export function applyGlossary(
  text: string,
  glossary: GlossaryItem[] | undefined,
): React.ReactNode {
  if (!glossary || glossary.length === 0) return text;

  // Build a list of matches: {start, end, term, definition}
  // Only collect the first occurrence of each term.
  interface Match {
    start: number;
    end: number;
    term: string;
    definition: string;
  }

  const seenTerms = new Set<string>();
  const matches: Match[] = [];

  for (const entry of glossary) {
    const normalizedTerm = entry.term.toLowerCase();
    if (seenTerms.has(normalizedTerm)) continue;

    // We avoid \b because it does not correctly handle accented characters
    // for our use case (e.g. "venta" should not match inside "preventa", or
    // "entrada" should not match inside "reentrada").
    // The regex is case-insensitive.
    // For broader JS runtime compatibility (e.g. older Safari), we avoid
    // lookbehind by capturing the left boundary as group 1 and the term as
    // group 2, then requiring a right boundary with a lookahead.
    // The pattern matches the term only when surrounded by a non-word
    // character from our custom character set, or by the start/end of string.
    const escapedTerm = entry.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(
      `(^|[^\\wáéíóúüñÁÉÍÓÚÜÑ])(${escapedTerm})(?=$|[^\\wáéíóúüñÁÉÍÓÚÜÑ])`,
      "i",
    );

    const match = regex.exec(text);
    if (match) {
      const matchedTerm = match[2];
      const start = match.index + match[1].length;
      seenTerms.add(normalizedTerm);
      matches.push({
        start,
        end: start + matchedTerm.length,
        term: matchedTerm, // use the matched text (preserves original casing)
        definition: entry.definition,
      });
    }
  }

  if (matches.length === 0) return text;

  // Sort by start position; when two matches start at the same index (e.g.
  // "Ventas" vs "Ventas Netas"), prefer the longer (more specific) term first
  // so it always wins in the overlap resolution below.
  matches.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  // NOTE: If a term's collected match is dropped because it overlaps with a
  // longer match, we do NOT re-scan for the next occurrence of that term.
  // This keeps the algorithm O(n·m) and avoids complexity in the common case
  // where glossary entries are distinct phrases. Users who need all occurrences
  // wrapped should use dedicated rich-text tooling.
  const nonOverlapping: Match[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start >= cursor) {
      nonOverlapping.push(m);
      cursor = m.end;
    }
  }

  if (nonOverlapping.length === 0) return text;

  // Build an array of React nodes: alternating text segments and tooltips
  const nodes: React.ReactNode[] = [];
  let pos = 0;

  for (const m of nonOverlapping) {
    if (m.start > pos) {
      nodes.push(text.slice(pos, m.start));
    }
    nodes.push(
      React.createElement(GlossaryTooltip, {
        key: `${m.start}-${m.term}`,
        term: m.term,
        definition: m.definition,
      }),
    );
    pos = m.end;
  }

  if (pos < text.length) {
    nodes.push(text.slice(pos));
  }

  return React.createElement(React.Fragment, null, ...nodes);
}
