import Link from "next/link";
import type { CandidateRow } from "@/lib/candidates";
import { PROPERTY_TYPE_LABELS, type PROPERTY_TYPES } from "@/lib/profiles-schema";
import { fmtEUR0, fmtInt } from "@/components/widgets/format";
import { COLD_START_EXPLANATION } from "@/lib/scoring/cold-start";
import { FeedbackControls } from "./FeedbackControls";

/**
 * One card per deduplicated property (issue #19) — never one per listing.
 * Multiple linked `listing` rows (post task-2.2 dedup) render as multiple
 * source badges on a single card, e.g. "Fotocasa + Milanuncios".
 *
 * Photo-first layout (#152): the image is the strongest triage signal, so it
 * leads, with price overlaid on it and the numeric facts a user actually
 * scans (zone, planta, hab., baños, m²) on one compact line beneath.
 *
 * The informational content links to the property detail page (task 2.8,
 * #44); FeedbackControls (task 3.1, #20) is a *sibling* of that <Link>, not
 * nested inside it — see that component's docstring for why. #152 moved it
 * to an absolutely-positioned overlay so it costs no vertical space, but the
 * sibling relationship is load-bearing and must survive any future layout
 * change: there is an e2e assertion that clicking feedback does not navigate.
 */
/**
 * `floor` is free text as the sites publish it: "3", "1ª", "Bajo",
 * "Entreplanta", "Ático". Only a bare number reads correctly with the
 * "Planta" prefix — "Planta Bajo" does not, so anything non-numeric is shown
 * as-is.
 */
function floorLabel(floor: string): string {
  const trimmed = floor.trim();
  return /^\d+$/.test(trimmed) ? `Planta ${trimmed}` : trimmed;
}

