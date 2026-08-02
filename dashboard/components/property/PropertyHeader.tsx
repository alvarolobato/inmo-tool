import type { PropertyDetail } from "@/lib/property-detail";
import { PROPERTY_TYPE_LABELS, type PROPERTY_TYPES } from "@/lib/profiles-schema";
import { fmtEUR0, fmtInt } from "@/components/widgets/format";

/**
 * Header for the property detail page (task 2.8, #44): full normalized
 * fields. Price is the min current_price across active listings — same
 * convention as the candidate list/map (task 2.4/2.5) — noted explicitly
 * when listings disagree on price, since that's an expected state (not a
 * bug) once a property has 2+ linked listings from different sites.
 */
export function PropertyHeader({ property }: { property: PropertyDetail }) {
  const typeLabel =
    property.property_type !== null && property.property_type in PROPERTY_TYPE_LABELS
      ? PROPERTY_TYPE_LABELS[property.property_type as (typeof PROPERTY_TYPES)[number]]
      : property.property_type;

  const activePrices = property.listings
    .filter((l) => l.status === "active" && l.current_price !== null)
    .map((l) => l.current_price as number);
  const minPrice = activePrices.length > 0 ? Math.min(...activePrices) : null;
  const pricesDisagree = new Set(activePrices).size > 1;

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
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "var(--fg)" }}>
          {minPrice !== null ? fmtEUR0(minPrice) : "Precio no disponible"}
        </h1>
      </div>

      {pricesDisagree && (
        <p style={{ margin: 0, fontSize: 12, color: "var(--fg-muted)", fontStyle: "italic" }}>
          Los anuncios vinculados muestran precios distintos — se indica el más bajo entre anuncios activos.
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
