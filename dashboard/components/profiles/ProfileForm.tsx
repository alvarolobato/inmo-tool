"use client";

import { useState } from "react";
import { PROPERTY_TYPES, type Scope, type ThesisParams } from "@/lib/profiles-schema";

const PROPERTY_TYPE_LABELS: Record<(typeof PROPERTY_TYPES)[number], string> = {
  piso: "Piso",
  chalet: "Chalet",
  atico: "Ático",
  local: "Local comercial",
  nave: "Nave industrial",
  garaje: "Garaje",
  terreno: "Terreno",
  edificio: "Edificio completo",
};

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

const DEFAULT_VALUES: ProfileFormValues = {
  name: "",
  scope: {
    geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 5 },
    property_types: ["piso"],
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
export function ProfileForm({ initial, submitLabel, onSubmit, onCancel }: ProfileFormProps) {
  const [values, setValues] = useState<ProfileFormValues>(initial ?? DEFAULT_VALUES);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const togglePropertyType = (pt: (typeof PROPERTY_TYPES)[number]) => {
    setValues((v) => {
      const has = v.scope.property_types.includes(pt);
      const property_types = has
        ? v.scope.property_types.filter((t) => t !== pt)
        : [...v.scope.property_types, pt];
      return { ...v, scope: { ...v.scope, property_types } };
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (values.scope.property_types.length === 0) {
      setError("Selecciona al menos un tipo de inmueble.");
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(values);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el perfil.");
    } finally {
      setSubmitting(false);
    }
  };

  const financing = values.thesis_params.financing;

  const setFinancingField = (field: "down_payment_pct" | "rate_pct" | "term_years", raw: string) => {
    setValues((v) => {
      const num = raw === "" ? undefined : Number(raw);
      const base = v.thesis_params.financing ?? {
        down_payment_pct: 20,
        rate_pct: 3,
        term_years: 25,
      };
      // financing is an all-or-nothing object in ThesisParamsSchema (issue
      // #1 §11's financing assumptions are used together for a cash-on-cash
      // estimate in Phase 5) — an incomplete triple isn't a valid partial,
      // so a blanked field falls back to the last-known/default value rather
      // than producing an invalid shape.
      return {
        ...v,
        thesis_params: {
          ...v.thesis_params,
          financing: { ...base, [field]: num ?? base[field] },
        },
      };
    });
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {error && <p style={{ fontSize: 13, color: "var(--down)", margin: 0 }}>{error}</p>}

      <div>
        <label style={labelStyle}>Nombre del perfil</label>
        <input
          type="text"
          required
          value={values.name}
          onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
          style={inputStyle}
          placeholder="Ej: Alquiler alto rendimiento, bajo coste"
        />
      </div>

      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Zona (radio desde un punto)</legend>
        <div style={{ ...rowStyle, marginTop: 6 }}>
          <div style={colStyle}>
            <label style={labelStyle}>Latitud</label>
            <input
              type="number"
              step="any"
              value={values.scope.geography.center[0]}
              onChange={(e) =>
                setValues((v) => ({
                  ...v,
                  scope: {
                    ...v.scope,
                    geography: {
                      ...v.scope.geography,
                      center: [Number(e.target.value), v.scope.geography.center[1]],
                    },
                  },
                }))
              }
              style={inputStyle}
            />
          </div>
          <div style={colStyle}>
            <label style={labelStyle}>Longitud</label>
            <input
              type="number"
              step="any"
              value={values.scope.geography.center[1]}
              onChange={(e) =>
                setValues((v) => ({
                  ...v,
                  scope: {
                    ...v.scope,
                    geography: {
                      ...v.scope.geography,
                      center: [v.scope.geography.center[0], Number(e.target.value)],
                    },
                  },
                }))
              }
              style={inputStyle}
            />
          </div>
          <div style={colStyle}>
            <label style={labelStyle}>Radio (km)</label>
            <input
              type="number"
              min={0.1}
              step="any"
              value={values.scope.geography.radius_km}
              onChange={(e) =>
                setValues((v) => ({
                  ...v,
                  scope: {
                    ...v.scope,
                    geography: { ...v.scope.geography, radius_km: Number(e.target.value) },
                  },
                }))
              }
              style={inputStyle}
            />
          </div>
        </div>
      </fieldset>

      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Tipo de inmueble</legend>
        <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 10 }}>
          {PROPERTY_TYPES.map((pt) => (
            <label
              key={pt}
              style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, color: "var(--fg)" }}
            >
              <input
                type="checkbox"
                checked={values.scope.property_types.includes(pt)}
                onChange={() => togglePropertyType(pt)}
              />
              {PROPERTY_TYPE_LABELS[pt]}
            </label>
          ))}
        </div>
      </fieldset>

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
                  price_min: e.target.value === "" ? undefined : Number(e.target.value),
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
                  price_max: e.target.value === "" ? undefined : Number(e.target.value),
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
                  size_min: e.target.value === "" ? undefined : Number(e.target.value),
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
                  size_max: e.target.value === "" ? undefined : Number(e.target.value),
                },
              }))
            }
            style={inputStyle}
          />
        </div>
      </div>

      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Exclusiones</legend>
        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, color: "var(--fg)" }}>
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
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, color: "var(--fg)" }}>
            <input
              type="checkbox"
              checked={values.scope.hard_exclusions?.excludes_ground_floor ?? false}
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
        <p style={{ margin: "6px 0 10px", fontSize: 12, color: "var(--fg-subtle)" }}>
          Usado a partir de la Fase 3 (puntuación) y la Fase 5 (rentabilidad) — se guarda desde
          ahora aunque todavía no afecte al filtrado.
        </p>
        <div>
          <label style={labelStyle}>Rentabilidad objetivo (% bruta anual)</label>
          <input
            type="number"
            min={0}
            step="0.1"
            value={values.thesis_params.target_yield_pct ?? ""}
            onChange={(e) =>
              setValues((v) => ({
                ...v,
                thesis_params: {
                  ...v.thesis_params,
                  target_yield_pct: e.target.value === "" ? undefined : Number(e.target.value),
                },
              }))
            }
            style={inputStyle}
          />
        </div>
        <div style={{ ...rowStyle, marginTop: 10 }}>
          <div style={colStyle}>
            <label style={labelStyle}>Entrada (%)</label>
            <input
              type="number"
              min={0}
              max={100}
              value={financing?.down_payment_pct ?? ""}
              onChange={(e) => setFinancingField("down_payment_pct", e.target.value)}
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
