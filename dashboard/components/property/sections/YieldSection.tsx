/**
 * Investment metrics section (task 5.3, #33; order 40 in DetailSections —
 * see components/property/DetailSections.tsx's reserved-order-values list).
 * Ties together issue #151 (acquisition costs + rent honesty), #32 (area
 * price-per-m²), and #33 (yield/cash-on-cash).
 *
 * Every figure this renders is labelled as an estimate (issue #33 EC-3,
 * issue #1 §11/§16 — decision support, never underwriting-grade
 * precision): "estimado"/"asunción" badges are not decorative, they are
 * the load-bearing distinction between a measurement and an assumption
 * issue #151's honesty constraint requires a user be able to see just by
 * looking at the UI.
 */

import type { InvestmentMetrics } from "@/lib/investment-metrics";
import type { RentConfidence } from "@/lib/analytics/rent-estimate";
import { fmtEUR0, fmtPct, fmtInt } from "@/components/widgets/format";

const badgeStyle: React.CSSProperties = {
  fontSize: 10,
  lineHeight: "14px",
  padding: "1px 6px",
  borderRadius: 3,
  fontWeight: 600,
  background: "var(--bg-2)",
  color: "var(--fg-muted)",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: 8,
  padding: "4px 0",
  borderBottom: "1px solid var(--border)",
  fontSize: 13,
};

/**
 * `"high"` reads as a solid/confident treatment; every other confidence
 * (`"low"`, `"assumption"`, and — defensively — `null`, which shouldn't
 * reach this component but must never crash it) reads as visibly muted.
 * This is the single place that decision is made (issue #33 EC-4) so a
 * future confidence tier added to RentConfidence gets the conservative
 * (muted) default automatically rather than silently rendering as if it
 * were high-confidence.
 */
function confidenceTreatment(confidence: RentConfidence): { label: string; muted: boolean } {
  switch (confidence) {
    case "high":
      return { label: "Alta confianza (comparables)", muted: false };
    case "low":
      return { label: "Confianza baja (pocos comparables)", muted: true };
    case "assumption":
      return { label: "Asunción manual del perfil", muted: true };
    default:
      return { label: "Sin datos suficientes", muted: true };
  }
}

function EstimateBadge() {
  return <span style={badgeStyle} data-testid="estimate-badge">estimado</span>;
}

function AreaPriceBlock({ metrics }: { metrics: InvestmentMetrics }) {
  const areaPrice = metrics.area_price;
  if (areaPrice === null) {
    return (
      <p style={{ fontSize: 12, color: "var(--fg-subtle)", margin: "4px 0" }}>
        Sin coordenadas suficientes para comparar con la zona.
      </p>
    );
  }
  if (areaPrice.area_avg_price_per_m2 === null) {
    return (
      <p data-testid="area-price-insufficient" style={{ fontSize: 12, color: "var(--fg-subtle)", margin: "4px 0" }}>
        Comparables insuficientes en la zona ({fmtInt(areaPrice.sample_size)}
        {areaPrice.sample_size === 1 ? " propiedad" : " propiedades"}) — no se muestra comparación.
      </p>
    );
  }
  const pct = areaPrice.pct_vs_average;
  return (
    <div data-testid="area-price-comparison">
      <div style={rowStyle}>
        <span style={{ color: "var(--fg-muted)" }}>Precio/m² de esta propiedad</span>
        <span style={{ color: "var(--fg)" }}>
          {areaPrice.property_price_per_m2 !== null ? `${fmtEUR0(areaPrice.property_price_per_m2)}/m²` : "—"}
        </span>
      </div>
      <div style={rowStyle}>
        <span style={{ color: "var(--fg-muted)" }}>
          Mediana de la zona ({fmtInt(areaPrice.sample_size)} comparables)
        </span>
        <span style={{ color: "var(--fg)" }}>{fmtEUR0(areaPrice.area_avg_price_per_m2)}/m²</span>
      </div>
      {pct !== null && (
        <p
          data-testid="area-price-delta"
          style={{
            fontSize: 12,
            margin: "4px 0 0",
            color: pct < 0 ? "var(--down, #7fce9b)" : "var(--fg-muted)",
          }}
        >
          {pct < 0
            ? `${fmtPct(Math.abs(pct))} por debajo de la media de la zona`
            : `${fmtPct(pct)} por encima de la media de la zona`}
        </p>
      )}
    </div>
  );
}

