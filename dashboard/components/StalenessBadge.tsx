import { computeStaleness, type StalenessBand } from "@/lib/staleness";

/**
 * Renders the listing-staleness indicator ("visto hace N días") with a visual
 * treatment that escalates by band (issue #243, roadmap §6.1). Shared by the
 * candidate card and the property-detail header so both read the same fact
 * the same way.
 *
 * Renders NOTHING when `lastSeenAt` is null/unknown — an unknown last-seen is
 * not a fresh one (see computeStaleness), and a "visto hoy" we can't back up
 * would be exactly the over-claiming the roadmap warns against.
 *
 * Pure/presentational (no hooks) so it drops into both the server-rendered
 * card tree and the client-rendered detail page without a "use client" of its
 * own.
 */

// Escalating treatment: fresh is a quiet neutral note; aging borrows the same
// amber `--warn` tokens the card's warn-flag badges use; stale reuses the
// danger fallback pattern those flags use for their warn tone (no `--danger`
// token exists project-wide — the card literals the fallback, so this matches
// it exactly rather than inventing a new token). Deliberately not red-alarm
// for `aging`: the label is a fact worth noticing, not a "sold" claim.
const BAND_STYLE: Record<StalenessBand, { bg: string; fg: string }> = {
  fresh: { bg: "transparent", fg: "var(--fg-subtle)" },
  aging: { bg: "var(--warn-bg)", fg: "var(--warn)" },
  stale: { bg: "var(--danger-bg, rgba(239,68,68,0.14))", fg: "var(--danger, #ef4444)" },
};

export function StalenessBadge({
  lastSeenAt,
  testId = "staleness-badge",
  now,
}: {
  lastSeenAt: string | null;
  testId?: string;
  /** Injectable for deterministic tests; defaults to `new Date()`. */
  now?: Date;
}) {
  const staleness = computeStaleness(lastSeenAt, now);
  if (staleness === null) return null;

  const style = BAND_STYLE[staleness.band];
  return (
    <span
      data-testid={testId}
      data-staleness-band={staleness.band}
      data-staleness-days={staleness.days}
      title={`Última confirmación en el origen: ${staleness.label}. No implica que se haya vendido — solo cuándo se vio por última vez.`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        fontSize: 10,
        lineHeight: "14px",
        padding: "1px 5px",
        borderRadius: 3,
        fontWeight: 600,
        background: style.bg,
        color: style.fg,
        whiteSpace: "nowrap",
      }}
    >
      {staleness.label}
    </span>
  );
}
