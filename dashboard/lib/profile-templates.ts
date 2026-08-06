/**
 * Static registry of profile "starting-point" templates (issue #39, part of
 * #8). Pure UI convenience: creating the second/third concurrent thesis from a
 * blank scope form is friction (issue #1 §2/§3's multi-profile use case), so a
 * template pre-fills the form with plausible, thesis-appropriate defaults that
 * the investor then edits before saving.
 *
 * IMPORTANT — no new schema, no new validation. Every template's
 * `defaultScope` / `defaultThesisParams` is just a valid instance of the same
 * `Scope` / `ThesisParams` shapes ProfileForm and POST /api/profiles already
 * accept (lib/profiles-schema.ts). A template is a *starting point*, never a
 * locked-in choice — the form stays fully editable after one is picked, and
 * "Empezar en blanco" remains available (see TemplatePicker + app/profiles).
 */
import type { Scope, ThesisParams } from "@/lib/profiles-schema";

export interface ProfileTemplate {
  /** Stable id — used as the TemplatePicker selection key and ProfileForm remount key. */
  id: string;
  /** Short human label (Spanish) shown on the picker button and used as the suggested profile name. */
  label: string;
  /** One-line description of the thesis this template seeds. */
  description: string;
  defaultScope: Scope;
  defaultThesisParams: ThesisParams;
}

// A shared, sensible geographic starting point (Madrid centre, 5 km radius).
// The investor re-centres/re-sizes this from the map picker after choosing a
// template — it is only a default so the form is immediately valid.
const MADRID_CENTER: [number, number] = [40.4168, -3.7038];

/**
 * The three seed templates issue #39 (and issue #1 §3) call out:
 *  - buy-to-let / high-yield rental (buy-to-rent thesis, target yield set)
 *  - flip / renovate-and-sell (buy-to-flip, distress-tolerant entry band)
 *  - commercial / local comercial (commercial rental)
 */
export const PROFILE_TEMPLATES: ProfileTemplate[] = [
  {
    id: "buy-to-let",
    label: "Alquiler alto rendimiento",
    description:
      "Compra para alquilar: piso residencial en banda de precio media, con un objetivo de rentabilidad bruta anual.",
    defaultScope: {
      geography: { type: "radius", center: MADRID_CENTER, radius_km: 5 },
      property_types: ["piso"],
      price_min: 80000,
      price_max: 180000,
      hard_exclusions: {},
    },
    defaultThesisParams: {
      thesis_type: "rent",
      target_yield_pct: 7,
    },
  },
  {
    id: "flip",
    label: "Reforma y venta (flip)",
    description:
      "Compra para reformar y revender: banda de precio de entrada baja y tolerante a inmuebles en mal estado.",
    defaultScope: {
      geography: { type: "radius", center: MADRID_CENTER, radius_km: 5 },
      property_types: ["piso"],
      price_min: 40000,
      price_max: 140000,
      // Distress-tolerant on purpose: no requires_elevator / ground-floor
      // exclusion, so run-down bajos and walk-ups (the flip supply) aren't
      // filtered out before the investor even looks at them.
      hard_exclusions: {},
    },
    defaultThesisParams: {
      // A flip is scored on renovation cost / ARV / resale margin, not rental
      // yield — so no target_yield_pct here; thesis_type "flip" is what gates
      // the property-detail renovation section (issue #45).
      thesis_type: "flip",
    },
  },
  {
    id: "commercial",
    label: "Local comercial",
    description:
      "Inversión en local comercial para alquiler: banda de precio media-alta y objetivo de rentabilidad mayor.",
    defaultScope: {
      geography: { type: "radius", center: MADRID_CENTER, radius_km: 5 },
      property_types: ["local"],
      price_min: 60000,
      price_max: 250000,
      hard_exclusions: {},
    },
    defaultThesisParams: {
      thesis_type: "rent",
      target_yield_pct: 8,
    },
  },
];

/** Look up a template by id (null-safe — returns undefined for blank/unknown). */
export function findTemplate(
  id: string | null | undefined,
): ProfileTemplate | undefined {
  if (!id) return undefined;
  return PROFILE_TEMPLATES.find((t) => t.id === id);
}

/**
 * Map a template to the exact `{ name, scope, thesis_params }` shape ProfileForm
 * seeds from (structurally its `ProfileFormValues`). The template `label`
 * becomes the suggested profile name — one more field the investor doesn't have
 * to type from scratch, still freely editable. Deep-clones scope/thesis so the
 * live form never mutates the shared registry object.
 */
export function templateToFormValues(template: ProfileTemplate): {
  name: string;
  scope: Scope;
  thesis_params: ThesisParams;
} {
  return {
    name: template.label,
    scope: structuredClone(template.defaultScope),
    thesis_params: structuredClone(template.defaultThesisParams),
  };
}
