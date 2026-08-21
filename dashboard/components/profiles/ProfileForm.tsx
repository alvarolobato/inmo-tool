"use client";

import { useEffect, useState } from "react";
import {
  PROPERTY_TYPES,
  PROPERTY_TYPE_LABELS,
  effectiveConnectors,
  type RadiusGeography,
  type Scope,
  type ThesisParams,
} from "@/lib/profiles-schema";
import { LocationPicker } from "./LocationPicker";
import { isRentalOnlyConnector, type ConnectorView } from "@/lib/connectors-schema";
import { isConnectorActive } from "@/lib/db/source-active";

export interface ProfileFormValues {
  name: string;
  scope: Scope;
  thesis_params: ThesisParams;
}

interface ProfileFormProps {
  initial?: ProfileFormValues;
  submitLabel: string;
  onSubmit: (values: ProfileFormValues) => Promise<void>;
  onCancel?: () => void;
}

// Exported so callers repairing a malformed-scope profile (issue #113) can
// seed the form with a valid scope skeleton — that profile's OLD scope is
// unparseable by definition, so there is nothing to pre-fill it with; the
// least-surprising starting point is the same default a brand-new profile
// gets, with just the (valid) existing name carried over.
export const DEFAULT_VALUES: ProfileFormValues = {
  name: "",
  scope: {
    geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 5 },
    property_types: ["piso"],
    // Issue #660: the form always writes `connectors` explicitly (never
    // relies on the schema's "absent means all" default) — "all" is the
    // stated starting point, same posture as property_types would be if it
    // had a sentinel default too.
    connectors: "all",
    hard_exclusions: {},
  },
  thesis_params: {},
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 500,
  color: "var(--fg-muted)",
};

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 4,
  padding: "7px 9px",
  background: "var(--bg-2)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--fg)",
  fontSize: 13,
  fontFamily: "inherit",
  boxSizing: "border-box",
};

const fieldsetStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 12,
  margin: 0,
};

const legendStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: "var(--fg-muted)",
  padding: "0 4px",
};

const rowStyle: React.CSSProperties = { display: "flex", gap: 12 };
const colStyle: React.CSSProperties = { flex: 1 };

/**
 * Scope + thesis_params editing form. Geography is radius-from-a-point
 * (issue #17 Technical approach #5) — a polygon map-drawing tool is a
 * reasonable later enhancement, not required here. Doubles as create (no
 * `initial`) and edit (`initial` set, submits a PATCH via the caller's
 * onSubmit) — see app/profiles/page.tsx.
 */
