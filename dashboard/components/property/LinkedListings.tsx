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
              basis-0 wrap trap doesn't apply and this needs no media query:
              it wraps only when it doesn't fit, which never happens at
              >=768px with real content. */}
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
