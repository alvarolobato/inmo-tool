import {
  gradeDisplay,
  type ExtractionQuality,
} from "@/lib/extraction-quality";

/**
 * Small per-property extraction-quality badge (issue #80).
 *
 * Surfaces the completeness grade the ETL computed for this property's
 * best-extracted listing (etl/extraction_quality.py, aggregated by
 * lib/extraction-quality.ts `bestExtractionQuality`). It lets the owner tell
 * a genuinely thin listing apart from one our connector under-extracted —
 * both of which otherwise show identical blank fields.
 *
 * Renders NOTHING when `quality` is null: a listing that predates the feature
 * has no descriptor yet (it self-heals on its next fetch), and an absent
 * grade is not a low one — showing a placeholder would be over-claiming, same
 * discipline as StalenessBadge.
 *
 * Pure/presentational (no hooks) so it drops into the server-rendered header
 * tree without a "use client" of its own.
 */

// tone → design tokens, mirroring StalenessBadge's BAND_STYLE exactly (no
// project-wide `--danger` token exists — the danger fallback literal matches
// StalenessBadge's, rather than inventing a new one).
const TONE_STYLE: Record<"ok" | "warn" | "danger", { bg: string; fg: string }> = {
  ok: { bg: "transparent", fg: "var(--fg-subtle)" },
  warn: { bg: "var(--warn-bg)", fg: "var(--warn)" },
  danger: { bg: "var(--danger-bg, rgba(239,68,68,0.14))", fg: "var(--danger, #ef4444)" },
};

export function ExtractionQualityBadge({
  quality,
  testId = "extraction-quality",
}: {
  quality: ExtractionQuality | null;
  testId?: string;
}) {
  if (quality === null) return null;

  const display = gradeDisplay(quality.grade);
  const style = TONE_STYLE[display.tone];
  return (
    <span
      data-testid={testId}
      data-extraction-grade={quality.grade}
      data-extraction-populated={quality.populated_fields}
      data-extraction-total={quality.total_fields}
      title={`${display.title} (${quality.populated_fields}/${quality.total_fields} campos)`}
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
      {display.label}
    </span>
  );
}
