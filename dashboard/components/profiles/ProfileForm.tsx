"use client";

import { useState } from "react";
import { PROPERTY_TYPES, type Scope } from "@/lib/profiles-schema";

const PROPERTY_TYPE_LABELS: Record<(typeof PROPERTY_TYPES)[number], string> = {
  piso: "Piso",
  chalet: "Chalet",
  atico: "Ático",
  local_comercial: "Local comercial",
  nave_industrial: "Nave industrial",
  garaje: "Garaje",
  terreno: "Terreno",
  edificio_completo: "Edificio completo",
};

export interface ProfileFormValues {
  name: string;
  scope: Scope;
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
};

/**
 * Minimal scope-editing form. Geography is radius-from-a-point (issue #17
 * Technical approach #5) — a polygon map-drawing tool is a reasonable later
 * enhancement, not required here.
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

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && <p className="text-sm text-red-600">{error}</p>}

      <div>
        <label className="block text-sm font-medium">Nombre del perfil</label>
        <input
          type="text"
          required
          value={values.name}
          onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
          className="mt-1 w-full rounded border px-2 py-1"
          placeholder="Ej: Alquiler alto rendimiento, bajo coste"
        />
      </div>

      <fieldset>
        <legend className="block text-sm font-medium">Zona (radio desde un punto)</legend>
        <div className="mt-1 flex gap-2">
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
            className="w-1/3 rounded border px-2 py-1"
            placeholder="Latitud"
          />
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
            className="w-1/3 rounded border px-2 py-1"
            placeholder="Longitud"
          />
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
            className="w-1/3 rounded border px-2 py-1"
            placeholder="Radio (km)"
          />
        </div>
      </fieldset>

      <fieldset>
        <legend className="block text-sm font-medium">Tipo de inmueble</legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {PROPERTY_TYPES.map((pt) => (
            <label key={pt} className="flex items-center gap-1 text-sm">
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

      <div className="flex gap-2">
        <div className="w-1/2">
          <label className="block text-sm font-medium">Precio mín. (€)</label>
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
            className="mt-1 w-full rounded border px-2 py-1"
          />
        </div>
        <div className="w-1/2">
          <label className="block text-sm font-medium">Precio máx. (€)</label>
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
            className="mt-1 w-full rounded border px-2 py-1"
          />
        </div>
      </div>

      <div className="flex gap-2">
        <div className="w-1/2">
          <label className="block text-sm font-medium">Superficie mín. (m²)</label>
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
            className="mt-1 w-full rounded border px-2 py-1"
          />
        </div>
        <div className="w-1/2">
          <label className="block text-sm font-medium">Superficie máx. (m²)</label>
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
            className="mt-1 w-full rounded border px-2 py-1"
          />
        </div>
      </div>

      <fieldset>
        <legend className="block text-sm font-medium">Exclusiones</legend>
        <label className="mt-1 flex items-center gap-1 text-sm">
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
        <label className="mt-1 flex items-center gap-1 text-sm">
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
      </fieldset>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {submitting ? "Guardando…" : submitLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded border px-3 py-1.5 text-sm font-medium"
          >
            Cancelar
          </button>
        )}
      </div>
    </form>
  );
}
