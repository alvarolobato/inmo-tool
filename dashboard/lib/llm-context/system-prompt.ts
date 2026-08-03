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
    // Emitted so the model can name which advert a quote came from: a
    // deduplicated property carries several listings with different text, and
    // `evidence_source` in an assessment's output has to identify one of them
    // for the investor to be able to go and check the claim (issue #1 §9).
    field("id_anuncio", l.listingId),
    field("portal", l.source),
    field("operacion", l.operation),
    field("tipo_inmueble", l.propertyType),
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

/**
 * Volatile payload for a property-level assessment: every live listing of one
 * deduplicated property, each labelled with its portal (#25).
 *
 * Falls back to the single-listing payload when the caller passed only
 * `listing`, so flows that have not yet moved to property-level assessment
 * keep working unchanged.
 */
function propertyVolatile(vars: FlowVars): string | undefined {
  const listings = vars.listings ?? [];
  if (listings.length === 0) return listingVolatile(vars);

  const header =
    listings.length > 1
      ? `Los ${listings.length} anuncios siguientes son del MISMO inmueble físico, ` +
        `publicados en portales distintos. Sus descripciones se contradicen a ` +
        `veces y se complementan casi siempre.`
      : `Anuncio único de este inmueble.`;

  return [
    `### ANUNCIOS DEL INMUEBLE`,
    header,
    "",
    ...listings.map((l, i) =>
      formatListing(l, `ANUNCIO ${i + 1} DE ${listings.length} — portal: ${l.source ?? "desconocido"}`),
    ),
  ].join("\n\n");
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
//
// ENUM LANGUAGE CONVENTION (applies to every value a flow emits into
// ai_assessment.result, and to any enum added by #25–#30):
//
//   English  — generic system state, the same idea in any market:
//              occupancy `vacant`/`tenanted`/`unknown`, condition `unclear`,
//              redflags `other`, and in the schema listing.status, operation,
//              pipeline_stage, score_kind, feedback_type.
//   Spanish  — Spanish real-estate/legal market categories, where translating
//              loses a real distinction: condition `obra_nueva` /
//              `reformado` / `a_reformar`, occupancy's transaction
//              (`compraventa`/`venta_deuda`) and ownership
//              (`pleno_dominio`/`nuda_propiedad`/`proindiviso`/…) axes,
//              redflags' `herencia_yacente`/`deuda_comunidad`/
//              `construccion_ilegal`, and in the schema property_type
//              (`piso`, `atico`, …) and listing_kind (`particular`).
//
// The #145 axes are Spanish end-to-end because every value on them is a named
// Spanish legal instrument, not a generic state: `nuda_propiedad` is not
// "partial ownership" (that would also cover `proindiviso`, a completely
// different thing — a share of the whole vs. the whole minus the usufruct),
// and `venta_deuda` is not "debt sale" in any transferable sense — it is a
// specific conveyance of a creditor position under Spanish law. Likewise
// redflags' `herencia_yacente` is not "pending inheritance" (a vaguer English
// phrase that doesn't name the specific Spanish probate state) and
// `construccion_ilegal` is not "illegal construction" once you need it to
// also cover "fuera de ordenación" (a distinct planning-law status, not
// simply "illegal"). `unknown`/`unclear`/`other` stay English on every axis:
// they are system state ("we don't know" / "doesn't fit a named category"),
// not a market category.
//
// This is the rule the existing schema already follows, not a new one, and
// it's why occupancy, condition and redflags all keep their category values
// in Spanish while the "nothing to report" value stays English. Values stay
// machine-readable and stable; Spanish *display* labels belong at render
// time — see lib/listing-status-labels.ts for that pattern.

/**
 * #25 + #145 — what do I actually get if I buy this?
 *
 * THREE INDEPENDENT AXES, not one enum. All three are reasons a property is
 * priced far below apparent market value, they are **not** mutually exclusive,
 * and a flat enum would make real listings unrepresentable — "piso okupado, se
 * vende el 50% en proindiviso mediante cesión de crédito" is all three at once.
 * Surfacing that flat as a bargain without flagging why it is cheap is the
 * single most misleading thing this tool could do, so each axis carries its own
 * verdict, confidence and cited evidence (#145):
 *
 *   occupancy   — can I take possession?      vacant / tenanted / occupied_illegally
 *   transaction — what instrument am I buying? compraventa / venta_deuda
 *   ownership   — how much of the right?       pleno_dominio / nuda_propiedad / …
 *
 * Division of labour with #27 (redflags): this flow answers *what is being
 * sold*, redflags answers *what a lawyer should check*. `proindiviso`
 * legitimately appears in both — same underlying fact, two different questions —
 * so neither flow should be trimmed to avoid the overlap.
 */
export function buildOccupancyPrompt(vars: FlowVars): {
  stable: string;
  volatile?: string;
} {
  const stable = `${DOMAIN_PREAMBLE}

## Tarea: ¿qué se compra exactamente y se puede poseer?

Tienes que responder a TRES preguntas independientes sobre el mismo inmueble.
Las tres son motivos por los que un inmueble aparece muy por debajo de precio de
mercado, y **pueden darse a la vez**: un mismo anuncio puede ser una venta de
deuda, de una participación del 50%, y encima estar okupado. No elijas "la más
importante": responde a las tres por separado.

---

### Eje 1 — Ocupación (\`occupancy.status\`)

¿Se entrega **libre de inquilinos** u **ocupado**? Un inversor que necesita
posesión inmediata no puede comprar un inmueble con inquilino, y "ocupado
ilegalmente" es un riesgo legal grave, no una ganga.

- \`vacant\` — libre, disponible para entrar a vivir.
- \`tenanted\` — alquilado con contrato vigente ("vendido con inquilino",
  "rentabilidad garantizada", "actualmente alquilado por X€/mes").
- \`occupied_illegally\` — ocupación sin título ("ocupado", "okupas",
  "se vende con ocupantes", "posesión no garantizada").
- \`unknown\` — el anuncio no lo dice.

Señales que debes tener en cuenta antes de decidir \`vacant\`: fotos con enseres
personales, muebles y ropa; menciones a "se entrega vacío en la firma"; precio
muy por debajo de mercado sin explicación.

Ten en cuenta la \`operacion\` del anuncio. En un anuncio de **alquiler**
("operacion: rent"), que el inmueble esté actualmente arrendado es lo normal y
no dice nada del riesgo que le importa al inversor. La distinción
vacant/tenanted sólo es decisiva en anuncios de **venta** ("operacion: sale").

**El silencio NO es prueba de \`vacant\`.** Que un inquilino no se mencione es
lo más habitual del mundo. Sin señal, \`unknown\`.

---

### Eje 2 — Qué se transmite (\`transaction.kind\`)

¿Se vende el **inmueble** o se vende el **crédito** que pesa sobre él?

- \`compraventa\` — compraventa normal del inmueble. Es el caso por defecto.
- \`venta_deuda\` — lo que se transmite es la posición acreedora, no la
  propiedad: compras la deuda/el préstamo y todavía tienes que terminar la
  ejecución hipotecaria y lograr la posesión. Señales: "venta de deuda",
  "se vende la deuda", "cesión de crédito", "cesión de remate", "crédito
  hipotecario", "adjudicación pendiente", "posición acreedora".
- \`unknown\` — el texto es ambiguo y no puedes decidir.

Frecuente en portales de bancos y servicers (Solvia, Servihabitat, Vivantial).
Es una diferencia material: NO adquieres el inmueble en la firma.

---

### Eje 3 — Cuánto derecho se transmite (\`ownership.extent\`)

¿Se vende el pleno dominio del 100%, o sólo una parte o un derecho limitado?

- \`pleno_dominio\` — propiedad plena y completa. Es el caso por defecto.
- \`nuda_propiedad\` — se vende la nuda propiedad; alguien conserva el usufructo
  vitalicio y por tanto el uso. No puedes ocuparlo ni alquilarlo hasta que se
  extinga el usufructo. Señales: "nuda propiedad", "con usufructuario".
- \`usufructo\` — se vende sólo el usufructo, no la propiedad.
- \`proindiviso\` — se vende una cuota indivisa en copropiedad: "proindiviso",
  "pro indiviso", "participación indivisa", "50% de la vivienda", "mitad
  indivisa", "una cuota del inmueble".
- \`derecho_superficie\` — derecho de superficie, no propiedad del suelo.
- \`unknown\` — el texto es ambiguo y no puedes decidir.

Si el anuncio dice qué porcentaje se vende ("el 50%", "una tercera parte"),
ponlo en \`ownership.share_pct\` como número (50, 33.33). Si no lo dice, \`null\`.

---

### Cómo tratar el silencio en los ejes 2 y 3 (importante, y distinto del eje 1)

En los ejes 2 y 3 el silencio **sí** es información. Nadie vende una deuda ni
una nuda propiedad sin anunciarlo: es precisamente el motivo por el que el
precio es bajo, y ocultarlo invalidaría la operación. Por eso, si ninguno de los
anuncios menciona nada parecido, responde \`compraventa\` y \`pleno_dominio\` con
una \`confidence\` moderada (~0.6-0.7) y \`evidence\` vacía, en lugar de
\`unknown\`. Reserva \`unknown\` para cuando el texto sugiera algo raro pero no
te permita concretar.

Esto es lo contrario del eje 1, donde el silencio obliga a \`unknown\`.

---

### Varios anuncios del mismo inmueble

Puede que te dé **varios anuncios del mismo inmueble físico** publicados en
portales distintos. No los evalúes por separado: emite UN solo veredicto para el
inmueble, usando todos los textos como pruebas de una misma realidad.

Reglas cuando las descripciones no coinciden (valen para los tres ejes):
1. **Una mención concreta gana al silencio.** Si un portal dice "se vende con
   inquilino" y los otros no dicen nada, el inmueble está \`tenanted\`. Que un
   anuncio lo omita no es prueba de que esté libre — es lo que suele pasar,
   porque un vendedor puede preferir no destacarlo. Lo mismo con "cesión de
   crédito" o "nuda propiedad": basta que UN anuncio lo diga.
2. **Entre dos menciones concretas que se contradicen**, quédate con la más
   específica y reciente (una fecha de contrato, un importe de renta) y baja la
   \`confidence\`. Explica la contradicción en \`reasoning\`.
3. \`evidence\` debe citar UN anuncio concreto, y \`evidence_source\` debe decir
   de qué portal salió esa cita, para que el inversor pueda ir a comprobarlo.
   Cada eje cita su propia prueba: la frase que demuestra la ocupación no suele
   ser la misma que demuestra que es una venta de deuda.

${ASSESSMENT_RULES}

**Excepción a las reglas 2 y 3 anteriores, SOLO para los ejes 2 y 3 (transacción
y propiedad):** ya se explicó arriba por qué, en esos dos ejes, el silencio de
todos los anuncios es evidencia suficiente de \`compraventa\`/\`pleno_dominio\`
con confidence ~0.6-0.7 y evidence vacía — no es "información insuficiente", es
la ausencia de una revelación obligatoria. Aplica esa excepción exactamente
como se describió: NO respondas \`unknown\` en los ejes 2 o 3 solo porque no hay
cita que ofrecer. Las reglas 2 y 3 de arriba siguen aplicando SIN excepción al
eje 1 (ocupación): ahí el silencio sigue obligando a \`unknown\`.

Formato de salida (los tres ejes SIEMPRE presentes, aunque sean el caso por
defecto — nunca omitas una clave):
{
  "occupancy": {
    "status": "vacant" | "tenanted" | "occupied_illegally" | "unknown",
    "confidence": 0.0-1.0,
    "evidence": "cita literal del anuncio, o \\"\\" si no hay",
    "evidence_source": "portal del que sale la cita (p. ej. \\"fotocasa\\"), o null"
  },
  "transaction": {
    "kind": "compraventa" | "venta_deuda" | "unknown",
    "confidence": 0.0-1.0,
    "evidence": "cita literal, o \\"\\" si no hay",
    "evidence_source": "portal de la cita, o null"
  },
  "ownership": {
    "extent": "pleno_dominio" | "nuda_propiedad" | "usufructo" | "proindiviso" | "derecho_superficie" | "unknown",
    "share_pct": 50 | null,
    "confidence": 0.0-1.0,
    "evidence": "cita literal, o \\"\\" si no hay",
    "evidence_source": "portal de la cita, o null"
  },
  "reasoning": "dos o tres frases en español explicando el conjunto"
}`;

  return { stable, volatile: propertyVolatile(vars) };
}

/**
 * #26 — condition: renovation state, per deduplicated property.
 *
 * Same property-level pattern as occupancy (#25): every live listing of the
 * property is read together, because the flat's actual condition doesn't
 * change per portal, and one advert saying "a reformar" while a sibling stays
 * silent must not be missed (#156-review carryover, see occupancy.ts).
 *
 * Unlike occupancy's ejes 2/3, condition has NO silence-implies-default rule:
 * there is no market convention under which a seller who doesn't mention
 * condition therefore has a renovated flat. Silence stays `unclear` — the
 * same rule as occupancy's eje 1.
 */
export function buildConditionPrompt(vars: FlowVars): {
  stable: string;
  volatile?: string;
} {
  const stable = `${DOMAIN_PREAMBLE}

## Tarea: estado de conservación

Clasifica el estado del inmueble para estimar si necesita reforma. Un inversor
de "comprar y reformar" busca precisamente los que están mal; uno de "comprar
y alquilar ya" busca lo contrario.

Categorías (\`condition\`):
- \`obra_nueva\` — promoción nueva, a estrenar, sin usar.
- \`reformado\` — reformado recientemente ("reformado en 2023", "a estrenar
  tras reforma integral", "calidades de lujo"), listo para entrar sin obra.
- \`a_reformar\` — necesita reforma, de cualquier calibre, para ser habitable
  o competitivo: instalaciones antiguas, baño/cocina a renovar, humedades,
  reforma integral o estructural. No distingas cosmético de estructural en la
  categoría — usa \`issues\` para eso.
- \`unclear\` — el anuncio no da información suficiente para decidir.

**El silencio NO es prueba de \`reformado\`.** Que un anuncio no mencione el
estado es lo más habitual del mundo, y no hay ninguna convención de mercado
por la que el silencio implique que el inmueble está reformado. Sin señal,
\`unclear\`.

Ojo con el lenguaje comercial: "con encanto", "para actualizar", "con
posibilidades", "ideal inversores" suelen indicar que hay obra por hacer.
Anota esa tensión en \`reasoning\` si la detectas.

### Varios anuncios del mismo inmueble

Puede que te dé varios anuncios del mismo inmueble físico en portales
distintos. No los evalúes por separado: emite UN solo veredicto para el
inmueble. Una mención concreta de un problema (humedad, instalación antigua)
gana al silencio de los demás anuncios — que otro portal no lo mencione no es
prueba de que no exista, es lo habitual cuando un vendedor prefiere no
destacarlo. \`evidence\` debe citar UN anuncio concreto y \`evidence_source\`
debe decir de qué portal salió esa cita, para que el inversor pueda ir a
comprobarlo.

${ASSESSMENT_RULES}

Formato de salida:
{
  "condition": "obra_nueva" | "reformado" | "a_reformar" | "unclear",
  "confidence": 0.0-1.0,
  "issues": ["problemas concretos citados: humedades, instalación eléctrica antigua, necesita baño nuevo, …"],
  "evidence": "cita literal del anuncio, o \\"\\" si no hay",
  "evidence_source": "portal del que sale la cita (p. ej. \\"fotocasa\\"), o null",
  "reasoning": "una o dos frases en español"
}`;

  return { stable, volatile: propertyVolatile(vars) };
}

/**
 * #27 — redflags: legal / financial risk extraction, per deduplicated
 * property.
 *
 * Same property-level pattern as occupancy/condition — see their doc
 * comments. This flow has the highest cost for a false positive of the
 * three (issue #27, EC-3): a fabricated legal risk erodes trust in the whole
 * tool. The prompt therefore leans harder on "only what's actually stated",
 * and `parseRedFlagsResult` (lib/ai-assessment/redflags.ts) backs it up in
 * code by dropping any flag without a literal citation.
 *
 * Deliberate overlap with #25's `ownership.proindiviso` — see
 * lib/ai-assessment/redflags.ts's module doc for why both flows keep it.
 */
export function buildRedflagsPrompt(vars: FlowVars): {
  stable: string;
  volatile?: string;
} {
  const stable = `${DOMAIN_PREAMBLE}

## Tarea: señales de alerta legales y financieras

Extrae menciones que un inversor debería revisar con un abogado ANTES de hacer
una oferta. NO estás dando asesoramiento legal ni emitiendo un veredicto legal:
estás señalando qué hay que comprobar. Cada hallazgo se presentará al usuario
como "el anuncio menciona X — verifícalo de forma independiente", nunca como
un hecho legal confirmado.

Tipos (\`type\`):
- \`embargo\` — embargo, subasta judicial, deuda con garantía sobre el inmueble.
- \`herencia_yacente\` — herencia yacente, herencia pendiente de partición,
  varios herederos/propietarios sin repartir. (Nota: si lo que se vende es una
  cuota indivisa ya definida, sin mención de un proceso de herencia sin
  resolver, es \`ownership.proindiviso\` en el flujo de ocupación — #25 — no
  esto. Aquí lo que importa es si la titularidad está todavía sin resolver.)
- \`deuda_comunidad\` — derramas pendientes, deudas con la comunidad de
  propietarios.
- \`construccion_ilegal\` — ampliación o construcción no legalizada, fuera de
  ordenación, sin licencia.
- \`litigio\` — procedimiento judicial en curso sobre el inmueble.
- \`other\` — cualquier otro riesgo legal o financiero relevante citado
  explícitamente, que no encaje en las categorías anteriores.

### Regla central: NO especules a partir del silencio

Marca SOLO lo que el texto dice explícitamente o implica con fuerza. La
AUSENCIA de una declaración ("libre de cargas") no es prueba de que exista un
problema — es simplemente que el anuncio no lo menciona, como el 99% de los
anuncios. Fabricar un hallazgo a partir del silencio es el fallo más caro de
este flujo: erosiona la confianza en toda la herramienta. Si dudas, no lo
incluyas.

### Varios anuncios del mismo inmueble

Si te doy varios anuncios del mismo inmueble físico, trátalos como una sola
fuente de evidencia: basta que UN anuncio mencione un riesgo para incluirlo.
\`evidence\` debe citar el anuncio concreto donde aparece, y \`evidence_source\`
debe decir de qué portal sale esa cita.

${ASSESSMENT_RULES}

Formato de salida:
{
  "flags": [
    {
      "type": "embargo" | "herencia_yacente" | "deuda_comunidad" | "construccion_ilegal" | "litigio" | "other",
      "description": "qué debería comprobar el inversor, una frase",
      "evidence": "cita literal del anuncio en la que te apoyas",
      "evidence_source": "portal del que sale la cita, o null"
    }
  ],
  "confidence": 0.0-1.0,
  "reasoning": "una o dos frases en español"
}

Si no hay ninguna señal, devuelve \`{"flags": [], "confidence": <n>, "reasoning": "..."}\`.
Una lista vacía es un resultado correcto y frecuente — NO fuerces hallazgos.`;

  return { stable, volatile: propertyVolatile(vars) };
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
