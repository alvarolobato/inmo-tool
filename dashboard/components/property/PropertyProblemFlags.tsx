import type { ProblemFlag } from "@/lib/property-detail";

/**
 * Property-problem section for the detail page (#361).
 *
 * Surfaces the problems the latest `redflags` assessment found — legal,
 * financial, or physical (unfinished/halted construction, structural damage).
 * Each problem is a warn-tone badge with the model's own one-line description
 * and the literal advert quote it cited, so the owner can verify it
 * independently before making an offer (never presented as a confirmed fact —
 * the redflags flow's whole discipline is "worth checking", see
 * lib/ai-assessment/redflags.ts).
 *
 * Deliberately its own component and section, separate from where #360 adds
 * the advert description to the same page.tsx — keeps the two parallel changes
 * from colliding (issue #361 coordination note).
 *
 * Renders NOTHING when there are no flags: an absent block is the correct
 * "nothing to report" state, not a placeholder (same rule as
 * ExtractionQualityBadge / StalenessBadge).
 *
 * Pure/presentational (no hooks) — drops into the page's render tree without a
 * "use client" of its own.
 */
export function PropertyProblemFlags({
  flags,
  testId = "property-problem-flags",
}: {
  flags: ProblemFlag[];
  testId?: string;
}) {
  if (flags.length === 0) return null;

  return (
    <section
      data-testid={testId}
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: "var(--fg)" }}>
        Problemas a comprobar
      </h2>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
        {flags.map((f) => (
          <li
            key={f.type}
            data-testid="property-problem-flag"
            data-flag-type={f.type}
            style={{ display: "flex", flexDirection: "column", gap: 4 }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span
                style={{
                  fontSize: 11,
                  lineHeight: "16px",
                  padding: "1px 6px",
                  borderRadius: 3,
                  fontWeight: 600,
                  background: "var(--danger-bg, rgba(239,68,68,0.14))",
                  color: "var(--danger, #ef4444)",
                  whiteSpace: "nowrap",
                }}
              >
                {f.label}
              </span>
              {f.description !== "" && (
                <span style={{ fontSize: 13, color: "var(--fg)" }}>{f.description}</span>
              )}
            </div>
            <p style={{ margin: 0, fontSize: 12, color: "var(--fg-muted)", fontStyle: "italic" }}>
              «{f.evidence}»{f.evidence_source !== null ? ` — ${f.evidence_source}` : ""}
            </p>
          </li>
        ))}
      </ul>
      <p style={{ margin: 0, fontSize: 11, color: "var(--fg-subtle)" }}>
        Detectado por IA a partir del anuncio. Verifícalo de forma independiente antes de ofertar.
      </p>
    </section>
  );
}
