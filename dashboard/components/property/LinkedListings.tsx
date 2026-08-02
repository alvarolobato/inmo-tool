import type { PropertyListingDetail } from "@/lib/property-detail";
import { fmtEUR0 } from "@/components/widgets/format";

export const STATUS_LABELS: Record<string, string> = {
  active: "Activo",
  reserved: "Reservado",
  sold: "Vendido",
  withdrawn: "Retirado",
  expired: "Caducado",
};

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
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "8px 10px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-1)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
            {l.current_price !== null && (
              <span style={{ fontSize: 12, color: "var(--fg-muted)" }}>{fmtEUR0(l.current_price)}</span>
            )}
          </div>
          {l.url !== null && (
            <a
              href={l.url}
              target="_blank"
              rel="noopener noreferrer"
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
