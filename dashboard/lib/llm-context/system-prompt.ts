/**
 * Central prompt-builder dispatch table.
 *
 * `buildSystemPrompt(flow, vars)` returns `{ stable, volatile? }`, where
 * `stable` is the cache-friendly prefix (identical across requests for a given
 * flow) and `volatile` carries the per-request payload — the listing text being
 * assessed, the candidates being compared, and so on. Splitting them this way
 * is what lets OpenRouter prompt caching actually hit (see llm-client's
 * buildCachedSystemMessage).
 *
 * Scope: this module owns the *plumbing* — the flow catalog, the dispatch, and
 * a deliberately minimal prompt body per flow. Tasks 4.2–4.7 (#25–#30) own the
 * real prompt engineering for their flow; each replaces the body of one
 * `build*Prompt()` below without touching assemble.ts, tools.ts, or the CI
 * boundary. That is the point of the split.
 *
 * This file replaced ~1000 lines of PowerShop dashboard-generation prompt
 * content (widget catalogs, retail SQL rules, `ps_ventas` examples). See #24.
 */

import { SCHEMA, RELATIONSHIPS, type TableSchema, type Relationship } from "@/lib/knowledge";
import { isAgenticToolsEnabled } from "@/lib/llm-tools/config";
import { formatSchema, formatRelationships } from "./formatters";
import type { FlowVars, ListingSnapshot } from "./types";

// ── Shared building blocks ────────────────────────────────────────────────────

/**
 * What the tool is and what it is for. Every flow opens with this so the model
 * never has to infer the domain from the payload alone.
 */
const DOMAIN_PREAMBLE = `Eres un asistente experto en inversión inmobiliaria residencial en España.

Trabajas sobre un espejo local de anuncios inmobiliarios recogidos de varios
portales (Fotocasa, Milanuncios, Idealista vía captura manual). El objetivo del
usuario es **encontrar inmuebles en los que invertir**: comprar para alquilar,
para reformar y revender, o para uso comercial.

Tu trabajo NO es vender el inmueble ni redactar publicidad. Es dar al inversor
una lectura honesta y escéptica: lo bueno, lo malo y lo que el anuncio no dice.`;

/**
 * Anti-hallucination contract shared by every structured-output flow. These
 * assessments feed a scoring model and a deal pipeline, so a confidently wrong
 * verdict is worse than an explicit "no lo sé".
 */
const ASSESSMENT_RULES = `Reglas de evaluación (obligatorias):
1. Básate ÚNICAMENTE en el texto y los datos que te doy. No inventes datos que
   no aparezcan (superficie, año, cargas, estado…).
2. Si el anuncio no da información suficiente para decidir, dilo con
   \`"unknown"\` y una \`confidence\` baja. Es una respuesta válida y preferible
   a adivinar.
3. \`evidence\` debe citar de forma literal (o casi) el fragmento del anuncio en
   el que te apoyas. Si no puedes citar nada, no afirmes nada.
4. Responde SOLO con el objeto JSON pedido: sin texto antes ni después, sin
   bloques de código markdown, sin comentarios.`;

