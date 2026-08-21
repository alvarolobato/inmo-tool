"use client";

/**
 * CandidateFilterBar (#465, Feed UX F2) — the candidate feed's filter controls,
 * reorganized from 11 flat controls across 2-3 rows into one compact sticky row
 * plus a progressive-disclosure popover.
 *
 * Purely presentational: it takes the current filter `values` and an `onChange`
 * that emits the next `CandidateFilters`. All state (and its URL round-trip)
 * lives in the parent `CandidateList`, which keeps the fetch logic. Every
 * filter's vocabulary/semantics is preserved bit-for-bit from the old flat bar
 * (D-059 filter⇔rank invariant); this component only changes their layout and
 * where the state comes from.
 *
 * Layout:
 *   Row 1 (sticky): segmented [Todas | En seguimiento ③ | Con descartadas]
 *     + Fuente + Bajo mercado + (Fase-3 "⚠ Con alertas" placeholder slot)
 *     + "Más filtros (n)" popover + "Limpiar todo".
 *   Chips row: one `Etiqueta: valor ✕` per non-default filter (✕ clears it), so
 *     nothing active is ever hidden inside the popover.
 */

import { useEffect, useRef, useState } from "react";
import { Popover, PopoverButton, PopoverPanel } from "@headlessui/react";
import {
  DEFAULT_CANDIDATE_FILTERS,
  hasActiveFilters,
  moreFiltersActiveCount,
  type CandidateFilters,
  type CandidateView,
} from "@/lib/candidate-filters";

interface Opt {
  value: string;
  label: string;
}

// Option vocabularies — the single source for both the <select> options and the
// active-chip labels, so a chip always reads the same words as the control.
const OCCUPANCY_OPTS: Opt[] = [
  { value: "", label: "Cualquiera" },
  { value: "occupied", label: "Ocupado" },
  { value: "free", label: "Libre" },
];
const CONDITION_OPTS: Opt[] = [
  { value: "", label: "Cualquiera" },
  { value: "a_reformar", label: "A reformar" },
  { value: "a_reformar:leve", label: "A reformar (leve)" },
  { value: "a_reformar:integral", label: "A reformar (integral)" },
  { value: "reformado", label: "Reformado" },
  { value: "obra_nueva", label: "Obra nueva" },
];
const DISCOUNT_OPTS: Opt[] = [
  { value: "", label: "Cualquiera" },
  { value: "10", label: "≥ 10%" },
  { value: "15", label: "≥ 15%" },
  { value: "20", label: "≥ 20%" },
  { value: "25", label: "≥ 25%" },
];
const CAVEAT_OPTS: Opt[] = [
  { value: "", label: "Cualquiera" },
  { value: "venta_deuda", label: "Venta de deuda" },
  { value: "nuda_propiedad", label: "Nuda propiedad" },
  { value: "usufructo", label: "Usufructo" },
  { value: "proindiviso", label: "Proindiviso" },
  { value: "derecho_superficie", label: "Derecho de superficie" },
];
const REDFLAG_OPTS: Opt[] = [
  { value: "", label: "Cualquiera" },
  { value: "unfinished_construction", label: "Obra inacabada" },
  { value: "embargo", label: "Embargo" },
  { value: "subasta_judicial", label: "Subasta judicial" },
  { value: "litigio", label: "Litigio" },
  { value: "construccion_ilegal", label: "Construcción ilegal" },
  { value: "herencia_yacente", label: "Herencia yacente" },
  { value: "deuda_comunidad", label: "Deuda comunidad" },
  { value: "sin_financiacion_hipotecaria", label: "Sin financiación hipotecaria" },
  { value: "cambio_uso_pendiente", label: "Cambio de uso pendiente" },
  { value: "structural_damage", label: "Daño estructural" },
];
const BEACH_OPTS: Opt[] = [
  { value: "", label: "Cualquiera" },
  { value: "frontline", label: "Primera línea" },
  { value: "sea_view", label: "Vistas al mar o mejor" },
  { value: "near_beach", label: "Cerca de playa o mejor" },
];
const VPO_OPTS: Opt[] = [
  { value: "", label: "Cualquiera" },
  { value: "true", label: "Solo VPO" },
  { value: "false", label: "Sin VPO" },
];

