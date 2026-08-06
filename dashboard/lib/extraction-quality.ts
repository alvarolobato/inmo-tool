/**
 * Per-listing extraction-quality — the presentation/aggregation side of
 * issue #80's completeness signal.
 *
 * The ETL writes a weighted completeness descriptor onto each listing's
 * `raw_extra.extraction_quality` at normalize/persist time
 * (etl/extraction_quality.py). It tells "our connector under-extracted this
 * one" apart from "the source genuinely never published these fields" — a
 * distinction that is otherwise invisible, since a NULL column looks
 * identical either way.
 *
 * This module only *reads and aggregates* the stored value — it never
 * recomputes it (the ETL is the single source of truth for the grade, so
 * the dashboard can't drift from it). Dependency-free (no `pg`, no React) so
 * both the server data module (lib/property-detail.ts) and the client badge
 * component can use it, and it's cheap to unit-test — same discipline as
 * lib/staleness.ts.
 */

export type ExtractionGrade = "A" | "B" | "C" | "F";

export interface ExtractionQuality {
  grade: ExtractionGrade;
  /** Weighted populated-fraction, 0..1. */
  score: number;
  populated_fields: number;
  total_fields: number;
  /** Rubric version the ETL scored under (etl/extraction_quality.py). */
  weights_version: number;
}

/**
 * Narrow an untyped JSON value (as it arrives from `raw_extra` over the wire)
 * into an ExtractionQuality, or null if it's absent/malformed. Tolerant by
 * design: a row that predates the feature (no descriptor yet — it self-heals
 * on the listing's next fetch) simply yields null and renders no badge,
 * rather than throwing.
 */
export function parseExtractionQuality(value: unknown): ExtractionQuality | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const grade = v.grade;
  if (grade !== "A" && grade !== "B" && grade !== "C" && grade !== "F") return null;
  if (typeof v.score !== "number") return null;
  return {
    grade,
    score: v.score,
    populated_fields: typeof v.populated_fields === "number" ? v.populated_fields : 0,
    total_fields: typeof v.total_fields === "number" ? v.total_fields : 0,
    weights_version: typeof v.weights_version === "number" ? v.weights_version : 0,
  };
}

/**
 * The best (highest-score) extraction quality across a property's listings —
 * or null if none carry one yet.
 *
 * "Best", not "worst" or "average": a deduplicated property's header shows
 * the COALESCE-merged union of every source's fields (lib/property-detail.ts),
 * so the property is only as under-extracted as its *best* source. If one
 * portal gave us a rich extraction, the header's fields are trustworthy even
 * if a sibling listing was thin — flagging the property as low-quality in
 * that case would mislead. The badge exists to catch the case where *every*
 * source we have came back thin.
 */
export function bestExtractionQuality(
  qualities: (ExtractionQuality | null | undefined)[],
): ExtractionQuality | null {
  let best: ExtractionQuality | null = null;
  for (const q of qualities) {
    // `== null` (not `===`) so a listing object that simply omits the field
    // — undefined at runtime — is skipped too, not just an explicit null.
    if (q == null) continue;
    if (best === null || q.score > best.score) best = q;
  }
  return best;
}

interface GradeDisplay {
  /** Short Spanish label for the badge face. */
  label: string;
  /** Longer tooltip explaining what the grade means. */
  title: string;
  /** Visual escalation tone (maps to design tokens in the badge component). */
  tone: "ok" | "warn" | "danger";
}

// A/B are quiet-positive (the extraction was rich — nothing to flag); C/F
// escalate, because those are exactly the "did our parser miss this?" cases
// the owner needs to notice. The tone→token mapping lives in the badge
// component, mirroring StalenessBadge's BAND_STYLE.
const GRADE_DISPLAY: Record<ExtractionGrade, GradeDisplay> = {
  A: {
    label: "Datos completos",
    title:
      "Extracción completa: casi todos los campos clave (precio, tamaño, ubicación, habitaciones…) se capturaron para este inmueble.",
    tone: "ok",
  },
  B: {
    label: "Datos buenos",
    title:
      "Extracción buena: la mayoría de los campos clave se capturaron; faltan algunos secundarios.",
    tone: "ok",
  },
  C: {
    label: "Datos parciales",
    title:
      "Extracción parcial: faltan varios campos clave. Puede que el anuncio no los publique, o que nuestro conector no los extrajera esta vez.",
    tone: "warn",
  },
  F: {
    label: "Datos escasos",
    title:
      "Extracción escasa: faltan casi todos los campos clave. Revisa el anuncio original antes de descartarlo — puede ser un anuncio pobre, o una extracción fallida.",
    tone: "danger",
  },
};

export function gradeDisplay(grade: ExtractionGrade): GradeDisplay {
  return GRADE_DISPLAY[grade];
}