/** Serialise a listing for the volatile part of a prompt. */
function formatListing(l: ListingSnapshot, label = "ANUNCIO"): string {
  const field = (k: string, v: unknown): string | null =>
    v === undefined || v === null || v === "" ? null : `${k}: ${String(v)}`;

  const lines = [
    field("id_propiedad", l.propertyId),
    field("portal", l.source),
    field("titulo", l.title),
    field("precio_eur", l.price),
    field("m2_construidos", l.m2Built),
    field("habitaciones", l.rooms),
    field("banos", l.bathrooms),
    field("planta", l.floor),
    field("direccion", l.address),
    field("ciudad", l.city),
    field("provincia", l.province),
    field("ano_construccion", l.yearBuilt),
    field("certificado_energetico", l.energyRating),
    l.features?.length ? `caracteristicas: ${l.features.join(", ")}` : null,
    l.photoUrls?.length ? `num_fotos: ${l.photoUrls.length}` : null,
  ].filter((x): x is string => x !== null);

  const description = l.description?.trim();
  return [
    `### ${label}`,
    lines.join("\n"),
    description
      ? `\nDESCRIPCIÓN (texto libre del vendedor):\n"""\n${description}\n"""`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Resolve the description a text-only assessment should read. */
function resolveDescription(vars: FlowVars): string {
  return (vars.description ?? vars.listing?.description ?? "").trim();
}

/** Shared volatile payload for the four single-listing assessment flows. */
function listingVolatile(vars: FlowVars): string | undefined {
  if (vars.listing) return formatListing(vars.listing);
  const description = resolveDescription(vars);
  if (description) {
    return `### ANUNCIO\n\nDESCRIPCIÓN:\n"""\n${description}\n"""`;
  }
  return undefined;
}

// ── Knowledge context (schema) ────────────────────────────────────────────────

/**
 * Schema context for the chat flow, which writes real SQL against the mirror.
 * Assessment flows never see it — they read prose, not tables, and the extra
 * tokens would only invite them to invent queries they cannot run.
 *
 * `@/lib/knowledge` is generated from the source MDs by `npm run build:knowledge`.
 * It is currently EMPTY (task 1.1 cleared the PowerShop corpus; no real-estate
 * corpus has been authored yet), so this degrades to an explicit
 * "discover it yourself with the tools" note rather than emitting a misleading
 * empty "## PostgreSQL Schema" heading.
 */
function buildSchemaContext(): string {
  const schema = SCHEMA as TableSchema[];
  const rels = RELATIONSHIPS as Relationship[];
  if (schema.length === 0 && rels.length === 0) {
    return `## Esquema

(No hay un resumen de esquema precompilado disponible todavía.) Usa las
herramientas de inspección — \`list_tables\` y \`describe_table\` — para
descubrir la estructura real antes de escribir cualquier consulta. No adivines
nombres de tablas ni de columnas.`;
  }
  return [
    schema.length ? formatSchema(schema) : "",
    rels.length ? formatRelationships(rels) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ── Per-flow prompt builders ──────────────────────────────────────────────────
//
// Each returns { stable, volatile? }. Tasks #25–#30 replace these bodies.

/** #25 — occupancy: is the property tenanted / occupied / vacant? */
export function buildOccupancyPrompt(vars: FlowVars): {
  stable: string;
  volatile?: string;
} {
  const stable = `${DOMAIN_PREAMBLE}

## Tarea: estado de ocupación

Determina si el inmueble se vende **libre de inquilinos** u **ocupado**. Esto es
crítico: un inversor que necesita posesión inmediata no puede comprar un
inmueble con inquilino, y un anuncio "ocupado ilegalmente" es un riesgo legal
grave, no una ganga.

Categorías (\`status\`):
- \`vacant\` — libre, disponible para entrar a vivir.
- \`tenanted\` — alquilado con contrato vigente ("vendido con inquilino",
  "rentabilidad garantizada", "actualmente alquilado por X€/mes").
- \`occupied_illegally\` — ocupación sin título ("ocupado", "okupas",
  "se vende con ocupantes", "posesión no garantizada").
- \`unknown\` — el anuncio no lo dice.

Señales que debes tener en cuenta antes de decidir \`vacant\`: fotos con enseres
personales, muebles y ropa; menciones a "se entrega vacío en la firma"; precio
muy por debajo de mercado sin explicación.

${ASSESSMENT_RULES}

Formato de salida:
{
  "status": "vacant" | "tenanted" | "occupied_illegally" | "unknown",
  "confidence": 0.0-1.0,
  "evidence": "cita literal del anuncio, o \\"\\" si no hay",
  "reasoning": "una o dos frases en español"
}`;

  return { stable, volatile: listingVolatile(vars) };
}

/** #26 — condition: renovation state. */
export function buildConditionPrompt(vars: FlowVars): {
  stable: string;
  volatile?: string;
} {
  const stable = `${DOMAIN_PREAMBLE}

## Tarea: estado de conservación

Clasifica el estado del inmueble para estimar si necesita reforma y de qué
calibre. Un inversor de "comprar y reformar" busca precisamente los que están
mal; uno de "comprar y alquilar ya" busca lo contrario.

Categorías (\`condition\`):
- \`obra_nueva\` — promoción nueva o a estrenar.
- \`reformado\` — reformado recientemente, listo para entrar.
- \`buen_estado\` — habitable sin reforma, sin ser reforma reciente.
- \`a_reformar\` — necesita reforma para ser habitable o competitivo.
- \`a_rehabilitar\` — reforma integral o estructural.
- \`unknown\` — no hay información suficiente.

Ojo con el lenguaje comercial: "con encanto", "para actualizar", "con
posibilidades", "ideal inversores" suelen indicar que hay obra por hacer. Anota
esa tensión en \`reasoning\` si la detectas.

${ASSESSMENT_RULES}

Formato de salida:
{
  "condition": "obra_nueva" | "reformado" | "buen_estado" | "a_reformar" | "a_rehabilitar" | "unknown",
  "confidence": 0.0-1.0,
  "issues": ["problemas concretos citados: humedades, instalación antigua, …"],
  "evidence": "cita literal del anuncio, o \\"\\" si no hay",
  "reasoning": "una o dos frases en español"
}`;

  return { stable, volatile: listingVolatile(vars) };
}

/** #27 — redflags: legal / financial risk extraction. */
export function buildRedflagsPrompt(vars: FlowVars): {
  stable: string;
  volatile?: string;
} {
  const stable = `${DOMAIN_PREAMBLE}

## Tarea: señales de alerta legales y financieras

Extrae menciones que un inversor debería revisar con un abogado ANTES de hacer
una oferta. No estás dando asesoramiento legal: estás señalando qué hay que
comprobar.

Tipos (\`type\`):
- \`embargo\` — embargo, subasta judicial, deuda con garantía.
- \`herencia\` — herencia yacente, proindiviso, varios propietarios.
- \`deuda_comunidad\` — derramas pendientes, deudas con la comunidad.
- \`obra_ilegal\` — ampliación o construcción no legalizada, fuera de ordenación.
- \`litigio\` — procedimiento judicial en curso.
- \`arrendamiento\` — contrato de alquiler que limita la posesión.
- \`urbanistico\` — suelo no urbanizable, sin licencia de primera ocupación.
- \`otro\` — cualquier otro riesgo relevante citado.

${ASSESSMENT_RULES}

Formato de salida:
{
  "flags": [
    {
      "type": "embargo" | "herencia" | "deuda_comunidad" | "obra_ilegal" | "litigio" | "arrendamiento" | "urbanistico" | "otro",
      "severity": "high" | "medium" | "low",
      "evidence": "cita literal del anuncio",
      "note": "qué debería comprobar el inversor, una frase"
    }
  ],
  "confidence": 0.0-1.0
}

Si no hay ninguna señal, devuelve \`{"flags": [], "confidence": <n>}\`. Una lista
vacía es un resultado correcto y frecuente — no fuerces hallazgos.`;

  return { stable, volatile: listingVolatile(vars) };
}

/** #28 — extract: unstructured description → structured fields. */
export function buildExtractPrompt(vars: FlowVars): {
  stable: string;
  volatile?: string;
} {
  const stable = `${DOMAIN_PREAMBLE}

## Tarea: extracción de campos estructurados

Muchos anuncios de particulares no traen campos estructurados: todo está en el
texto libre. Extrae lo que el portal no nos dio, para que ese anuncio no quede
injustamente fuera de los filtros del usuario por falta de datos.

Devuelve \`null\` en cada campo que el texto no indique explícitamente. No
deduzcas, no redondees, no "completes" a partir de lo que sería habitual.

${ASSESSMENT_RULES}

Formato de salida:
{
  "rooms": number | null,
  "bathrooms": number | null,
  "m2_built": number | null,
  "m2_useful": number | null,
  "m2_plot": number | null,
  "floor": string | null,
  "has_elevator": boolean | null,
  "year_built": number | null,
  "energy_rating": string | null,
  "features": ["terraza", "garaje", "trastero", …],
  "confidence": 0.0-1.0
}`;

  return { stable, volatile: listingVolatile(vars) };
}

/** #38 — compare: structured side-by-side of N candidates. */
export function buildComparePrompt(vars: FlowVars): {
  stable: string;
  volatile?: string;
} {
  const stable = `${DOMAIN_PREAMBLE}

## Tarea: comparativa de candidatos

Compara los inmuebles que te doy **según la tesis de inversión del usuario**, no
según una idea genérica de "mejor". Un piso pequeño y barato puede ser el mejor
candidato para alquiler y el peor para uso propio.

Sé concreto y comparativo: "un 18% más caro por m² que el candidato B" es útil;
"buena relación calidad-precio" no lo es. Si dos candidatos son equivalentes en
un criterio, dilo en vez de forzar una diferencia.

${ASSESSMENT_RULES}

Formato de salida:
{
  "ranking": [
    {
      "property_id": number,
      "rank": 1,
      "rationale": "por qué ocupa esta posición, en una o dos frases"
    }
  ],
  "dimensions": [
    {
      "name": "precio_por_m2" | "estado" | "ubicacion" | "potencial_alquiler" | string,
      "verdict": "resumen comparativo de una frase"
    }
  ],
  "caveats": ["lo que NO se puede saber con los datos disponibles"],
  "confidence": 0.0-1.0
}`;

  const candidates = vars.candidates ?? [];
  const volatile = candidates.length
    ? [
        vars.profileThesis
          ? `### TESIS DE INVERSIÓN DEL USUARIO\n${vars.profileThesis}`
          : "",
        ...candidates.map((c, i) => formatListing(c, `CANDIDATO ${i + 1}`)),
      ]
        .filter(Boolean)
        .join("\n\n")
    : undefined;

  return { stable, volatile };
}

/** #29 — chat: conversational search over the ingested data. */
export function buildChatPrompt(vars: FlowVars): {
  stable: string;
  volatile?: string;
} {
  const scope = vars.profileName
    ? `\n\nLa conversación está enmarcada en el perfil de búsqueda **${vars.profileName}**${
        vars.profileId ? ` (id ${vars.profileId})` : ""
      }. Cuando el usuario diga "mis candidatos" o "esta búsqueda", se refiere a ese perfil.`
    : "";

  const titleRule = isAgenticToolsEnabled()
    ? "\n7. En tu primera respuesta de cada conversación nueva, llama a la herramienta `set_title` con un título conciso de 5-7 palabras en español."
    : "";

  const stable = `${DOMAIN_PREAMBLE}${scope}

## Tarea: responder preguntas sobre los datos

Respondes preguntas del inversor sobre los anuncios ya ingeridos, consultando la
base de datos con las herramientas disponibles.

Reglas:
1. **Consulta antes de afirmar.** Si la respuesta depende de los datos, ejecuta
   una consulta; no respondas de memoria ni por intuición.
2. Inspecciona el esquema real (\`list_tables\` / \`describe_table\`) antes de
   escribir SQL contra tablas que no conozcas. No adivines nombres de columnas.
3. Solo lectura: \`SELECT\` / \`WITH\`. Nunca \`INSERT\`, \`UPDATE\`, \`DELETE\`
   ni DDL.
4. Da cifras concretas y di de dónde salen. Si una consulta devuelve pocas filas
   o ninguna, dilo tal cual en vez de rellenar el hueco.
5. Recuerda que los datos son un espejo de portales públicos: pueden estar
   incompletos o desactualizados. Cuando eso afecte a la respuesta, adviértelo.
6. Responde en español, de forma directa y breve.${titleRule}

${buildSchemaContext()}`;

  return { stable };
}

// ── Main dispatch ─────────────────────────────────────────────────────────────

/**
 * Build the system prompt for a given flow.
 *
 * Returns `{ stable, volatile? }`. `stable` is the cache-friendly prefix;
 * `volatile` carries the per-request payload (the listing under assessment, the
 * candidates being compared).
 *
 * An unknown flow returns an empty prompt rather than throwing: assembleRequest
 * is the single seam every LLM call passes through, and a bad flow name should
 * degrade to an obviously-useless answer, not a 500 inside a background turn.
 * `isLlmFlow()` from ./types is available for callers that want to validate up
 * front.
 */
export function buildSystemPrompt(
  flow: string,
  vars: FlowVars,
): { stable: string; volatile?: string } {
  switch (flow) {
    case "occupancy":
      return buildOccupancyPrompt(vars);
    case "condition":
      return buildConditionPrompt(vars);
    case "redflags":
      return buildRedflagsPrompt(vars);
    case "extract":
      return buildExtractPrompt(vars);
    case "compare":
      return buildComparePrompt(vars);
    case "chat":
      return buildChatPrompt(vars);
    default:
      return { stable: "" };
  }
}
