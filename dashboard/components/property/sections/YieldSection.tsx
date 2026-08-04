/**
 * Investment metrics section (task 5.3, #33; order 40 in DetailSections —
 * see components/property/DetailSections.tsx's reserved-order-values list).
 * Ties together issue #151 (acquisition costs + rent honesty), #32 (area
 * price-per-m²), #33 (yield/cash-on-cash), and #31 (comparable-rental
 * estimation — replaces the assumption-only rent source PR #181 shipped).
 *
 * Every figure this renders is labelled as an estimate (issue #33 EC-3,
 * issue #1 §11/§16 — decision support, never underwriting-grade
 * precision): "estimado"/"asunción" badges are not decorative, they are
 * the load-bearing distinction between a measurement and an assumption
 * issue #151's honesty constraint requires a user be able to see just by
 * looking at the UI.
 *
 * Issue #31's precedence rule, made visible here (not just in
 * rent-estimate.ts's types): a profile's own assumption, when set, is
 * ALWAYS the figure yield is computed from — never silently replaced by a
 * measured comparable. But `rent.market_comparable` is rendered
 * alongside it whenever it exists, and `rent.disagreement_pct` is called
 * out explicitly when the two numbers disagree — "show both", not "pick
 * the one that looks more sophisticated".
 */

import type { InvestmentMetrics } from "@/lib/investment-metrics";
import type { RentConfidence } from "@/lib/analytics/rent-estimate";
import { fmtEUR0, fmtEUR2, fmtPct, fmtInt } from "@/components/widgets/format";

/**
 * Threshold above which a disagreement between the profile's assumption
 * and the measured market comparable is called out with a warning
 * treatment rather than a neutral one — 15%, a documented, tunable
 * judgment call (not derived from anything statistical): small
 * disagreements are expected and unremarkable (an assumption is a
 * judgment call, not meant to match a market median exactly), a
 * disagreement this large is worth a user's attention.
 */
const DISAGREEMENT_WARNING_THRESHOLD = 0.15;

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

/**
 * Describes precisely which carrying-cost inputs are real vs. assumed
 * (Opus review must-fix #7: `carrying_costs_source` alone is an OR — a
 * listing that publishes ONLY a community fee previously rendered as
 * "IBI/comunidad reales", silently implying IBI was known too, when it was
 * actually €0 by omission). Always names the maintenance/vacancy line as
 * an assumption, since no source publishes it (see yield.ts's
 * DEFAULT_MAINTENANCE_VACANCY_PCT docstring).
 */
function carryingCostsLabel(assumptions: NonNullable<InvestmentMetrics["yield"]["assumptions_used"]>): string {
  if (assumptions.carrying_costs_source === "assumed") {
    return `${fmtInt(assumptions.operating_cost_pct)}% asumido (IBI, comunidad, mantenimiento y vacío)`;
  }
  const known: string[] = [];
  if (assumptions.ibi_known) known.push("IBI real");
  if (assumptions.community_fee_known) known.push("comunidad real");
  const missing = !assumptions.ibi_known ? "IBI no publicado" : !assumptions.community_fee_known ? "comunidad no publicada" : null;
  const parts = [...known, ...(missing ? [missing] : []), `mantenimiento/vacío ${fmtInt(assumptions.maintenance_vacancy_pct)}% asumido`];
  return parts.join(" + ");
}

/** One "(por defecto)" suffix per financing field that the profile never actually set (Opus review: setting only down_payment_pct must not make rate_pct/term_years silently read as user-chosen). */
function financingFieldSuffix(isDefault: boolean): string {
  return isDefault ? " (por defecto)" : "";
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
  if (areaPrice.area_median_price_per_m2 === null) {
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
        <span style={{ color: "var(--fg)" }}>{fmtEUR0(areaPrice.area_median_price_per_m2)}/m²</span>
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
          {/* "mediana", never "media" (mean) — area_median_price_per_m2 IS a
              median (PERCENTILE_CONT(0.5), not AVG); the row above already
              says "Mediana de la zona", so this line must agree with it,
              not silently call the same figure "la media" a sentence
              later (Opus review: a real wording contradiction a user
              would notice). */}
          {pct < 0
            ? `${fmtPct(Math.abs(pct))} por debajo de la mediana de la zona`
            : `${fmtPct(pct)} por encima de la mediana de la zona`}
        </p>
      )}
    </div>
  );
}

/**
 * Renders the market-comparable figure alongside the primary estimate
 * whenever one was computed (issue #31's "show both" precedence rule) —
 * NOT only when it's the primary source. `market_comparable` is attached
 * even when a profile assumption wins, specifically so this can render
 * then too.
 */