export function CandidateCard({ candidate, profileId }: { candidate: CandidateRow; profileId: number }) {
  const sources = [...new Set(candidate.listings.map((l) => l.source))].sort();
  const typeLabel =
    candidate.property_type !== null &&
    candidate.property_type in PROPERTY_TYPE_LABELS
      ? PROPERTY_TYPE_LABELS[candidate.property_type as (typeof PROPERTY_TYPES)[number]]
      : candidate.property_type;

  // Compact fact line: only what's known, so a sparse property doesn't render
  // a row of "no disponible" placeholders competing with the real values.
  const facts: string[] = [];
  if (typeLabel) facts.push(typeLabel);
  if (candidate.m2_built !== null) facts.push(`${fmtInt(candidate.m2_built)} m²`);
  if (candidate.rooms !== null) facts.push(`${candidate.rooms} hab.`);
  if (candidate.bathrooms !== null)
    facts.push(`${candidate.bathrooms} ${candidate.bathrooms === 1 ? "baño" : "baños"}`);
  if (candidate.floor !== null && candidate.floor.trim() !== "") facts.push(floorLabel(candidate.floor));

  // The cold-start explanation is identical on every candidate in the
  // profile, so repeating it per card was pure noise (#152) — CandidateList
  // renders it once as a page-level footer instead. A *real*, model-grounded
  // explanation differs per property and stays on the card.
  const explanation =
    candidate.rank_explanation !== null && candidate.rank_explanation !== COLD_START_EXPLANATION
      ? candidate.rank_explanation
      : null;

  return (
    <div
      data-testid="candidate-card"
      data-property-id={candidate.property_id}
      className="candidate-card"
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg-1)",
        display: "flex",
        flexDirection: "column",
        // Anchors the absolutely-positioned action overlay below.
        position: "relative",
        overflow: "hidden",
      }}
    >
      <Link
        href={`/profiles/${profileId}/properties/${candidate.property_id}`}
        style={{
          display: "flex",
          flexDirection: "column",
          textDecoration: "none",
          color: "inherit",
        }}
      >
        <div
          data-testid="candidate-photo"
          style={{
            position: "relative",
            width: "100%",
            aspectRatio: "4 / 3",
            background: "var(--bg-2)",
          }}
        >
          {candidate.thumbnail_url !== null ? (
            /* eslint-disable-next-line @next/next/no-img-element -- external, unpredictable-domain photo URLs from scraped listings; next/image's domain allowlist isn't a good fit here. */
            <img
              src={candidate.thumbnail_url}
              data-testid="candidate-photo-img"
              // Decorative: the address, price and facts beside it already
              // carry every fact a screen-reader user needs, and scraped
              // listings give us no meaningful alt text to use.
              alt=""
              loading="lazy"
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
          ) : (
            <div
              data-testid="candidate-photo-placeholder"
              style={{
                width: "100%",
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                color: "var(--fg-subtle)",
              }}
            >
              Sin foto
            </div>
          )}

          <p
            data-testid="candidate-price"
            style={{
              position: "absolute",
              left: 0,
              bottom: 0,
              margin: 0,
              padding: "10px 10px 6px",
              width: "100%",
              fontSize: 17,
              fontWeight: 700,
              color: "#fff",
              background: "linear-gradient(to top, rgba(0,0,0,0.72), rgba(0,0,0,0))",
            }}
          >
            {candidate.min_price !== null ? fmtEUR0(candidate.min_price) : "Precio no disponible"}
          </p>
        </div>

        <div style={{ padding: "8px 10px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
          <p
            data-testid="candidate-zone"
            style={{
              margin: 0,
              fontSize: 13,
              fontWeight: 500,
              color: "var(--fg)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={candidate.address ?? undefined}
          >
            {candidate.address ?? "Dirección no disponible"}
          </p>

          <p data-testid="candidate-facts" style={{ margin: 0, fontSize: 12, color: "var(--fg-muted)" }}>
            {facts.length > 0 ? facts.join(" · ") : "Sin datos estructurados"}
          </p>

          {(candidate.flags.length > 0 || sources.length > 0) && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 }}>
              {candidate.flags.map((f) => (
                <span
                  key={f.kind}
                  data-testid="candidate-flag"
                  data-flag-kind={f.kind}
                  style={{
                    fontSize: 10,
                    lineHeight: "14px",
                    padding: "1px 5px",
                    borderRadius: 3,
                    fontWeight: 600,
                    background: f.tone === "warn" ? "var(--danger-bg, #4a1d1d)" : "var(--bg-2)",
                    color: f.tone === "warn" ? "var(--danger, #ff9b9b)" : "var(--fg-muted)",
                  }}
                >
                  {f.label}
                </span>
              ))}
              {sources.map((s) => (
                <span
                  key={s}
                  data-testid="candidate-source"
                  style={{
                    fontSize: 10,
                    lineHeight: "14px",
                    padding: "1px 5px",
                    borderRadius: 3,
                    background: "var(--bg-2)",
                    color: "var(--fg-subtle)",
                    textTransform: "capitalize",
                  }}
                >
                  {s}
                </span>
              ))}
            </div>
          )}

          {explanation !== null && (
            <p
              data-testid="rank-explanation"
              title={explanation}
              style={{
                margin: "2px 0 0",
                fontSize: 11,
                lineHeight: "15px",
                color: "var(--fg-subtle)",
                // Clamped so a long explanation can't stretch one card and
                // leave ragged holes across the grid; full text on hover.
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {explanation}
            </p>
          )}
        </div>
      </Link>

      {/*
        Sibling of the <Link>, never a child — a feedback click must not
        navigate. Overlaid on the photo so it reclaims the vertical space the
        old inline bar occupied (#150). Visibility is CSS-driven (see
        .candidate-card-actions in globals.css): revealed on hover where the
        device supports hover, always visible on touch, and always visible to
        keyboard users via :focus-within.
      */}
      <div className="candidate-card-actions" data-testid="candidate-card-actions">
        <FeedbackControls profileId={profileId} propertyId={candidate.property_id} compact />
      </div>
    </div>
  );
}
