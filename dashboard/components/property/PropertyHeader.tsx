import type { PropertyDetail } from "@/lib/property-detail";
import { PROPERTY_TYPE_LABELS, type PROPERTY_TYPES } from "@/lib/profiles-schema";
import { fmtEUR0, fmtInt } from "@/components/widgets/format";
import { StalenessBadge } from "@/components/StalenessBadge";
import { ExtractionQualityBadge } from "@/components/property/ExtractionQualityBadge";
import { PriceSignals } from "@/components/property/PriceSignals";
import { freshestActiveLastSeen } from "@/lib/staleness";
import { bestExtractionQuality } from "@/lib/extraction-quality";

// A spread this small between two portals' listed prices is routine rounding
// (e.g. 249.000€ vs 250.000€), not a genuine disagreement worth flagging.
const PRICE_DISAGREEMENT_THRESHOLD = 0.025;

/**
 * Header for the property detail page (task 2.8, #44): full normalized
 * fields. Price is the min current_price across active listings — same
 * convention as the candidate list/map (task 2.4/2.5). Falls back to the min
 * price across ALL listings (labelled as a last-known/historical price, not
 * a current one) when no listing is active — e.g. a fully sold/withdrawn
 * property still has real prices worth showing, just not as "the" price.
 * "Disagreement" is a relative-spread threshold, not exact equality, so
 * routine portal-to-portal rounding doesn't flag on every multi-listing
 * property.
 */
export function PropertyHeader({ property }: { property: PropertyDetail }) {
  const typeLabel =
    property.property_type !== null && property.property_type in PROPERTY_TYPE_LABELS
      ? PROPERTY_TYPE_LABELS[property.property_type as (typeof PROPERTY_TYPES)[number]]
      : property.property_type;

  const activePrices = property.listings
    .filter((l) => l.status === "active" && l.current_price !== null)
    .map((l) => l.current_price as number);
  const allPrices = property.listings
    .filter((l) => l.current_price !== null)
    .map((l) => l.current_price as number);

  const isHistorical = activePrices.length === 0 && allPrices.length > 0;
  const pricesUsed = activePrices.length > 0 ? activePrices : allPrices;
  const minPrice = pricesUsed.length > 0 ? Math.min(...pricesUsed) : null;
  const maxPrice = pricesUsed.length > 0 ? Math.max(...pricesUsed) : null;
  const pricesDisagree =
    minPrice !== null && maxPrice !== null && minPrice > 0
      ? (maxPrice - minPrice) / minPrice > PRICE_DISAGREEMENT_THRESHOLD
      : false;

  // Listing staleness (#243): freshest last_seen_at across ACTIVE listings —
  // the property is only as stale as its most-recently-re-confirmed live
  // listing. Active-only, mirroring lib/candidates.ts's card query, so a
  // withdrawn/sold sibling's frozen timestamp neither rescues nor is mistaken
  // for a live re-confirmation. Null (badge renders nothing) when nothing is
  // active — a fully withdrawn/sold property's story is told by the linked-
  // listings statuses and the status-event timeline, not by a staleness age.
  const freshestLastSeen = freshestActiveLastSeen(property.listings);

  // Best extraction-quality grade across this property's listings (#80). A
  // deduped property shows the COALESCE-union of every source's fields, so
  // it's only as under-extracted as its best source — bestExtractionQuality
  // reflects that. Null (badge renders nothing) until at least one listing
  // has been scored, i.e. fetched since the feature shipped.
  const extractionQuality = bestExtractionQuality(
    property.listings.map((l) => l.extraction_quality),
  );

  const facts: [string, string | null][] = [
    ["Tipo", typeLabel ?? null],
    ["Superficie construida", property.m2_built !== null ? `${fmtInt(property.m2_built)} m²` : null],
    ["Superficie útil", property.m2_useful !== null ? `${fmtInt(property.m2_useful)} m²` : null],
    ["Habitaciones", property.rooms !== null ? String(property.rooms) : null],
    ["Baños", property.bathrooms !== null ? String(property.bathrooms) : null],
    ["Planta", property.floor ?? null],
    [
      "Ascensor",
      property.has_elevator === null ? null : property.has_elevator ? "Sí" : "No",
    ],
    ["Año de construcción", property.year_built !== null ? String(property.year_built) : null],
    ["Calificación energética", property.energy_rating ?? null],
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "var(--fg)" }}>
            {minPrice !== null ? fmtEUR0(minPrice) : "Precio no disponible"}
          </h1>
          {/* #448 F: below-market rating (green/red) + price up/down, next to the price. */}
          <PriceSignals
            belowMarketPct={property.below_market_pct}
            priceChanged={property.price_changed}
            priceDirection={property.price_direction}
            priceDeltaPct={property.price_delta_pct}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {/* Extraction-quality grade (#80) — "genuinely thin listing" vs
              "our connector under-extracted this one". Absent until a listing
              has been scored. */}
          <ExtractionQualityBadge quality={extractionQuality} testId="property-extraction-quality" />
          {/* Staleness of the freshest active listing (#243) — a fact ("visto
              hace N días"), not a "sold" inference. Absent when no listing is
              active. */}
          <StalenessBadge lastSeenAt={freshestLastSeen} testId="property-staleness" />
        </div>
      </div>

      {isHistorical && minPrice !== null && (
        <p style={{ margin: 0, fontSize: 12, color: "var(--fg-muted)", fontStyle: "italic" }}>
          Último precio conocido — ningún anuncio vinculado está activo actualmente.
        </p>
      )}

      {pricesDisagree && (
        <p style={{ margin: 0, fontSize: 12, color: "var(--fg-muted)", fontStyle: "italic" }}>
          Los anuncios vinculados muestran precios significativamente distintos — se indica el más bajo
          {isHistorical ? "" : " entre anuncios activos"}.
        </p>
      )}

      <p style={{ margin: 0, fontSize: 14, color: "var(--fg)" }}>
        {property.address ?? "Dirección no disponible"}
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
          gap: 8,
          marginTop: 8,
        }}
      >
        {facts
          .filter(([, value]) => value !== null)
          .map(([label, value]) => (
            <div key={label}>
              <p style={{ margin: 0, fontSize: 11, color: "var(--fg-muted)" }}>{label}</p>
              <p style={{ margin: 0, fontSize: 13, color: "var(--fg)" }}>{value}</p>
            </div>
          ))}
      </div>
    </div>
  );
}