function labelOf(opts: Opt[], value: string): string {
  return opts.find((o) => o.value === value)?.label ?? value;
}

const selectStyle: React.CSSProperties = {
  padding: "5px 8px",
  fontSize: 13,
  color: "var(--fg)",
  background: "var(--bg-1)",
  border: "1px solid var(--border)",
  borderRadius: 6,
};

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--fg-muted)",
};

function CountBadge({
  count,
  testId,
  title,
}: {
  count: number;
  testId?: string;
  title?: string;
}) {
  return (
    <span
      data-testid={testId}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 16,
        height: 16,
        padding: "0 5px",
        borderRadius: 8,
        fontSize: 10,
        lineHeight: "16px",
        fontWeight: 600,
        color: "var(--up-fg, #fff)",
        background: "var(--up, #16a34a)",
      }}
    >
      {count}
    </span>
  );
}

function SegmentButton({
  active,
  onClick,
  testId,
  children,
}: {
  active: boolean;
  onClick: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 10px",
        fontSize: 13,
        border: "none",
        borderRadius: 6,
        cursor: "pointer",
        color: active ? "#fff" : "var(--fg-muted)",
        background: active ? "var(--accent)" : "transparent",
        fontWeight: active ? 600 : 400,
      }}
    >
      {children}
    </button>
  );
}

interface ActiveChip {
  key: string;
  label: string;
  clear: () => void;
}