export function ProfileForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: ProfileFormProps) {
  const [values, setValues] = useState<ProfileFormValues>(
    initial ?? DEFAULT_VALUES,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Issue #659: the two "sin filtro" sentinels each need something to
  // restore when the owner unticks them — a plain toggle straight into
  // `values.scope` would otherwise throw away the radius/types they had
  // before flipping to "everywhere"/"all". Remembered here, updated
  // whenever the form holds a real (non-sentinel) value, so toggling back
  // and forth is lossless within one editing session.
  const [lastRadiusGeography, setLastRadiusGeography] = useState<RadiusGeography>(
    values.scope.geography.type === "radius" ? values.scope.geography : DEFAULT_VALUES.scope.geography as RadiusGeography,
  );
  const [lastPropertyTypes, setLastPropertyTypes] = useState<(typeof PROPERTY_TYPES)[number][]>(
    values.scope.property_types !== "all" && values.scope.property_types.length > 0
      ? values.scope.property_types
      : (DEFAULT_VALUES.scope.property_types as (typeof PROPERTY_TYPES)[number][]),
  );
  useEffect(() => {
    if (values.scope.geography.type === "radius") setLastRadiusGeography(values.scope.geography);
  }, [values.scope.geography]);
  useEffect(() => {
    if (values.scope.property_types !== "all" && values.scope.property_types.length > 0) {
      setLastPropertyTypes(values.scope.property_types);
    }
  }, [values.scope.property_types]);

  const isEverywhere = values.scope.geography.type === "everywhere";
  const isAllTypes = values.scope.property_types === "all";

  const setEverywhere = (everywhere: boolean) => {
    setValues((v) => ({
      ...v,
      scope: {
        ...v.scope,
        geography: everywhere ? { type: "everywhere" } : lastRadiusGeography,
      },
    }));
  };

  const setAllTypes = (all: boolean) => {
    setValues((v) => ({
      ...v,
      scope: { ...v.scope, property_types: all ? "all" : lastPropertyTypes },
    }));
  };

  // Issue #659/#663 (not built here): a warning line, not a block — the
  // owner can still create a full-pool profile if he chooses to, but he
  // should not be able to do it BY ACCIDENT without seeing the scale first.
  // Only fetched when a sentinel is actually active; a plain radius+types
  // scope behaves exactly as it did before this issue.
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewNewlyEligible, setPreviewNewlyEligible] = useState<number | null>(null);
  const [previewProjectedDays, setPreviewProjectedDays] = useState<number | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  // Issue #665 review (L2): a failed/non-ok fetch must NOT leave the box
  // stuck on "Calculando…" forever — that reads as "still working" when it
  // actually broke. previewError distinguishes "never finished" (a real
  // failure) from "in flight" (previewLoading) and from "have a number".
  const [previewError, setPreviewError] = useState(false);
  useEffect(() => {
    if (!isEverywhere && !isAllTypes) {
      setPreviewCount(null);
      setPreviewNewlyEligible(null);
      setPreviewProjectedDays(null);
      setPreviewError(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setPreviewLoading(true);
      setPreviewError(false);
      try {
        const res = await fetch("/api/profiles/scope-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope: values.scope }),
        });
        if (cancelled) return;
        if (!res.ok) {
          setPreviewError(true);
          return;
        }
        const body = await res.json();
        setPreviewCount(typeof body.count === "number" ? body.count : null);
        setPreviewNewlyEligible(
          typeof body.newlyEligibleForAssessment === "number" ? body.newlyEligibleForAssessment : null,
        );
        setPreviewProjectedDays(
          typeof body.projectedAssessmentDays === "number" ? body.projectedAssessmentDays : null,
        );
      } catch {
        if (!cancelled) setPreviewError(true);
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEverywhere, isAllTypes, JSON.stringify(values.scope)]);

  const togglePropertyType = (pt: (typeof PROPERTY_TYPES)[number]) => {
    setValues((v) => {
      const current = v.scope.property_types === "all" ? [] : v.scope.property_types;
      const has = current.includes(pt);
      const property_types = has ? current.filter((t) => t !== pt) : [...current, pt];
      return { ...v, scope: { ...v.scope, property_types } };
    });
  };

  // --- Connector selection (issue #660, part of #658) ---------------------
  // The picker loads the live connector roster once (name + global on/off +
  // corpus size, GET /api/etl/connectors — the same admin endpoint the
  // Conectores page uses, task item 5's stated source). A load failure
  // degrades to "no picker, still safe": the form keeps whatever selection
  // it already had (default "all"), it just can't offer per-source
  // checkboxes until the list loads.
  const [connectorList, setConnectorList] = useState<ConnectorView[] | null>(null);
  const [connectorListError, setConnectorListError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/etl/connectors");
        if (!res.ok) throw new Error(String(res.status));
        const body = await res.json();
        if (!cancelled && Array.isArray(body.connectors)) {
          setConnectorList(body.connectors as ConnectorView[]);
        }
      } catch {
        if (!cancelled) setConnectorListError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const effectiveConnectorSelection = effectiveConnectors(values.scope);
  const isAllConnectors = effectiveConnectorSelection === "all";
  const currentSelection: string[] =
    effectiveConnectorSelection === "all" ? [] : effectiveConnectorSelection;

  // Biggest-first (Additional Context: "big three first, tail scannable
  // below"), registered connectors only — an unregistered/removed
  // connector isn't a real choice on the form even though a profile that
  // already selected it degrades sensibly (scope-query.ts's ANY() just
  // matches nothing for that name).
  //
  // Ordered by the SALE corpus only (#674 review L3): a `search_profile` is
  // a sale thesis (D-016), so rental volume must not buy a connector a
  // higher slot — counting it unfiltered ranked `fotocasa_rental` 6th of 18
  // on 283 rental listings and 0 sale ones.
  //
  // A rental-only connector is dropped from the picker entirely: selecting
  // it yields a permanently-empty profile with nothing on screen explaining
  // why. It stays visible only when this profile ALREADY selected it, so an
  // existing (or hand-edited) selection remains something the owner can see
  // and untick rather than invisible state.
  const orderedConnectors = (connectorList ?? [])
    .filter((c) => c.registered)
    .filter((c) => !isRentalOnlyConnector(c) || currentSelection.includes(c.name))
    .slice()
    .sort((a, b) => b.activeSaleListingCount - a.activeSaleListingCount);

  // Remembered selection, so ticking "Todas las fuentes" and unticking it
  // again returns the profile to the sources it had rather than wiping them.
  //
  // Seeded EMPTY, and deliberately so (#674 review H2). The old initializer
  // read `... : orderedConnectors.map((c) => c.name)`, which was DEAD code:
  // `connectorList` is null on the first render and a useState initializer
  // runs exactly once, so that branch could only ever produce `[]`. The fix
  // is to delete the pretence, not to implement it — "start from everything
  // ticked" is the wrong default anyway. Someone unticking "Todas las
  // fuentes" is narrowing, and making them untick 17 of 18 rows on a phone
  // to express that is worse than having them tick the two they want. An
  // empty start is also what the "Selecciona al menos un conector" submit
  // guard already assumes: a positive choice, not a subtraction.
  const [lastConnectorSelection, setLastConnectorSelection] =
    useState<string[]>(currentSelection);
  useEffect(() => {
    const eff = effectiveConnectors(values.scope);
    if (eff !== "all" && eff.length > 0) setLastConnectorSelection(eff);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.scope.connectors]);

  const setAllConnectors = (all: boolean) => {
    // Unticking with nothing remembered lands on `[]` — an intentionally
    // empty picker for the owner to fill in. That state cannot be submitted
    // (the "Selecciona al menos un conector" guard) but it is always
    // RECOVERABLE, which is the part that was broken: the master toggle is
    // never disabled, so re-ticking restores "all" even when the connector
    // roster never loaded (#674 review H2).
    setValues((v) => ({
      ...v,
      scope: {
        ...v.scope,
        connectors: all ? "all" : lastConnectorSelection,
      },
    }));
  };

  const toggleConnector = (name: string) => {
    setValues((v) => {
      const current = effectiveConnectors(v.scope) === "all" ? [] : (v.scope.connectors as string[]);
      const has = current.includes(name);
      const connectors = has ? current.filter((n) => n !== name) : [...current, name];
      return { ...v, scope: { ...v.scope, connectors } };
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (values.scope.property_types !== "all" && values.scope.property_types.length === 0) {
      setError("Selecciona al menos un tipo de inmueble, o marca «Todos los tipos».");
      return;
    }
    const connectorSelection = effectiveConnectors(values.scope);
    if (connectorSelection !== "all" && connectorSelection.length === 0) {
      setError("Selecciona al menos un conector, o marca «Todas las fuentes».");
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(values);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "No se pudo guardar el perfil.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const financing = values.thesis_params.financing;
  const rentAssumption = values.thesis_params.rent_assumption;

  /**
   * Parses a number input's raw text, tolerating a comma decimal separator
   * (Opus review fix: the rent-assumption field's own placeholder read "p.
   * ej. 12,5", but a native `<input type="number">`'s `.value` is always
   * period-decimal per the HTML spec — typing a comma either gets rejected
   * by the browser or (depending on browser/OS locale quirks) survives
   * into onChange and makes `Number("12,5")` return `NaN`. Replacing a
   * comma with a period before parsing makes the field behave the way its
   * own placeholder told the user it would). Returns `undefined` for a
   * blank/invalid value — NEVER `NaN` or a silent `0`, which would clear an
   * assumption without the user intending to.
   */
  function parseFormNumber(raw: string): number | undefined {
    if (raw.trim() === "") return undefined;
    const n = Number(raw.replace(",", "."));
    return Number.isFinite(n) ? n : undefined;
  }

  const setFinancingField = (
    field:
      | "down_payment_pct"
      | "rate_pct"
      | "term_years"
      | "operating_cost_pct"
      | "maintenance_vacancy_pct",
    raw: string,
  ) => {
    setValues((v) => {
      const num = parseFormNumber(raw);
      const base = v.thesis_params.financing ?? {};
      // Each financing field is independently optional in ThesisParamsSchema
      // (Opus review fix — this object used to be "all-or-nothing", which
      // forced this function to silently synthesize rate_pct/term_years
      // defaults the instant a user touched ONLY down_payment_pct; yield.ts
      // then reported those silently-filled values as user-chosen, not as
      // defaults). Blanking any single field now just removes that key —
      // yield.ts's own per-field `?? DEFAULT_FINANCING.x` fallback (and its
      // `*_is_default` flags) handles the rest correctly.
      const updated = { ...base, [field]: num };
      const hasAnyField = Object.values(updated).some((x) => x !== undefined);
      if (!hasAnyField) {
        const { financing: _drop, ...rest } = v.thesis_params;
        return { ...v, thesis_params: rest };
      }
      return {
        ...v,
        thesis_params: { ...v.thesis_params, financing: updated },
      };
    });
  };

  // rent_assumption (issue #151): deliberately a SEPARATE, independently
  // settable field from `financing` — see rent-estimate.ts's module
  // docstring for why a rent figure must be an explicit, visible user
  // assumption rather than folded into the financing block or defaulted by
  // the system. Blank (or unparseable) means "no rent assumption" (yield.ts
  // gates on this, it does not invent a figure) — see parseFormNumber for
  // why this tolerates a comma decimal and never silently stores NaN/0.
  const setRentAssumption = (raw: string) => {
    setValues((v) => {
      const num = parseFormNumber(raw);
      if (num === undefined) {
        const { rent_assumption: _drop, ...rest } = v.thesis_params;
        return { ...v, thesis_params: rest };
      }
      return {
        ...v,
        thesis_params: {
          ...v.thesis_params,
          rent_assumption: { eur_per_m2_month: num },
        },
      };
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      style={{ display: "flex", flexDirection: "column", gap: 14 }}
    >
      {error && (
        <p style={{ fontSize: 13, color: "var(--down)", margin: 0 }}>{error}</p>
      )}

      <div>
        <label style={labelStyle}>Nombre del perfil</label>
        <input
          type="text"
          required
          data-testid="profile-name-input"
          value={values.name}
          onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
          style={inputStyle}
          placeholder="Ej: Alquiler alto rendimiento, bajo coste"
        />
      </div>

      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Zona (radio desde un punto)</legend>
        {/* Issue #659: the "everywhere" STATED sentinel — not an absent
            field. D-013 still holds: a scope that never mentions geography
            fails to save; this checkbox is what writes the explicit
            {type:"everywhere"} value instead. */}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            fontSize: 13,
            color: "var(--fg)",
            marginTop: 6,
          }}
        >
          <input
            type="checkbox"
            data-testid="scope-everywhere-toggle"
            checked={isEverywhere}
            onChange={(e) => setEverywhere(e.target.checked)}
          />
          Sin filtro geográfico (todo el territorio)
        </label>
        {isEverywhere ? (
          <p
            data-testid="scope-everywhere-note"
            style={{ margin: "6px 0 0", fontSize: 12, color: "var(--fg-subtle)" }}
          >
            Este perfil buscará candidatos en toda la base de datos, incluidos inmuebles sin coordenadas
            geocodificadas. Pensado para un perfil de &ldquo;novedades&rdquo; con muy pocos conectores — no para el catálogo
            completo (ver aviso más abajo).
          </p>
        ) : (
          <div style={{ marginTop: 6 }}>
            <LocationPicker
              value={{
                center: values.scope.geography.type === "radius" ? values.scope.geography.center : lastRadiusGeography.center,
                radiusKm: values.scope.geography.type === "radius" ? values.scope.geography.radius_km : lastRadiusGeography.radius_km,
              }}
              onChange={({ center, radiusKm }) =>
                setValues((v) => ({
                  ...v,
                  scope: {
                    ...v.scope,
                    geography: { type: "radius", center, radius_km: radiusKm },
                  },
                }))
              }
            />
          </div>
        )}
      </fieldset>

      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Tipo de inmueble</legend>
        {/* Issue #659: the "all" STATED sentinel — same posture as
            "everywhere" above, never an absent/optional field. */}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            fontSize: 13,
            color: "var(--fg)",
            marginTop: 6,
          }}
        >
          <input
            type="checkbox"
            data-testid="scope-all-types-toggle"
            checked={isAllTypes}
            onChange={(e) => setAllTypes(e.target.checked)}
          />
          Todos los tipos
        </label>
        <div
          style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 10 }}
        >
          {PROPERTY_TYPES.map((pt) => (
            <label
              key={pt}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                fontSize: 13,
                color: isAllTypes ? "var(--fg-subtle)" : "var(--fg)",
              }}
            >
              <input
                type="checkbox"
                disabled={isAllTypes}
                checked={isAllTypes || (Array.isArray(values.scope.property_types) && values.scope.property_types.includes(pt))}
                onChange={() => togglePropertyType(pt)}
              />
              {PROPERTY_TYPE_LABELS[pt]}
            </label>
          ))}
        </div>
      </fieldset>

      {/* Issue #660: per-profile connector selection. "Todas las fuentes"
          (default, D-055-neutral) matches today's behaviour exactly; ticking
          off the master toggle reveals one checkbox per REGISTERED
          connector, biggest corpus first (Additional Context). A connector
          the owner has turned OFF globally (D-055) stays visible but greyed
          + badged, never hidden — "why is X empty" needs an answer on
          screen — but is still selectable-into-a-profile: the effective set
          is the intersection (selection ∩ globally-active), computed at read
          time, so nothing here needs to special-case that precedence. */}
      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Fuentes</legend>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            fontSize: 13,
            color: "var(--fg)",
            marginTop: 6,
            minHeight: 44,
          }}
        >
          {/* Never `disabled` (#674 review H2). The old guard read
              `connectorList === null && !isAllConnectors`, which is exactly
              backwards: while the roster loads the toggle is enabled, so
              unticking it sets `connectors: []`, `isAllConnectors` flips
              false, and the toggle DISABLES ITSELF. With a failed
              /api/etl/connectors it never recovers — no checkboxes to tick,
              submit blocked by the "Selecciona al menos un conector" guard,
              scope preview 400ing on ScopeSchema's .min(1) — and only a
              reload escapes, losing the whole form. On a phone that is the
              end of the session.
              Enabled-always is also the simpler invariant: re-selecting
              "all" writes the literal string and needs no roster at all, so
              there is nothing for a missing roster to make unsafe. */}
          <input
            type="checkbox"
            data-testid="scope-all-connectors-toggle"
            checked={isAllConnectors}
            onChange={(e) => setAllConnectors(e.target.checked)}
          />
          Todas las fuentes
        </label>
        {!isAllConnectors && connectorList === null && !connectorListError && (
          <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--fg-muted)" }}>
            Cargando conectores…
          </p>
        )}
        {!isAllConnectors && connectorListError && (
          <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--down)" }}>
            No se pudo cargar la lista de conectores. Inténtalo de nuevo más tarde.
          </p>
        )}
        {!isAllConnectors && orderedConnectors.length > 0 && (
          <div
            style={{
              marginTop: 8,
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            {orderedConnectors.map((c) => {
              // Shared with DISABLED_SOURCES_CTE's SQL CASE (#674 review L2):
              // this used to be a third private copy of D-055's discriminator.
              const globallyActive = isConnectorActive(c);
              const checked = Array.isArray(values.scope.connectors) && values.scope.connectors.includes(c.name);
              return (
                <label
                  key={c.name}
                  data-testid={`scope-connector-${c.name}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 8,
                    fontSize: 13,
                    // Actually grey the row when the connector is globally
                    // off (#674 review L1). D-152, the e2e spec and the PR
                    // body all said "greyed", but only the badge was muted —
                    // the name rendered at full `--fg` like every other row.
                    // The checkbox stays interactive on purpose: D-055 says
                    // grey it, never hide it, and a global off is a state the
                    // owner can lift later.
                    color: globallyActive ? "var(--fg)" : "var(--fg-muted)",
                    opacity: globallyActive ? 1 : 0.65,
                    minHeight: 44,
                    padding: "2px 0",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleConnector(c.name)}
                  />
                  <span style={{ wordBreak: "break-word" }}>{c.name}</span>
                  {!globallyActive && (
                    <span
                      style={{
                        fontSize: 11,
                        padding: "2px 6px",
                        borderRadius: 4,
                        background: "var(--bg-2)",
                        color: "var(--fg-muted)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      desactivado globalmente
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        )}
      </fieldset>

      {/* Issue #659/#663 (guardrail, not built here): visibility, not a
          block — the owner can still save an accidentally huge profile, but
          he sees the numbers first. #665 review (M1): the owner's LLM
          access is a Claude Max subscription, not a per-token bill, so the
          consequence named here is assessment QUEUE TIME (D-052's
          scheduler drains matched+pending at a fixed rate), never a euro
          figure. #663 (a per-profile assessment opt-out) is still a
          separate issue; `dashboard.llm_enabled` (D-105) remains the
          escape hatch if the queue ever needs to be paused outright. */}
      {(isEverywhere || isAllTypes) && (
        <p
          data-testid="scope-preview-warning"
          style={{
            margin: 0,
            padding: "8px 10px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--bg-1)",
            fontSize: 12,
            color: "var(--fg-muted)",
          }}
        >
          {previewError ? (
            // L2 fix: a failed/non-ok fetch is reported explicitly, never
            // left indistinguishable from "still calculating".
            "No se pudo calcular la vista previa de este ámbito — puedes guardar igualmente, pero no verás el número de inmuebles ni el impacto en la cola de evaluación IA."
          ) : previewLoading || previewCount === null ? (
            "Calculando cuántos inmuebles coincidirían…"
          ) : (
            <>
              Este ámbito coincide ahora mismo con {previewCount.toLocaleString("es-ES")} inmuebles.
              {previewNewlyEligible !== null && (
                <>
                  {" "}
                  De ellos, {previewNewlyEligible.toLocaleString("es-ES")} pasarían a la cola de evaluación por
                  IA
                  {previewProjectedDays !== null && previewNewlyEligible > 0
                    ? ` (≈${previewProjectedDays.toLocaleString("es-ES")} día${previewProjectedDays === 1 ? "" : "s"} al ritmo actual).`
                    : "."}
                </>
              )}{" "}
              Un perfil sin filtros pensado para &ldquo;novedades&rdquo; debería limitarse a pocos conectores
              pequeños.
            </>
          )}
        </p>
      )}

      <div style={rowStyle}>
        <div style={colStyle}>
          <label style={labelStyle}>Precio mín. (€)</label>
          <input
            type="number"
            min={0}
            value={values.scope.price_min ?? ""}
            onChange={(e) =>
              setValues((v) => ({
                ...v,
                scope: {
                  ...v.scope,
                  price_min:
                    e.target.value === "" ? undefined : Number(e.target.value),
                },
              }))
            }
            style={inputStyle}
          />
        </div>
        <div style={colStyle}>
          <label style={labelStyle}>Precio máx. (€)</label>
          <input
            type="number"
            min={0}
            value={values.scope.price_max ?? ""}
            onChange={(e) =>
              setValues((v) => ({
                ...v,
                scope: {
                  ...v.scope,
                  price_max:
                    e.target.value === "" ? undefined : Number(e.target.value),
                },
              }))
            }
            style={inputStyle}
          />
        </div>
      </div>

      <div style={rowStyle}>
        <div style={colStyle}>
          <label style={labelStyle}>Superficie mín. construida (m²)</label>
          <input
            type="number"
            min={0}
            value={values.scope.size_min ?? ""}
            onChange={(e) =>
              setValues((v) => ({
                ...v,
                scope: {
                  ...v.scope,
                  size_min:
                    e.target.value === "" ? undefined : Number(e.target.value),
                },
              }))
            }
            style={inputStyle}
          />
        </div>
        <div style={colStyle}>
          <label style={labelStyle}>Superficie máx. construida (m²)</label>
          <input
            type="number"
            min={0}
            value={values.scope.size_max ?? ""}
            onChange={(e) =>
              setValues((v) => ({
                ...v,
                scope: {
                  ...v.scope,
                  size_max:
                    e.target.value === "" ? undefined : Number(e.target.value),
                },
              }))
            }
            style={inputStyle}
          />
        </div>
      </div>

      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Exclusiones</legend>
        <div
          style={{
            marginTop: 6,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              fontSize: 13,
              color: "var(--fg)",
            }}
          >
            <input
              type="checkbox"
              checked={values.scope.hard_exclusions?.requires_elevator ?? false}
              onChange={(e) =>
                setValues((v) => ({
                  ...v,
                  scope: {
                    ...v.scope,
                    hard_exclusions: {
                      ...v.scope.hard_exclusions,
                      requires_elevator: e.target.checked,
                    },
                  },
                }))
              }
            />
            Requiere ascensor
          </label>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              fontSize: 13,
              color: "var(--fg)",
            }}
          >
            <input
              type="checkbox"
              checked={
                values.scope.hard_exclusions?.excludes_ground_floor ?? false
              }
              onChange={(e) =>
                setValues((v) => ({
                  ...v,
                  scope: {
                    ...v.scope,
                    hard_exclusions: {
                      ...v.scope.hard_exclusions,
                      excludes_ground_floor: e.target.checked,
                    },
                  },
                }))
              }
            />
            Excluir planta baja
          </label>
        </div>
      </fieldset>

      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Objetivo de inversión (opcional)</legend>
        <p
          style={{
            margin: "6px 0 10px",
            fontSize: 12,
            color: "var(--fg-subtle)",
          }}
        >
          Usado a partir de la Fase 3 (puntuación) y la Fase 5 (rentabilidad) —
          se guarda desde ahora aunque todavía no afecte al filtrado.
        </p>
        <div>
          <label style={labelStyle}>
            Rentabilidad objetivo (% bruta anual)
          </label>
          <input
            data-testid="thesis-target-yield"
            type="number"
            min={0}
            step="0.1"
            value={values.thesis_params.target_yield_pct ?? ""}
            onChange={(e) =>
              setValues((v) => ({
                ...v,
                thesis_params: {
                  ...v.thesis_params,
                  target_yield_pct:
                    e.target.value === "" ? undefined : Number(e.target.value),
                },
              }))
            }
            style={inputStyle}
          />
        </div>
        <div style={{ ...rowStyle, marginTop: 10 }}>
          <div style={colStyle}>
            <label style={labelStyle} htmlFor="financing-down-payment-pct">
              Entrada (%)
            </label>
            <input
              id="financing-down-payment-pct"
              type="number"
              min={0}
              max={100}
              value={financing?.down_payment_pct ?? ""}
              onChange={(e) =>
                setFinancingField("down_payment_pct", e.target.value)
              }
              style={inputStyle}
            />
          </div>
          <div style={colStyle}>
            <label style={labelStyle}>Tipo de interés (%)</label>
            <input
              type="number"
              min={0}
              step="0.1"
              value={financing?.rate_pct ?? ""}
              onChange={(e) => setFinancingField("rate_pct", e.target.value)}
              style={inputStyle}
            />
          </div>
          <div style={colStyle}>
            <label style={labelStyle}>Plazo (años)</label>
            <input
              type="number"
              min={1}
              value={financing?.term_years ?? ""}
              onChange={(e) => setFinancingField("term_years", e.target.value)}
              style={inputStyle}
            />
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <label style={labelStyle}>
            Gastos de operación (% del alquiler bruto — IBI, comunidad,
            mantenimiento, vacío)
          </label>
          <input
            type="number"
            min={0}
            max={100}
            step="1"
            placeholder="25 (valor por defecto si se deja en blanco)"
            value={financing?.operating_cost_pct ?? ""}
            onChange={(e) =>
              setFinancingField("operating_cost_pct", e.target.value)
            }
            style={inputStyle}
          />
          <p
            style={{
              margin: "4px 0 0",
              fontSize: 11,
              color: "var(--fg-subtle)",
            }}
          >
            Se usa solo cuando el anuncio de la propiedad NO publica ni IBI ni
            gastos de comunidad reales. En cuanto se conoce uno de los dos, este
            porcentaje se ignora y se usan los datos reales más la asunción de
            mantenimiento/vacío de abajo (issue #151).
          </p>
        </div>
        <div style={{ marginTop: 10 }}>
          <label style={labelStyle}>
            Mantenimiento + vacío (% del alquiler bruto, solo cuando SÍ hay
            IBI/comunidad reales)
          </label>
          <input
            type="number"
            min={0}
            max={100}
            step="1"
            placeholder="8 (valor por defecto si se deja en blanco)"
            value={financing?.maintenance_vacancy_pct ?? ""}
            onChange={(e) =>
              setFinancingField("maintenance_vacancy_pct", e.target.value)
            }
            style={inputStyle}
          />
          <p
            style={{
              margin: "4px 0 0",
              fontSize: 11,
              color: "var(--fg-subtle)",
            }}
          >
            Ningún anuncio publica mantenimiento o vacío por separado, así que
            esta asunción SIEMPRE se suma a la cifra real de IBI/comunidad
            cuando alguna de las dos se conoce — nunca se usa para reemplazar el
            dato real por completo.
          </p>
        </div>
        {financing && (
          <button
            type="button"
            onClick={() =>
              setValues((v) => {
                const { financing: _drop, ...rest } = v.thesis_params;
                return { ...v, thesis_params: rest };
              })
            }
            style={{
              marginTop: 8,
              padding: 0,
              border: "none",
              background: "none",
              color: "var(--fg-subtle)",
              fontSize: 12,
              cursor: "pointer",
              textDecoration: "underline",
            }}
          >
            Quitar datos de financiación
          </button>
        )}

        <div
          style={{
            marginTop: 14,
            paddingTop: 10,
            borderTop: "1px solid var(--border)",
          }}
        >
          <label style={labelStyle} htmlFor="rent-assumption-eur-per-m2">
            Asunción de alquiler (€/m²/mes)
          </label>
          <input
            id="rent-assumption-eur-per-m2"
            // type="text", NOT type="number" (Opus review fix). A native
            // <input type="number">'s value-sanitization algorithm DISCARDS
            // any keystroke that doesn't parse as a period-decimal float —
            // typing a comma (which the field's own placeholder used to
            // suggest: "p. ej. 12,5") never even reaches this onChange
            // handler as "12,5"; the browser silently resets .value to "",
            // so Number(e.target.value) saw an empty string and
            // parseFormNumber (or the old bare Number()) cleared the
            // assumption to undefined/0 with no error. inputMode="decimal"
            // still gives mobile users a numeric keypad; parseFormNumber
            // normalizes a comma OR a period before parsing, so both the
            // Spanish-convention "12,5" and the plain "12.5" work.
            type="text"
            inputMode="decimal"
            placeholder="p. ej. 12,5"
            value={rentAssumption?.eur_per_m2_month ?? ""}
            onChange={(e) => setRentAssumption(e.target.value)}
            style={inputStyle}
          />
          <p
            style={{
              margin: "4px 0 0",
              fontSize: 11,
              color: "var(--fg-subtle)",
            }}
          >
            Opcional (issue #31): si defines tu propia estimación de alquiler
            por m² para la zona de este perfil, se usará siempre para calcular
            el yield, incluso si hay comparables de alquiler ingeridos en la
            zona — nunca se sustituye en silencio por una cifra medida, aunque
            ambas se muestran si difieren. Si la dejas en blanco, inmo-tool
            intentará estimar el alquiler a partir de anuncios de alquiler
            comparables ya ingeridos en la zona; si no hay suficientes, no se
            muestra ningún yield (ni se inventa una cifra).
          </p>
        </div>
      </fieldset>

      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="submit"
          disabled={submitting}
          style={{
            padding: "7px 14px",
            background: "var(--accent)",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 500,
            cursor: submitting ? "default" : "pointer",
            opacity: submitting ? 0.6 : 1,
          }}
        >
          {submitting ? "Guardando…" : submitLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: "7px 14px",
              background: "transparent",
              color: "var(--fg)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Cancelar
          </button>
        )}
      </div>
    </form>
  );
}