export function YieldSection({ metrics }: { metrics: InvestmentMetrics }) {
  const { rent_estimate: rent, yield: yieldResult } = metrics;

  if (rent.method === "no_rent_assumption" || yieldResult.assumptions_used === null) {
    return (
      <div data-testid="yield-empty-state">
        <AreaPriceBlock metrics={metrics} />
        <p style={{ fontSize: 12, color: "var(--fg-subtle)", margin: "8px 0 0" }}>
          Sin estimación de alquiler: este perfil no tiene definida una asunción de alquiler
          (€/m²/mes). Añádela en la configuración del perfil para ver el yield estimado — inmo-tool
          no inventa una cifra de alquiler sin que la indiques (issue #151).
        </p>
      </div>
    );
  }

  const { muted, label: confidenceLabel } = confidenceTreatment(rent.confidence);
  const assumptions = yieldResult.assumptions_used;
  const acquisition = assumptions.acquisition_costs;

  return (
    <div data-testid="yield-section-content" style={{ opacity: muted ? 0.85 : 1 }}>
      <AreaPriceBlock metrics={metrics} />

      <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 6 }}>
        <span
          data-testid="rent-confidence-badge"
          data-confidence={rent.confidence ?? "none"}
          data-muted={muted}
          style={{
            ...badgeStyle,
            background: muted ? "var(--bg-2)" : "var(--accent-bg, #1d3a4a)",
            color: muted ? "var(--fg-subtle)" : "var(--accent, #7fd0ff)",
            border: muted ? "1px dashed var(--border)" : "none",
          }}
        >
          {confidenceLabel}
        </span>
      </div>

      <div style={rowStyle}>
        <span style={{ color: "var(--fg-muted)" }}>
          Alquiler estimado ({fmtEUR0(rent.eur_per_m2_month_used ?? 0)}/m²/mes × {fmtInt(rent.m2_used ?? 0)} m²)
        </span>
        <span data-testid="estimated-rent" style={{ color: "var(--fg)" }}>
          {fmtEUR0(rent.estimated_monthly_rent!)}/mes <EstimateBadge />
        </span>
      </div>

      <div style={rowStyle}>
        <span style={{ color: "var(--fg-muted)" }}>Yield bruto</span>
        <span data-testid="gross-yield" style={{ color: "var(--fg)" }}>
          {fmtPct(yieldResult.gross_yield_pct! / 100)} <EstimateBadge />
        </span>
      </div>
      <div style={rowStyle}>
        <span style={{ color: "var(--fg-muted)" }}>
          Yield neto ({assumptions.carrying_costs_source === "actual" ? "IBI/comunidad reales" : `${fmtInt(assumptions.operating_cost_pct)}% asumido`})
        </span>
        <span data-testid="net-yield" style={{ color: "var(--fg)" }}>
          {fmtPct(yieldResult.net_yield_pct! / 100)} <EstimateBadge />
        </span>
      </div>
      <div style={rowStyle}>
        <span style={{ color: "var(--fg-muted)" }}>Cash-on-cash</span>
        <span data-testid="cash-on-cash" style={{ color: "var(--fg)" }}>
          {fmtPct(yieldResult.cash_on_cash_pct! / 100)} <EstimateBadge />
        </span>
      </div>

      <details style={{ marginTop: 10 }} data-testid="assumptions-detail">
        <summary style={{ fontSize: 12, color: "var(--fg-subtle)", cursor: "pointer" }}>
          Ver desglose de costes y financiación
        </summary>
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--fg-muted)", display: "flex", flexDirection: "column", gap: 2 }}>
          <span>
            ITP ({acquisition.comunidad_autonoma ?? "región no reconocida, tipo nacional por defecto"}
            {acquisition.itp_is_override ? ", ajustado manualmente" : ""}): {fmtPct(acquisition.itp_pct / 100)} ={" "}
            {fmtEUR0(acquisition.itp_eur)}
          </span>
          <span>
            Notaría ({fmtPct(acquisition.notary_pct / 100)}): {fmtEUR0(acquisition.notary_eur)}
          </span>
          <span>
            Registro ({fmtPct(acquisition.registry_pct / 100)}): {fmtEUR0(acquisition.registry_eur)}
          </span>
          <span>Gestoría: {fmtEUR0(acquisition.gestoria_eur)}</span>
          <span data-testid="acquisition-total">
            Total gastos de adquisición: {fmtEUR0(acquisition.total_eur)} ({fmtPct(acquisition.total_pct_of_price)})
          </span>
          <span style={{ marginTop: 4 }}>
            Financiación: {fmtInt(assumptions.down_payment_pct)}% entrada, {assumptions.rate_pct}% interés,{" "}
            {assumptions.term_years} años
            {assumptions.financing_is_default ? " (valores por defecto del sistema)" : ""}
          </span>
          {!acquisition.province_recognized && (
            <span style={{ color: "var(--danger, #ff9b9b)" }}>
              Región no reconocida a partir de la provincia — se usó el tipo de ITP nacional por defecto,
              no el de una comunidad autónoma concreta.
            </span>
          )}
        </div>
      </details>
    </div>
  );
}
