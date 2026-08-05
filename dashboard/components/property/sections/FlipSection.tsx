/**
 * Buy-to-flip metrics section (issue #45; order 45 in DetailSections — between
 * the rental yield block (40) and notes (50)). Renders renovation cost, ARV,
 * and flip margin for a flip-thesis profile, plus a side-by-side comparison
 * against the buy-to-rent yield so the architect-investor can pick the play.
 *
 * This section only ever mounts when `metrics.flip !== null`, i.e. the
 * profile's `thesis_params.thesis_type === "flip"` (issue #45 EC-3 — gated,
 * not shown universally). Every figure is explicitly framed as a rough,
 * directional estimate, never a quote (EC-4 / issue #1 §11). Missing inputs
 * (no condition assessment, too few comps) degrade to a clean "sin estimación"
 * line rather than a crash or a fabricated number (issue #45 graceful
 * degradation).
 */

import type { InvestmentMetrics } from "@/lib/investment-metrics";
import type { FlipMetrics } from "@/lib/analytics/flip-margin";
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

const basisStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--fg-subtle)",
  margin: "2px 0 0",
};

function EstimateBadge() {
  return (
    <span style={badgeStyle} data-testid="flip-estimate-badge">
      estimado
    </span>
  );
}

function RefurbBlock({ renovation }: { renovation: FlipMetrics["renovation"] }) {
  return (
    <div data-testid="flip-refurb-cost" data-tier={renovation.tier}>
      <div style={rowStyle}>
        <span style={{ color: "var(--fg-muted)" }}>Coste de reforma estimado</span>
        <span style={{ color: "var(--fg)" }}>
          {renovation.total_eur !== null ? (
            <>
              {fmtEUR0(renovation.total_eur)} <EstimateBadge />
            </>
          ) : (
            <span style={{ color: "var(--fg-subtle)" }}>sin estimación</span>
          )}
        </span>
      </div>
      <p style={basisStyle}>{renovation.basis}</p>
    </div>
  );
}

function ArvBlock({ arv }: { arv: FlipMetrics["arv"] }) {
  return (
    <div data-testid="flip-arv" data-confidence={arv.confidence ?? "none"}>
      <div style={rowStyle}>
        <span style={{ color: "var(--fg-muted)" }}>
          Valor tras reforma (ARV)
          {arv.confidence !== null && (
            <span
              data-testid="flip-arv-confidence"
              style={{ ...badgeStyle, marginLeft: 6 }}
            >
              {arv.confidence === "high" ? "confianza alta" : "confianza baja"}
            </span>
          )}
        </span>
        <span style={{ color: "var(--fg)" }}>
          {arv.arv_eur !== null ? (
            <>
              {fmtEUR0(arv.arv_eur)} <EstimateBadge />
            </>
          ) : (
            <span style={{ color: "var(--fg-subtle)" }}>sin estimación</span>
          )}
        </span>
      </div>
      <p style={basisStyle}>{arv.basis}</p>
    </div>
  );
}

/**
 * The margin breakdown — ARV, purchase price, refurb, and buffer each on their
 * own visible line (issue #45 EC-2: "not just a final margin figure"), then the
 * margin itself. When any input is missing, shows the clean degraded state.
 */
