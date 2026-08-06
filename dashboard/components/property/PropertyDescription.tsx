import type { PropertyListingDetail } from "@/lib/property-detail";

/**
 * Property advert text (issue #360). The description is stored per-listing
 * (`listing.description`) and was never surfaced on the detail page, so the
 * investor couldn't read the advert body — critical context like "inmueble
 * en construcción… la edificación se encuentra parcialmente ejecutada"
 * (property 796) was invisible.
 *
 * A deduped property can host several listings, each with its own
 * description. Rule:
 *   - Ignore empty/whitespace-only descriptions.
 *   - Show the single longest one (most informative) when the others carry
 *     no materially different text (one is a substring of the other, i.e.
 *     the same advert re-scraped or a truncated copy).
 *   - When two or more listings carry materially different text, show them
 *     per-source (source label + body), longest first — the same
 *     per-source-independence principle LinkedListings.tsx follows.
 *
 * Renders nothing when no listing has a non-empty description; the page
 * omits the whole section in that case (no empty box) — see
 * `pickDescriptions`, exported so the page can gate the section on it.
 */

export interface SourceDescription {
  source: string;
  text: string;
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Returns the descriptions worth showing, longest first. Empty when none.
 * A single element means "show just the longest"; two or more means the
 * texts are materially different and should be shown per-source.
 */
export function pickDescriptions(listings: PropertyListingDetail[]): SourceDescription[] {
  const candidates: SourceDescription[] = [];
  for (const l of listings) {
    const text = (l.description ?? "").trim();
    if (text.length > 0) candidates.push({ source: l.source, text });
  }
  // Longest first: the fullest advert leads, and the substring test below is
  // "is this shorter one already contained in a longer one we're keeping".
  candidates.sort((a, b) => b.text.length - a.text.length);

  const kept: SourceDescription[] = [];
  for (const candidate of candidates) {
    const norm = normalize(candidate.text);
    // Skip a description that is contained in (or contains) one we already
    // kept — same advert re-scraped, or a truncated copy: no new information.
    const redundant = kept.some((k) => {
      const kn = normalize(k.text);
      return kn.includes(norm) || norm.includes(kn);
    });
    if (!redundant) kept.push(candidate);
  }
  return kept;
}

const bodyStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.5,
  color: "var(--fg)",
  whiteSpace: "pre-wrap",
};

export function PropertyDescription({ listings }: { listings: PropertyListingDetail[] }) {
  const descriptions = pickDescriptions(listings);
  if (descriptions.length === 0) return null;

  // Single, informative body — the common case (one source, or several
  // sources carrying the same advert).
  if (descriptions.length === 1) {
    return (
      <div data-testid="property-description">
        <p style={bodyStyle}>{descriptions[0].text}</p>
      </div>
    );
  }

  // Materially-different bodies across sources — show each with its source
  // label so the investor can compare what each portal published.
  return (
    <div
      data-testid="property-description"
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
    >
      {descriptions.map((d) => (
        <div
          key={d.source}
          data-testid="property-description-source"
          data-source={d.source}
          style={{
            padding: "8px 10px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-1)",
          }}
        >
          <span
            style={{
              display: "inline-block",
              marginBottom: 6,
              fontSize: 11,
              padding: "2px 6px",
              borderRadius: 4,
              background: "var(--bg-2)",
              color: "var(--fg-muted)",
              textTransform: "capitalize",
            }}
          >
            {d.source}
          </span>
          <p style={bodyStyle}>{d.text}</p>
        </div>
      ))}
    </div>
  );
}
