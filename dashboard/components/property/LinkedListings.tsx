import type { PropertyListingDetail } from "@/lib/property-detail";
import { fmtEUR0 } from "@/components/widgets/format";
import { STATUS_LABELS } from "@/lib/listing-status-labels";

const LISTING_KIND_LABELS: Record<string, string> = {
  particular: "Particular",
  agency: "Agencia",
};

function formatSeenDate(iso: string | null): string | null {
  if (iso === null) return null;
  return new Date(iso).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });
}

/**
 * Every `listing` row linked to this property (task 2.8, #44, EC-1/EC-3):
 * shows each source's own status independently — e.g. Idealista `active`
 * while Fotocasa is `withdrawn` on the same underlying property is a real,
 * expected post-dedup state, not a bug. Renders correctly with exactly one
 * item for a not-yet-deduplicated property (EC-3).
 */
export function LinkedListings({ listings }: { listings: PropertyListingDetail[] }) {
  return (
    <div data-testid="linked-listings" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {listings.map((l) => (
        <div
          key={l.id}
          data-testid="linked-listing-item"
          data-source={l.source}
          data-status={l.status}
          data-operation={l.operation}
          className="linked-listing-row"
          style={{
            display: "flex",
            // Pushes the link to the far right in desktop's ROW layout
            // (>=768px, `.linked-listing-row`'s default) — load-bearing
            // there, so it stays inline rather than being deleted: removing
            // it would leave the link sitting immediately after the field
            // group instead of at the row's far edge, a real desktop
            // regression. It becomes a genuine no-op only once
            // `.linked-listing-row`'s mobile override switches this to a
            // COLUMN (<768px) — main-axis distribution over an
            // intrinsic-height column has nothing to distribute.
            justifyContent: "space-between",
            gap: 12,
            padding: "8px 10px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-1)",
          }}
        >
          {/* #584: flexWrap so each field wraps onto its own line-fragment at
              phone width instead of every span shrinking internally into
              mid-token shards. Children keep their natural (content) flex
              basis — no `flex: 1` anywhere in this group — so D-124's
              basis-0 wrap trap doesn't apply. Deliberately no media query:
              it wraps whenever the row's available width can't fit every
              field on one line, which is NOT phone-only — measured on this
              fixture, the 768-950px band wraps too (taller rows, every
              field whole) where main sheared the same fields across two
              lines. That's strictly better than main in that band, not a
              regression the "desktop pixel-identical" constraint (>=768px,
              single-row geometry unchanged) is scoped to prevent — this
              constraint is about not making desktop WORSE, and a taller,
              legible row is an improvement main never had. */}
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <span
              style={{
                fontSize: 11,
                padding: "2px 6px",
                borderRadius: 4,
                background: "var(--bg-2)",
                color: "var(--fg-muted)",
                textTransform: "capitalize",
              }}
            >
              {l.source}
            </span>
            <span style={{ fontSize: 12, color: "var(--fg)" }}>
              {STATUS_LABELS[l.status] ?? l.status}
            </span>
            {l.listing_kind !== null && (
              <span style={{ fontSize: 12, color: "var(--fg-muted)" }}>
                {LISTING_KIND_LABELS[l.listing_kind] ?? l.listing_kind}
              </span>
            )}
            {/* operation badge + "/mes" suffix (issue #31 Opus-review "Also
                fix"): this list has no operation filter — a rental listing
                renders here unlabeled, right next to sale listings, and
                without this a monthly rent figure reads exactly like a
                sale price with no way to tell them apart. */}
            {l.operation === "rent" && (
              <span
                data-testid="listing-operation-badge"
                style={{
                  fontSize: 10,
                  lineHeight: "14px",
                  padding: "1px 6px",
                  borderRadius: 3,
                  fontWeight: 600,
                  background: "var(--bg-2)",
                  color: "var(--fg-muted)",
                }}
              >
                Alquiler
              </span>
            )}
            {l.current_price !== null && (
              <span style={{ fontSize: 12, color: "var(--fg-muted)" }}>
                {fmtEUR0(l.current_price)}
                {l.operation === "rent" ? "/mes" : ""}
              </span>
            )}
            {/* Seller/agency reference (#72). Monospace because it's an opaque
                identifier the user cross-references against the source portal
                by eye — proportional digits make transcription errors easy. */}
            {l.reference_code !== null && (
              <span
                data-testid="listing-reference-code"
                title="Referencia del anunciante"
                style={{
                  fontSize: 11,
                  fontFamily: "var(--font-mono, ui-monospace, monospace)",
                  color: "var(--fg-muted)",
                }}
              >
                Ref. {l.reference_code}
              </span>
            )}
            {formatSeenDate(l.first_seen_at) !== null && (
              <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>
                Visto desde {formatSeenDate(l.first_seen_at)}
              </span>
            )}
            {formatSeenDate(l.last_seen_at) !== null && l.last_seen_at !== l.first_seen_at && (
              <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>
                · última vez {formatSeenDate(l.last_seen_at)}
              </span>
            )}
          </div>
          {l.url !== null && (
            <a
              href={l.url}
              target="_blank"
              rel="noopener noreferrer"
              className="linked-listing-link"
              style={{ fontSize: 12, color: "var(--accent)" }}
            >
              Ver anuncio original →
            </a>
          )}
        </div>
      ))}
    </div>
  );
}