function MarginBlock({ margin }: { margin: FlipMetrics["margin"] }) {
  if (!margin.computable) {
    return (
      <div data-testid="flip-margin" data-computable="false">
        <p data-testid="flip-margin-none" style={{ fontSize: 12, color: "var(--fg-subtle)", margin: "6px 0 0" }}>
          Sin margen de flip estimable todavía: {margin.basis}
        </p>
      </div>
    );
  }

  const positive = (margin.margin_eur ?? 0) >= 0;

  return (
    <div data-testid="flip-margin" data-computable="true">
      <div style={rowStyle}>
        <span style={{ color: "var(--fg-muted)" }}>Valor tras reforma (ARV)</span>
        <span data-testid="flip-margin-arv" style={{ color: "var(--fg)" }}>
          {fmtEUR0(margin.arv_eur!)}
        </span>
      </div>
      <div style={rowStyle}>
        <span style={{ color: "var(--fg-muted)" }}>− Precio de compra</span>
        <span data-testid="flip-margin-price" style={{ color: "var(--fg)" }}>
          −{fmtEUR0(margin.purchase_price!)}
        </span>
      </div>
      <div style={rowStyle}>
        <span style={{ color: "var(--fg-muted)" }}>− Coste de reforma</span>
        <span data-testid="flip-margin-refurb" style={{ color: "var(--fg)" }}>
          −{fmtEUR0(margin.refurb_cost_eur!)}
        </span>
      </div>
      <div style={rowStyle}>
        <span style={{ color: "var(--fg-muted)" }}>
          − Gastos de transacción y tenencia ({fmtInt(margin.transaction_buffer_pct)}% del precio)
        </span>
        <span data-testid="flip-margin-buffer" style={{ color: "var(--fg)" }}>
          −{fmtEUR0(margin.transaction_buffer_eur!)}
        </span>
      </div>
      <div style={{ ...rowStyle, borderBottom: "none", marginTop: 2 }}>
        <span style={{ color: "var(--fg)", fontWeight: 600 }}>Margen de flip estimado</span>
        <span
          data-testid="flip-margin-total"
          style={{ color: positive ? "var(--up, #7fce9b)" : "var(--danger, #ff9b9b)", fontWeight: 600 }}
        >
          {fmtEUR0(margin.margin_eur!)}
          {margin.margin_pct !== null && <> ({fmtPct(margin.margin_pct)})</>} <EstimateBadge />
        </span>
      </div>
      <p style={basisStyle}>{margin.basis}</p>
    </div>
  );
}

/**
 * Buy-to-flip vs. buy-to-rent, side by side (issue #45): the net rental yield
 * already computed for this property, shown next to the flip margin so the
 * persona can compare the two plays. Reuses `metrics.yield` — no recompute.
 */
function VsRentBlock({ metrics }: { metrics: InvestmentMetrics }) {
  const y = metrics.yield;
  const hasYield = y.assumptions_used !== null && y.net_yield_pct !== null;
  return (
    <div data-testid="flip-vs-rent" style={{ marginTop: 10 }}>
      <div style={rowStyle}>
        <span style={{ color: "var(--fg-muted)" }}>Alternativa en alquiler (yield neto anual)</span>
        <span data-testid="flip-vs-rent-yield" style={{ color: "var(--fg)" }}>
          {hasYield ? (
            <>
              {fmtPct(y.net_yield_pct! / 100)} <EstimateBadge />
            </>
          ) : (
            <span style={{ color: "var(--fg-subtle)" }}>sin estimación de alquiler</span>
          )}
        </span>
      </div>
      <p style={basisStyle}>
        El flip es una ganancia puntual a la reventa; el alquiler es un rendimiento anual recurrente. No
        son directamente comparables — se muestran juntos para elegir la estrategia, no para sumarlos.
      </p>
    </div>
  );
}

export function FlipSection({ metrics }: { metrics: InvestmentMetrics }) {
  const flip = metrics.flip;
  if (flip === null) return null;

  return (
    <div data-testid="flip-section-content">
      <p
        data-testid="flip-disclaimer"
        style={{ fontSize: 12, color: "var(--fg-subtle)", margin: "0 0 8px" }}
      >
        Estimación aproximada y orientativa para apoyar la decisión — NO es una tasación ni un
        presupuesto de obra. Los importes se basan en bandas de coste configurables y en la mediana de
        precios de la zona.
      </p>

      <RefurbBlock renovation={flip.renovation} />
      <ArvBlock arv={flip.arv} />

      <h3 style={{ fontSize: 13, fontWeight: 600, color: "var(--fg)", margin: "12px 0 2px" }}>
        Margen de flip
      </h3>
      <MarginBlock margin={flip.margin} />

      <VsRentBlock metrics={metrics} />
    </div>
  );
}