export function CandidateFilterBar({
  values,
  onChange,
  availableSources,
  seguimientoAlertCount,
}: {
  values: CandidateFilters;
  onChange: (next: CandidateFilters) => void;
  availableSources: string[];
  seguimientoAlertCount: number;
}) {
  const set = <K extends keyof CandidateFilters>(
    key: K,
    value: CandidateFilters[K],
  ) => onChange({ ...values, [key]: value });

  const setView = (view: CandidateView) => set("view", view);

  // #470 free-text search box (primary row). The input is debounced so typing
  // doesn't fire a feed refetch per keystroke: local `qText` tracks the field,
  // and the trimmed term is pushed into the shared filter state (which the
  // parent mirrors to the URL and refetches from) 350 ms after the last
  // keystroke — or immediately on Enter / ✕. Refs hold the latest `onChange`
  // and `values` so the debounced emit never clobbers a filter that changed
  // meanwhile and the timer effect stays keyed only on the typed text.
  const [qText, setQText] = useState(values.q);
  const qTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const valuesRef = useRef(values);
  valuesRef.current = values;

  // External changes to `q` (chip ✕, "Limpiar todo", deep-load) flow back into
  // the input; a no-op when the user's own debounced commit is what changed it.
  useEffect(() => {
    setQText(values.q);
  }, [values.q]);

  // Clear a pending debounce on unmount.
  useEffect(
    () => () => {
      if (qTimer.current) clearTimeout(qTimer.current);
    },
    [],
  );

  const emitQ = (raw: string) => {
    if (qTimer.current) clearTimeout(qTimer.current);
    const trimmed = raw.trim();
    if (trimmed === valuesRef.current.q) return;
    onChangeRef.current({ ...valuesRef.current, q: trimmed });
  };

  const onQInput = (raw: string) => {
    setQText(raw);
    if (qTimer.current) clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => emitQ(raw), 350);
  };

  const clearQ = () => {
    setQText("");
    emitQ("");
  };

  const moreCount = moreFiltersActiveCount(values);
  const anyActive = hasActiveFilters(values);

  // One chip per non-default filter (except `view`, which is always visible as
  // the segmented control). Each ✕ resets exactly that filter to its default.
  const chips: ActiveChip[] = [];
  if (values.q !== "")
    chips.push({
      key: "q",
      label: `Búsqueda: «${values.q}»`,
      clear: clearQ,
    });
  if (values.source !== null)
    chips.push({
      key: "source",
      label: `Fuente: ${values.source}`,
      clear: () => set("source", null),
    });
  if (values.occupancy !== "")
    chips.push({
      key: "occupancy",
      label: `Ocupación: ${labelOf(OCCUPANCY_OPTS, values.occupancy)}`,
      clear: () => set("occupancy", ""),
    });
  if (values.conditionSel !== "")
    chips.push({
      key: "cond",
      label: `Estado: ${labelOf(CONDITION_OPTS, values.conditionSel)}`,
      clear: () => set("conditionSel", ""),
    });
  if (values.minDiscount !== "")
    chips.push({
      key: "minDiscount",
      label: `Bajo mercado: ${labelOf(DISCOUNT_OPTS, values.minDiscount)}`,
      clear: () => set("minDiscount", ""),
    });
  if (values.caveat !== "")
    chips.push({
      key: "caveat",
      label: `Situación jurídica: ${labelOf(CAVEAT_OPTS, values.caveat)}`,
      clear: () => set("caveat", ""),
    });
  if (values.redflagType !== "")
    chips.push({
      key: "redflag",
      label: `Alerta: ${labelOf(REDFLAG_OPTS, values.redflagType)}`,
      clear: () => set("redflagType", ""),
    });
  if (values.beachProximity !== "")
    chips.push({
      key: "beach",
      label: `Playa: ${labelOf(BEACH_OPTS, values.beachProximity)}`,
      clear: () => set("beachProximity", ""),
    });
  if (values.heritageZone)
    chips.push({
      key: "heritage",
      label: "Casco histórico",
      clear: () => set("heritageZone", false),
    });
  if (values.isVpo !== "")
    chips.push({
      key: "vpo",
      label: `VPO: ${labelOf(VPO_OPTS, values.isVpo)}`,
      clear: () => set("isVpo", ""),
    });
  // #593 tri-state — one chip for whichever of the two active states is on.
  // "Sin alertas" is deliberately NOT worded "verificado limpio": it excludes
  // properties the AI hasn't assessed yet (see the segmented control below),
  // so the chip must not read as a completeness guarantee.
  if (values.alerts === "1")
    chips.push({
      key: "alerts",
      label: "Con alertas",
      clear: () => set("alerts", ""),
    });
  if (values.alerts === "0")
    chips.push({
      key: "alerts",
      label: "Sin alertas (evaluadas)",
      clear: () => set("alerts", ""),
    });
  // Issue #667: "Ver novedades" landed here via the per-profile row button (or
  // a deep link). One chip so the filter is visibly active and clearable
  // without back-navigation — same pattern as every other primary-row filter.
  if (values.onlyNew)
    chips.push({
      key: "onlyNew",
      label: "Solo nuevos",
      clear: () => set("onlyNew", false),
    });

  return (
    <div data-testid="candidate-filter-bar">
      {/* Row 1 — compact, sticky within the scrolling <main>. */}
      <div
        data-testid="candidate-filter-row-primary"
        style={{
          position: "sticky",
          top: 0,
          zIndex: 5,
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          marginTop: 16,
          padding: "8px 0",
          background: "var(--bg)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        {/* Segmented control: the 3 reachable states of the two (mutually
            exclusive) presets — Todas / En seguimiento / Con descartadas. */}
        <div
          role="group"
          aria-label="Vista del feed"
          style={{
            display: "inline-flex",
            gap: 2,
            padding: 2,
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg-1)",
          }}
        >
          <SegmentButton
            active={values.view === "all"}
            onClick={() => setView("all")}
            testId="view-segment-todas"
          >
            Todas
          </SegmentButton>
          <SegmentButton
            active={values.view === "seguimiento"}
            onClick={() => setView("seguimiento")}
            testId="view-segment-seguimiento"
          >
            En seguimiento
            {seguimientoAlertCount > 0 && (
              <CountBadge
                count={seguimientoAlertCount}
                testId="seguimiento-alert-count"
                title={`${seguimientoAlertCount} en seguimiento con bajada reciente`}
              />
            )}
          </SegmentButton>
          <SegmentButton
            active={values.view === "descartadas"}
            onClick={() => setView("descartadas")}
            testId="view-segment-descartadas"
          >
            Con descartadas
          </SegmentButton>
        </div>

        {/* #470 free-text search — always-visible primary-row control. Debounced
            (350 ms) so it doesn't refetch per keystroke; Enter commits at once,
            ✕ clears. Feeds the `q` filter (address + description + AI labels). */}
        <div
          data-testid="search-box"
          style={{
            position: "relative",
            display: "inline-flex",
            alignItems: "center",
            flex: "1 1 180px",
            minWidth: 150,
            maxWidth: 320,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              left: 8,
              fontSize: 13,
              color: "var(--fg-muted)",
              pointerEvents: "none",
            }}
          >
            🔍
          </span>
          <input
            type="search"
            data-testid="search-input"
            value={qText}
            placeholder="Buscar en anuncios…"
            aria-label="Buscar en anuncios y todos los campos"
            onChange={(e) => onQInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                emitQ(qText);
              }
            }}
            style={{
              width: "100%",
              padding: "5px 26px 5px 28px",
              fontSize: 13,
              color: "var(--fg)",
              background: "var(--bg-1)",
              border: "1px solid var(--border)",
              borderRadius: 6,
            }}
          />
          {qText !== "" && (
            <button
              type="button"
              data-testid="search-clear"
              aria-label="Limpiar búsqueda"
              onClick={clearQ}
              style={{
                position: "absolute",
                right: 6,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 16,
                height: 16,
                padding: 0,
                border: "none",
                borderRadius: 999,
                background: "transparent",
                color: "var(--fg-muted)",
                cursor: "pointer",
                fontSize: 12,
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          )}
        </div>

        {/* #265 source (portal) — hidden only when the profile has no sources. */}
        {availableSources.length > 0 && (
          <>
            <label htmlFor="candidate-source-filter" style={fieldLabelStyle}>
              Fuente
            </label>
            <select
              id="candidate-source-filter"
              data-testid="source-filter"
              value={values.source ?? ""}
              onChange={(e) =>
                set("source", e.target.value === "" ? null : e.target.value)
              }
              style={{ ...selectStyle, textTransform: "capitalize" }}
            >
              <option value="">Todas las fuentes</option>
              {availableSources.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </>
        )}

        {/* #310 below-market discount — works today (computed from price). */}
        <label htmlFor="candidate-discount-filter" style={fieldLabelStyle}>
          Bajo mercado
        </label>
        <select
          id="candidate-discount-filter"
          data-testid="discount-filter"
          value={values.minDiscount}
          onChange={(e) => set("minDiscount", e.target.value)}
          style={selectStyle}
        >
          {DISCOUNT_OPTS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        {/* #593 tri-state alerts filter (was #466's single boolean toggle):
            off → "⚠ Con alertas" → "✓ Sin alertas" → off. A segmented control
            rather than a cycling chip — the issue's own concern was that a
            2-of-3 cycling toggle isn't obvious at a glance ("not a checkbox
            that is sometimes half-lit"); 3 buttons where exactly one is always
            highlighted reads unambiguously in either state. "Sin alertas" is
            the TRUE COMPLEMENT of "Con alertas" over the SAME predicate (see
            lib/candidates.ts) — but a property the AI hasn't assessed yet has
            neither an alert NOR evidence of being clean, so it is EXCLUDED
            from both (consistent with D-059: an unassessed axis is excluded
            from a hard filter, never a false "verified clean"). The title
            attribute on the full label says so explicitly rather than letting
            "sin alertas" imply a completeness guarantee it doesn't have.

            Review #597: at 390px this control alone took the sticky primary
            row from 5 wrapped rows to 6 (109px → 272px) with the full labels
            always rendered. Below `md:` each button shows only the icon plus
            a short word (`md:hidden`/`hidden md:inline`, D-120); the full
            label returns at `md:` and up, where the row has room. */}
        <div
          role="group"
          aria-label="Filtro de alertas"
          style={{
            display: "inline-flex",
            gap: 2,
            padding: 2,
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg-1)",
          }}
        >
          <SegmentButton
            active={values.alerts === ""}
            onClick={() => set("alerts", "")}
            testId="alerts-segment-off"
          >
            Todas
          </SegmentButton>
          <SegmentButton
            active={values.alerts === "1"}
            onClick={() => set("alerts", "1")}
            testId="alerts-segment-with"
          >
            <span className="md:hidden">⚠ Con</span>
            <span
              className="hidden md:inline"
              title="Propiedades con ≥1 alerta roja o de ocupación detectada"
            >
              ⚠ Con alertas
            </span>
          </SegmentButton>
          <SegmentButton
            active={values.alerts === "0"}
            onClick={() => set("alerts", "0")}
            testId="alerts-segment-without"
          >
            <span className="md:hidden">✓ Sin</span>
            <span
              className="hidden md:inline"
              title="Propiedades evaluadas sin alertas — no incluye las que aún no se han evaluado"
            >
              ✓ Sin alertas
            </span>
          </SegmentButton>
        </div>

        {/* "Más filtros (n)" — the 7 AI-gated filters behind progressive
            disclosure. Headless UI Popover (already a dependency). */}
        <Popover style={{ position: "relative" }}>
          <PopoverButton
            data-testid="more-filters-button"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 10px",
              fontSize: 13,
              color: "var(--fg)",
              background: "var(--bg-1)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            Más filtros
            {moreCount > 0 && (
              <CountBadge count={moreCount} testId="more-filters-count" />
            )}
          </PopoverButton>
          <PopoverPanel
            data-testid="more-filters-panel"
            anchor={{ to: "bottom end", gap: 6 }}
            style={{
              zIndex: 30,
              width: "min(300px, 92vw)",
              maxWidth: "92vw",
              // Never taller than the viewport (mobile) — scroll internally
              // instead of spilling below the fold. Floating UI (via `anchor`)
              // also caps this against the available space.
              maxHeight: "min(70vh, var(--anchor-max-height, 70vh))",
              overflow: "auto",
              padding: 14,
              display: "flex",
              flexDirection: "column",
              gap: 14,
              background: "var(--bg-2)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
            }}
          >
            <PopoverGroup title="Situación">
              <PopoverSelect
                id="candidate-occupancy-filter"
                testId="occupancy-filter"
                label="Ocupación"
                value={values.occupancy}
                opts={OCCUPANCY_OPTS}
                onChange={(v) => set("occupancy", v)}
              />
              <PopoverSelect
                id="candidate-caveat-filter"
                testId="caveat-filter"
                label="Situación jurídica"
                value={values.caveat}
                opts={CAVEAT_OPTS}
                onChange={(v) => set("caveat", v)}
              />
              <PopoverSelect
                id="candidate-redflag-filter"
                testId="redflag-filter"
                label="Tipo de alerta"
                value={values.redflagType}
                opts={REDFLAG_OPTS}
                onChange={(v) => set("redflagType", v)}
              />
            </PopoverGroup>

            <PopoverGroup title="Estado">
              <PopoverSelect
                id="candidate-condition-filter"
                testId="condition-filter"
                label="Estado"
                value={values.conditionSel}
                opts={CONDITION_OPTS}
                onChange={(v) => set("conditionSel", v)}
              />
            </PopoverGroup>

            <PopoverGroup title="Ubicación">
              <PopoverSelect
                id="candidate-beach-filter"
                testId="beach-filter"
                label="Playa"
                value={values.beachProximity}
                opts={BEACH_OPTS}
                onChange={(v) => set("beachProximity", v)}
              />
              <label
                htmlFor="candidate-heritage-toggle"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  color: "var(--fg-muted)",
                  cursor: "pointer",
                }}
              >
                <input
                  id="candidate-heritage-toggle"
                  data-testid="heritage-filter"
                  type="checkbox"
                  checked={values.heritageZone}
                  onChange={(e) => set("heritageZone", e.target.checked)}
                  style={{ cursor: "pointer" }}
                />
                Casco histórico
              </label>
            </PopoverGroup>

            <PopoverGroup title="Régimen">
              <PopoverSelect
                id="candidate-vpo-filter"
                testId="vpo-filter"
                label="VPO"
                value={values.isVpo}
                opts={VPO_OPTS}
                onChange={(v) => set("isVpo", v)}
              />
            </PopoverGroup>

            <p
              style={{
                margin: 0,
                fontSize: 11,
                color: "var(--fg-subtle)",
                lineHeight: 1.4,
              }}
            >
              Estos filtros usan datos de evaluación IA.
            </p>
          </PopoverPanel>
        </Popover>

        {/* Always rendered so the bar layout never shifts when filters come and
            go (the owner reported the screen "jumping"). When nothing is active
            it stays visible but disabled/muted rather than being removed. */}
        <button
          type="button"
          data-testid="clear-all-filters"
          disabled={!anyActive}
          aria-disabled={!anyActive}
          onClick={() => onChange({ ...DEFAULT_CANDIDATE_FILTERS })}
          style={{
            marginLeft: "auto",
            padding: "5px 10px",
            fontSize: 13,
            color: anyActive ? "var(--fg-muted)" : "var(--fg-subtle)",
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: 6,
            cursor: anyActive ? "pointer" : "not-allowed",
            opacity: anyActive ? 1 : 0.5,
          }}
        >
          Limpiar todo
        </button>
      </div>

      {/* Active-filter chips: nothing active is ever invisible in the popover. */}
      {chips.length > 0 && (
        <div
          data-testid="active-filter-chips"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginTop: 10,
            flexWrap: "nowrap",
            overflowX: "auto",
          }}
        >
          {chips.map((chip) => (
            <span
              key={chip.key}
              data-testid={`filter-chip-${chip.key}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "3px 4px 3px 10px",
                fontSize: 12,
                whiteSpace: "nowrap",
                color: "var(--fg)",
                background: "var(--bg-1)",
                border: "1px solid var(--border)",
                borderRadius: 999,
              }}
            >
              {chip.label}
              <button
                type="button"
                aria-label={`Quitar filtro ${chip.label}`}
                data-testid={`filter-chip-clear-${chip.key}`}
                onClick={chip.clear}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 18,
                  height: 18,
                  border: "none",
                  borderRadius: 999,
                  background: "transparent",
                  color: "var(--fg-muted)",
                  cursor: "pointer",
                  fontSize: 13,
                  lineHeight: 1,
                }}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function PopoverGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p
        style={{
          margin: 0,
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          color: "var(--fg-subtle)",
        }}
      >
        {title}
      </p>
      {children}
    </div>
  );
}

function PopoverSelect({
  id,
  testId,
  label,
  value,
  opts,
  onChange,
}: {
  id: string;
  testId: string;
  label: string;
  value: string;
  opts: Opt[];
  onChange: (value: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
      }}
    >
      <label htmlFor={id} style={fieldLabelStyle}>
        {label}
      </label>
      <select
        id={id}
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...selectStyle, flex: "0 0 auto", maxWidth: 190 }}
      >
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