function MarketComparableBlock({ rent }: { rent: InvestmentMetrics["rent_estimate"] }) {
  const market = rent.market_comparable;
  // Nothing to show at all (no_property_location) or the market estimate
  // IS already the primary figure (no separate "secondary" line needed —
  // the main row below already shows it).
  if (market === null || rent.method === "market_comparable_high" || rent.method === "market_comparable_low") {
    return null;
  }
  if (market.estimated_monthly_rent === null) {
    return (
      <p data-testid="market-comparable-insufficient" style={{ fontSize: 12, color: "var(--fg-subtle)", margin: "4px 0 0" }}>
        Comparables de alquiler insuficientes en la zona ({fmtInt(market.comparable_count)}
        {market.comparable_count === 1 ? " anuncio" : " anuncios"}) para contrastar la asunción del perfil.
      </p>
    );
  }

  const disagreement = rent.disagreement_pct;
  const isWarning = disagreement !== null && Math.abs(disagreement) >= DISAGREEMENT_WARNING_THRESHOLD;

  return (
    <p
      data-testid="market-comparable-comparison"
      data-disagreement-warning={isWarning}
      style={{ fontSize: 12, color: isWarning ? "var(--danger, #ff9b9b)" : "var(--fg-subtle)", margin: "4px 0 0" }}
    >
      Comparables de mercado ({fmtInt(market.comparable_count)} anuncios de alquiler,{" "}
      {market.confidence === "high" ? "alta confianza" : "confianza baja"}
      {market.oldest_comp_age_days !== null ? `, vistos hace hasta ${fmtInt(market.oldest_comp_age_days)} días` : ""}
      ): {fmtEUR2(market.eur_per_m2_month!)}
      /m²/mes → {fmtEUR0(market.estimated_monthly_rent)}/mes.{" "}
      {disagreement !== null &&
        (disagreement > 0
          ? `La asunción del perfil es ${fmtPct(Math.abs(disagreement))} más alta que el mercado.`
          : `La asunción del perfil es ${fmtPct(Math.abs(disagreement))} más baja que el mercado.`)}
    </p>
  );
}

