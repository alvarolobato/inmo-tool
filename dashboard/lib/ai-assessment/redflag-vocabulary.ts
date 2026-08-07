/**
 * Redflags closed vocabulary — the enum, its display labels, and its one-line
 * definitions, kept in a LEAF module (no `pg`, no LLM imports).
 *
 * Extracted from `redflags.ts` for #396 (Fase 7 of #385): the prompt builder
 * (`lib/llm-context/system-prompt.ts`) now renders the vocabulary FROM these
 * constants so the enum is the single source of truth. Importing them straight
 * from `redflags.ts` would create a cycle (system-prompt → redflags → llm →
 * llm-context → system-prompt), because `redflags.ts` transitively pulls in the
 * `pg` client and the LLM entry points. This leaf carries only data, so any
 * module — client or server, prompt builder or renderer — can import it safely.
 *
 * `redflags.ts` re-exports everything here, so existing importers
 * (`lib/candidates.ts`, `lib/property-detail.ts`, `lib/notifications/digest.ts`,
 * the tests) keep importing from `@/lib/ai-assessment/redflags` unchanged.
 */

/**
 * Closed type vocabulary (issue #27 technical approach #1, broadened in #361).
 * The first block is legal/financial (#27); the second is physical problems
 * (#361). `other` is the catch-all for a real disclosure that doesn't fit the
 * named categories — used both by the model directly and as the coercion
 * target for an unrecognised label (see redflags.ts's module doc).
 */
export const REDFLAG_TYPES = [
  // Legal / financial (#27)
  "embargo",
  "subasta_judicial",
  "herencia_yacente",
  "deuda_comunidad",
  "construccion_ilegal",
  "litigio",
  "sin_financiacion_hipotecaria",
  "cambio_uso_pendiente",
  // Physical (#361)
  "unfinished_construction",
  "structural_damage",
  "other",
] as const;

export type RedFlagType = (typeof REDFLAG_TYPES)[number];

/**
 * Short Spanish badge label per problem type, for the card and the property
 * detail page (#361). Both `lib/candidates.ts` (`flagsFromAssessments`) and the
 * detail page's `PropertyProblemFlags` read this one map instead of duplicating
 * it.
 *
 * `other` is deliberately absent: it's the long-tail catch-all with no
 * stable, scannable meaning, so a generic "Problema" badge would carry no
 * information (the same reason `reformado`/`unclear` get no condition badge).
 * A flag whose `type` isn't a key here is dropped by the renderers, never
 * shown as raw text.
 */
export const REDFLAG_LABELS: Record<string, string> = {
  embargo: "Embargo",
  subasta_judicial: "Subasta judicial",
  herencia_yacente: "Herencia yacente",
  deuda_comunidad: "Deuda comunidad",
  construccion_ilegal: "Construcción ilegal",
  litigio: "Litigio",
  sin_financiacion_hipotecaria: "Sin financiación hipotecaria",
  cambio_uso_pendiente: "Cambio de uso pendiente",
  unfinished_construction: "Obra inacabada",
  structural_damage: "Daño estructural",
};

/**
 * #396 (Fase 7 of #385) — one-line Spanish definition per closed-vocabulary
 * type. Colocated with `REDFLAG_TYPES`/`REDFLAG_LABELS` so the enum is the
 * single source of truth for the vocabulary the redflags prompt renders:
 * `buildRedflagsPrompt` iterates `REDFLAG_TYPES` and pulls the label + this
 * definition, instead of duplicating the list as fixed prose. Adding a new
 * named type is therefore a one-line change here + in the two maps above, and
 * it appears in the prompt automatically (the enum-render test enforces this).
 *
 * The definitions carry the disambiguation cues the model needs (e.g.
 * `unfinished_construction` vs `a_reformar`/`obra_nueva`, `subasta_judicial`
 * vs `embargo`, `herencia_yacente` vs `ownership.proindiviso`), so folding the
 * old prose into data does not weaken classification. `other` is defined here
 * too, but the builder renders it specially (it also asks for a `candidate_type`
 * slug + `definition`, and shows the trending candidates).
 */
export const REDFLAG_DEFINITIONS: Record<RedFlagType, string> = {
  embargo:
    "embargo o deuda con garantía sobre el inmueble (hipoteca ejecutada, anotación de embargo). Si además se menciona explícitamente una subasta, usa `subasta_judicial`.",
  subasta_judicial:
    'el inmueble se vende en subasta judicial o mediante procedimiento de apremio (p.ej. "subasta judicial", "procedimiento de apremio", "adjudicación en subasta", "subasta ante el juzgado"). Es la fase ejecutiva de un embargo; márcalo aquí cuando el texto cite la subasta o el apremio, aunque también mencione el embargo de fondo.',
  herencia_yacente:
    "herencia yacente, herencia pendiente de partición, varios herederos/propietarios sin repartir. Si lo que se vende es una cuota indivisa ya definida, sin un proceso de herencia sin resolver, es `ownership.proindiviso` en el flujo de ocupación (#25), no esto — aquí importa si la titularidad sigue sin resolver.",
  deuda_comunidad:
    "derramas pendientes, deudas con la comunidad de propietarios.",
  construccion_ilegal:
    "ampliación o construcción no legalizada, fuera de ordenación, sin licencia.",
  litigio: "procedimiento judicial en curso sobre el inmueble.",
  sin_financiacion_hipotecaria:
    "la vivienda no admite financiación hipotecaria / sólo compra al contado (típico de adjudicados/deuda). Es una restricción de FINANCIACIÓN, distinta de `subasta_judicial` (fase ejecutiva) y de `embargo` (garantía/deuda): úsalo cuando el texto diga que no cabe hipoteca o que la compra debe ser al contado.",
  cambio_uso_pendiente:
    "el inmueble requiere/está pendiente de un cambio de uso (p.ej. local a vivienda) no resuelto. Es un trámite urbanístico PENDIENTE, distinto de `construccion_ilegal` (obra sin legalizar/fuera de ordenación): aquí el uso actual es legal pero se necesita reclasificarlo y ese cambio aún no está concedido.",
  unfinished_construction:
    'obra inacabada, parcialmente ejecutada, obra parada: una construcción o rehabilitación que NO se ha terminado y se vende a medio hacer (p.ej. "en construcción", "parcialmente ejecutada", "obra parada", "a falta de terminar", "estructura levantada sin cerramientos", "algunos tabiques ya levantados", "sin acabados"). Es distinto de `a_reformar` (una vivienda TERMINADA que necesita reforma, flujo #26) y de `obra_nueva` (una construcción nueva ya TERMINADA).',
  structural_damage:
    'daños estructurales graves citados explícitamente: grietas estructurales, aluminosis, cimentación o forjado dañado, riesgo de ruina, humedades estructurales. NO lo uses para desgaste normal, "a reformar" o acabados antiguos — eso es condición, no un daño estructural.',
  other:
    "cualquier otro problema (legal, financiero o físico) relevante citado explícitamente, que no encaje en las categorías anteriores.",
};
