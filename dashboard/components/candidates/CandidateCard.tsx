import type { CandidateRow } from "@/lib/candidates";
import { PROPERTY_TYPE_LABELS, type PROPERTY_TYPES } from "@/lib/profiles-schema";
import { fmtEUR0, fmtInt } from "@/components/widgets/format";

/**
 * One card per deduplicated property (issue #19) — never one per listing.
 * Multiple linked `listing` rows (post task-2.2 dedup) render as multiple
 * source badges on a single card, e.g. "Fotocasa + Milanuncios".
 *
 * No click-through to a property detail page yet: task 2.8 (property detail
 * page) doesn't exist in this stack yet, so the card is intentionally
 * non-interactive for now rather than linking to a route that would 404.
 * Wire up navigation once #44 lands.
 */
export function CandidateCard({ candidate }: { candidate: CandidateRow }) {
  const sources = [...new Set(candidate.listings.map((l) => l.source))].sort();
  const typeLabel =
    candidate.property_type !== null &&
    candidate.property_type in PROPERTY_TYPE_LABELS
      ? PROPERTY_TYPE_LABELS[candidate.property_type as (typeof PROPERTY_TYPES)[number]]
      : candidate.property_type;

  const firstSeen =
    candidate.first_seen_at !== null
      ? new Date(candidate.first_seen_at).toLocaleDateString("es-ES", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        })
      : null;

  return (
    <div
      style={{
        padding: 14,
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg-1)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--fg)" }}>
          {candidate.min_price !== null ? fmtEUR0(candidate.min_price) : "Precio no disponible"}
        </p>
        <div style={{ display: "flex", gap: 4 }}>
          {sources.map((s) => (
            <span
              key={s}
              style={{
                fontSize: 11,
                padding: "2px 6px",
                borderRadius: 4,
                background: "var(--bg-2)",
                color: "var(--fg-muted)",
                textTransform: "capitalize",
              }}
            >
              {s}
            </span>
          ))}
        </div>
      </div>

      <p style={{ margin: 0, fontSize: 13, color: "var(--fg)" }}>
        {candidate.address ?? "Dirección no disponible"}
      </p>

      <p style={{ margin: 0, fontSize: 12, color: "var(--fg-muted)" }}>
        {typeLabel ?? "Tipo no disponible"}
        {candidate.m2_built !== null ? ` · ${fmtInt(candidate.m2_built)} m²` : ""}
        {candidate.rooms !== null ? ` · ${candidate.rooms} hab.` : ""}
      </p>

      {firstSeen !== null && (
        <p style={{ margin: 0, fontSize: 11, color: "var(--fg-subtle)" }}>Visto por primera vez: {firstSeen}</p>
      )}
    </div>
  );
}