export function YieldSection({ metrics }: { metrics: InvestmentMetrics }) {
  const { rent_estimate: rent, yield: yieldResult } = metrics;

  // Several DISTINCT empty states, not one collapsed bucket (Opus review
  // fix, extended by issue #31): a profile that already set a rent
  // assumption but whose property lacks m2_built must not be told to set
  // an assumption it already set; a property with no lat/lon/property_type
  // (can't even attempt a market query) must not be told "not enough
  // comparables" when the real problem is "we don't know where this is".
  // Checked FIRST and separately from every other branch — every gate
  // leaves `assumptions_used === null`, so a generic fallback checked
  // first would always win and these branches would never render.
  if (rent.method === "no_property_size") {
    return (
      <div data-testid="yield-empty-state-no-size">
        <AreaPriceBlock metrics={metrics} />
        <p style={{ fontSize: 12, color: "var(--fg-subtle)", margin: "8px 0 0" }}>
          Esta propiedad no tiene superficie construida (m²) registrada, así que no se puede estimar
          el alquiler (ni a partir de una asunción del perfil, ni de comparables de mercado — ambos
          necesitan multiplicar/dividir por los m² de esta propiedad concreta).
        </p>
      </div>
    );
  }
  if (rent.method === "no_property_location") {
    return (
      <div data-testid="yield-empty-state-no-location">
        <AreaPriceBlock metrics={metrics} />
        <p style={{ fontSize: 12, color: "var(--fg-subtle)", margin: "8px 0 0" }}>
          Este perfil no tiene una asunción de alquiler definida, y esta propiedad no tiene
          coordenadas o tipo de vivienda registrados, así que tampoco se pueden buscar comparables
          de alquiler en la zona.
        </p>
      </div>
    );
  }
  if (rent.method === "insufficient_data" || yieldResult.assumptions_used === null) {
    return (
      <div data-testid="yield-empty-state">
        <AreaPriceBlock metrics={metrics} />
        <p style={{ fontSize: 12, color: "var(--fg-subtle)", margin: "8px 0 0" }}>
          Sin estimación de alquiler: este perfil no tiene definida una asunción de alquiler
          (€/m²/mes), y no hay suficientes anuncios de alquiler comparables en la zona
          {rent.market_comparable
            ? ` (${fmtInt(rent.market_comparable.comparable_count)} ${rent.market_comparable.comparable_count === 1 ? "encontrado" : "encontrados"})`
            : ""}
          . Añade
          una asunción en la configuración del perfil, o espera a que se ingieran más comparables —
          inmo-tool no inventa una cifra de alquiler sin datos suficientes (issue #151/#31).
        </p>
      </div>
    );
  }

  const { muted, label: confidenceLabel } = confidenceTreatment(rent.confidence);
  const assumptions = yieldResult.assumptions_used;
  const acquisition = assumptions.acquisition_costs;
  const isMarketPrimary = rent.method === "market_comparable_high" || rent.method === "market_comparable_low";
  /**
   * Opus review must-fix #5 (PR #199): MarketComparableBlock renders null
   * exactly when the market estimate IS primary (see its own comment) —
   * before this fix, that was the ONE case where the sample size backing
   * the yield never appeared anywhere on the page ("(3 anuncios de
   * alquiler, confianza baja)" only ever showed up as a SECONDARY line,
   * next to a profile assumption). A yield derived from N rental ads must
   * say N on the page regardless of whether it's primary or secondary.
   */
  const primaryRentLabel = isMarketPrimary
    ? `Alquiler estimado (${fmtInt(rent.comparable_count)} comparables de mercado)`
    : "Alquiler estimado (asunción del perfil)";
  const primaryOldestAgeDays = isMarketPrimary ? rent.market_comparable?.oldest_comp_age_days ?? null : null;

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
          {/* fmtEUR2, not fmtEUR0 (Opus review fix): Spanish rents run
              7-15 EUR/m2/month, so rounding to whole euros distorts the
              displayed monthly total against the actual figure used
              underneath it (e.g. 12,5 rounding up to "13 EUR" implies
              1.040 EUR/mes next to an actual 1.000 EUR/mes) — this row
              exists specifically to make the assumption legible.
              Issue #31: the label itself now distinguishes an assumption
              from a measured comparable — same underlying row shape,
              different source. */}
          {primaryRentLabel} (
          {fmtEUR2(rent.eur_per_m2_month_used ?? 0)}/m²/mes × {fmtInt(rent.m2_used ?? 0)} m²)
        </span>
        <span data-testid="estimated-rent" style={{ color: "var(--fg)" }}>
          {fmtEUR0(rent.estimated_monthly_rent!)}/mes <EstimateBadge />
        </span>
      </div>
      {/* Recency (issue #31 Opus review must-fix #3): the comps' worst-case
          age, surfaced right where the primary figure they back is shown —
          see rent-estimate.ts's module docstring "Recency" section for
          exactly what this age does and doesn't guarantee (last_seen_at
          tracks presence, not price freshness). Only shown when the market
          estimate is primary — a profile assumption has no comp age. */}
      {isMarketPrimary && primaryOldestAgeDays !== null && (
        <p data-testid="market-comparable-age" style={{ fontSize: 11, color: "var(--fg-subtle)", margin: "2px 0 0" }}>
          Comparables vistos por última vez hace hasta {fmtInt(primaryOldestAgeDays)}{" "}
          {primaryOldestAgeDays === 1 ? "día" : "días"}.
        </p>
      )}

      <MarketComparableBlock rent={rent} />

      <div style={rowStyle}>
        <span style={{ color: "var(--fg-muted)" }}>Yield bruto (sobre precio de compra)</span>
        <span data-testid="gross-yield" style={{ color: "var(--fg)" }}>
          {fmtPct(yieldResult.gross_yield_pct! / 100)} <EstimateBadge />
        </span>
      </div>
      <div style={rowStyle}>
        <span style={{ color: "var(--fg-muted)" }}>
          Yield neto sobre precio de compra ({carryingCostsLabel(assumptions)})
        </span>
        <span data-testid="net-yield" style={{ color: "var(--fg)" }}>
          {fmtPct(yieldResult.net_yield_pct! / 100)} <EstimateBadge />
        </span>
      </div>
      <div style={rowStyle}>
        <span style={{ color: "var(--fg-muted)" }}>Cash-on-cash (sobre entrada + gastos de adquisición)</span>
        <span data-testid="cash-on-cash" style={{ color: "var(--fg)" }}>
          {fmtPct(yieldResult.cash_on_cash_pct! / 100)} <EstimateBadge />
        </span>
      </div>
      {/* Opus review must-fix #6: gross/net yield divide by purchase price
          alone (acquisition costs excluded — the standard rental-yield
          convention); only cash-on-cash includes them. Each row above now
          names its own denominator so a reader never has to guess which
          convention applies to which figure, especially right next to the
          assumptions-detail breakdown below, which shows the acquisition
          total in isolation. */}

      {/* Opus review must-fix #3: an unrecognized province must be visibly
          flagged where a user will actually see it, NOT only inside a
          <details> block that's collapsed by default (the original test
          for this only asserted DOM presence, not visibility — fixed
          alongside this). Rendered unconditionally in the main flow, right
          next to the figures it affects. */}
      {!acquisition.province_recognized && (
        <p data-testid="province-unrecognized-warning" style={{ fontSize: 12, color: "var(--danger, #ff9b9b)", margin: "8px 0 0" }}>
          Región no reconocida a partir de la provincia — se ha usado el tipo de ITP nacional por
          defecto ({fmtPct(acquisition.itp_pct / 100)}), no el de una comunidad autónoma concreta.
          Esto afecta a los gastos de adquisición y al cash-on-cash de esta propiedad.
        </p>
      )}

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
            Financiación: {fmtInt(assumptions.down_payment_pct)}% entrada{financingFieldSuffix(assumptions.down_payment_pct_is_default)},{" "}
            {assumptions.rate_pct}% interés{financingFieldSuffix(assumptions.rate_pct_is_default)},{" "}
            {assumptions.term_years} años{financingFieldSuffix(assumptions.term_years_is_default)}
          </span>
        </div>
      </details>
    </div>
  );
}
