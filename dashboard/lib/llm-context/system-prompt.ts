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
import type {
  FlowVars,
  ListingSnapshot,
  RedflagTrendingCandidate,
  DismissedCandidate,
} from "./types";
import {
  REDFLAG_TYPES,
  REDFLAG_LABELS,
  REDFLAG_DEFINITIONS,
} from "@/lib/ai-assessment/redflag-vocabulary";
// #407 — cross-axis vocabularies, imported from LEAF modules (no `pg`/LLM
// imports) so rendering them into the redflags prompt does not create the
// system-prompt → axis → llm → llm-context cycle. These arrays are the single
// source of truth: adding a value makes it appear in the prompt automatically.
import {
  OCCUPANCY_STATUSES,
  TRANSACTION_KINDS,
  OWNERSHIP_EXTENTS,
} from "@/lib/ai-assessment/occupancy-vocabulary";
import { CONDITION_CATEGORIES } from "@/lib/ai-assessment/condition-vocabulary";
import { BEACH_PROXIMITIES } from "@/lib/ai-assessment/location-vocabulary";
import { OPPORTUNITY_SIGNALS } from "@/lib/ai-assessment/opportunity-vocabulary";

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

/**
 * Fields deliberately excluded from `computeAssessmentContentHash`
 * (`lib/ai-assessment/cache.ts`) — price, built/useful m², rooms, bathrooms,
 * floor, and photo count. Appended to the volatile payload of every cached,
 * property-level flow so the model is told explicitly why those facts are
 * absent, rather than silently missing with no explanation — see
 * `formatListing`'s `hashCoveredOnly` option and cache.ts's module doc
 * ("Corrected: what the model is actually shown") for the full rationale.
 */
const HASH_SCOPE_NOTE =
  '\n\n(Nota: precio, m² construidos/útiles, habitaciones, baños, planta y ' +
  "número de fotos no se incluyen aquí a propósito — esta evaluación se cachea " +
  "por contenido y esos campos no forman parte de esa clave, así que no los " +
  "uses como señal ni asumas un valor visto en una consulta anterior.)";

/**
 * Instructs the model how to weigh `vars.areaPriceSignal` when present — the
 * derived, bucketed zone-median price comparison from #32/#184 (see
 * `lib/ai-assessment/price-signal.ts` for how it's computed, bucketed, and
 * why only occupancy and redflags receive it). Appended to the STABLE part
 * of both prompts — identical every request, whether or not this particular
 * property actually has a signal to show — so this never breaks OpenRouter
 * prompt caching; only the actual figure (in `volatile`, when present) varies.
 *
 * Placed AFTER `${ASSESSMENT_RULES}` in both callers, matching the ordering
 * rule this file already established for occupancy's ejes-2/3 exception: a
 * rule stated earlier loses to a contradicting or clarifying rule stated
 * later when the model resolves the two by recency, so anything that must
 * win has to be the LAST word in the assembled string, not just present
 * somewhere in it (see occupancy.test.ts's index-based assertion for the
 * existing example this follows).
 *
 * Two rules the model must not blur, because both are load-bearing for
 * #184's requirement 5 ("below market is a prompt for scrutiny, not proof"):
 *
 *   1. This text is NOT a quote from any advert — it must never be cited as
 *      `evidence` (which `ASSESSMENT_RULES` rule 3, and redflags.ts's
 *      `parseFlag`, both define as a literal quote from the ad text). Citing
 *      it as evidence would fabricate a citation that doesn't exist in the
 *      source material.
 *   2. It must never, by itself, justify a finding (a red flag, an
 *      `occupied_illegally` verdict). It only raises how hard the model
 *      should look for an actual, citable disclosure in the ad text — a
 *      below-market price has innocent explanations (a motivated seller, a
 *      poor floor, a bad orientation) exactly as often as it has concerning
 *      ones.
 */
const AREA_PRICE_SIGNAL_RULES = `
### Contexto de precio de zona (dato derivado, NO texto del anuncio)

Más abajo puede aparecer una comparación de precio frente a la zona,
calculada a partir de inmuebles comparables reales (no el precio exacto del
anuncio, que sigue sin mostrarse — ver nota anterior). No aparece siempre: si
no hay comparables suficientes en la zona, o si el precio no está claramente
por debajo de la mediana, simplemente no se te muestra nada al respecto —
eso NO significa que el precio sea normal, solo que no hay una comparación
que aportar.

Cuando SÍ aparezca, trátala con dos reglas estrictas:
1. NO la cites como \`evidence\`. \`evidence\` sigue significando
   exclusivamente una cita literal del texto del anuncio — citar este dato
   como si fuera texto del anuncio sería fabricar una cita.
2. NO la uses, por sí sola, para justificar un hallazgo. Es contexto para
   decidir cuánto escrutinio aplicar al resto del texto, no una prueba: un
   precio por debajo de la mediana de la zona tiene explicaciones inocentes
   (vendedor con prisa, planta baja, mala orientación) tan a menudo como
   explicaciones de riesgo (embargo, venta de deuda, ocupación).`;

/**
 * Serialise a listing for the volatile part of a prompt.
 *
 * `hashCoveredOnly`, when true, omits every field
 * `computeAssessmentContentHash` (cache.ts) does NOT cover: price, m²
 * built/useful, rooms, bathrooms, floor, photo count. Every property-level
 * cached flow (occupancy/condition/redflags/extract, via `propertyVolatile`)
 * passes it — a cache-invalidation key that ignores a field must never be
 * paired with a prompt that shows the model that same field, or a genuine
 * change becomes invisible to the cache while still changing the model's
 * answer, freezing a stale verdict indefinitely (#30 review finding). `false`
 * (the default) is for flows the #30 cache doesn't wrap — currently only
 * `compare` (#38) — where showing the full listing is correct because there
 * is no cache key that could go stale against it.
 */
function formatListing(
  l: ListingSnapshot,
  label = "ANUNCIO",
  opts: { hashCoveredOnly?: boolean } = {},
): string {
  const field = (k: string, v: unknown): string | null =>
    v === undefined || v === null || v === "" ? null : `${k}: ${String(v)}`;

  const restricted = opts.hashCoveredOnly ?? false;

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
    restricted ? null : field("precio_eur", l.price),
    restricted ? null : field("m2_construidos", l.m2Built),
    restricted ? null : field("habitaciones", l.rooms),
    restricted ? null : field("banos", l.bathrooms),
    restricted ? null : field("planta", l.floor),
    field("direccion", l.address),
    field("ciudad", l.city),
    field("provincia", l.province),
    field("ano_construccion", l.yearBuilt),
    field("certificado_energetico", l.energyRating),
    l.features?.length ? `caracteristicas: ${l.features.join(", ")}` : null,
    restricted ? null : l.photoUrls?.length ? `num_fotos: ${l.photoUrls.length}` : null,
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

/**
 * Shared volatile payload for the four single-listing, CACHED assessment
 * flows (occupancy/condition/redflags/extract) — `hashCoveredOnly: true`
 * because every caller of this function feeds a #30 `getOrCompute()` call.
 * See `formatListing`'s doc for why that flag exists.
 */
function listingVolatile(vars: FlowVars): string | undefined {
  if (vars.listing) {
    return formatListing(vars.listing, "ANUNCIO", { hashCoveredOnly: true }) + HASH_SCOPE_NOTE;
  }
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
 *
 * Every caller of `propertyVolatile` (occupancy/condition/redflags/extract)
 * is wrapped in the #30 cache, so `formatListing` is always called with
 * `hashCoveredOnly: true` here — see its doc and `HASH_SCOPE_NOTE`.
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

  return (
    [
      `### ANUNCIOS DEL INMUEBLE`,
      header,
      "",
      ...listings.map((l, i) =>
        formatListing(
          l,
          `ANUNCIO ${i + 1} DE ${listings.length} — portal: ${l.source ?? "desconocido"}`,
          { hashCoveredOnly: true },
        ),
      ),
    ].join("\n\n") + HASH_SCOPE_NOTE
  ); // note: the `listings.length === 0` fallback above already returns
  // (via listingVolatile) with its own copy of HASH_SCOPE_NOTE appended.
}

/**
 * Renders `vars.areaPriceSignal` (#184) as its own labelled block, appended
 * to the volatile payload of the flows that use it. Returns "" when absent —
 * concatenation-safe, and matches the "say nothing" contract
 * `buildAreaPriceSignal` (price-signal.ts) itself follows: an absent signal
 * must never render as a placeholder or a null-shaped sentence.
 */
function areaPriceSignalVolatile(vars: FlowVars): string {
  if (!vars.areaPriceSignal) return "";
  return `\n\n### DATO DERIVADO: PRECIO VS. ZONA\n${vars.areaPriceSignal}`;
}

/**
 * `propertyVolatile(vars)` with `vars.areaPriceSignal` appended, for the two
 * flows that render it (occupancy, redflags — #184). Every other caller of
 * `propertyVolatile` (condition, extract) uses that function directly and
 * never sees this block, by construction — see price-signal.ts's doc for why.
 */
function propertyVolatileWithAreaPrice(vars: FlowVars): string | undefined {
  const base = propertyVolatile(vars);
  if (base === undefined) return undefined;
  return base + areaPriceSignalVolatile(vars);
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

Señales que debes tener en cuenta antes de decidir \`vacant\`: menciones a "se
entrega vacío en la firma", o descripciones textuales de enseres personales,
muebles o ropa todavía presentes en la vivienda. El precio exacto del
anuncio NO se te muestra en este flujo (ver nota al final del bloque de
anuncios) — no lo uses como señal aunque lo hayas visto en una consulta
anterior: una rebaja de precio no es, por sí sola, evidencia de ocupación.
(Excepción explícita a esto, ver el bloque "Contexto de precio de zona" al
final: si se te da una comparación de precio frente a la zona, síguela con
las reglas que la acompañan — no es el precio del anuncio y no cambia lo
dicho aquí.)

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
${AREA_PRICE_SIGNAL_RULES}

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

  return { stable, volatile: propertyVolatileWithAreaPrice(vars) };
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
 *
 * ## `reformado`'s boundary, tightened (#168 review, judgement call)
 *
 * The reviewer found the original wording ("reformado recientemente…listo
 * para entrar sin obra") didn't partition the real cases: a habitable,
 * unremarkable, not-recently-renovated flat ("piso en buen estado, listo
 * para entrar") satisfies the second half and fails the first — and that's
 * arguably the single most common state in the Spanish market. Under the old
 * wording the model had to guess between `reformado` and `unclear`
 * non-deterministically for that population.
 *
 * Decision: keep the 4-value enum (the issue specifies exactly these four —
 * not something to change unilaterally in a review-fix pass), but redefine
 * `reformado`'s boundary so it partitions cleanly: the axis that matters for
 * an investor is "does this need money spent on it before it can be used or
 * rented", not "when was it last renovated". So `reformado` now means "no
 * reform needed", covering BOTH an explicit recent renovation AND a merely
 * well-kept older flat with no reform pending. That collapses two states an
 * investor treats identically (zero capex) into one category, and leaves
 * `unclear` meaning what it should: "the text doesn't say enough to tell
 * whether it needs work or not" — not "it's fine but I can't prove when it
 * was fixed up". A finer split (recently-renovated-with-premium-finishes vs.
 * generic-move-in-ready) would need a 5th value; noted on issue #26 for the
 * owner if that granularity turns out to matter for scoring later.
 *
 * ## `renovation_severity` sub-axis on `a_reformar` (#313, D-056)
 *
 * The base 4-value enum stays flat, but `a_reformar` now also carries a
 * `renovation_severity` grading the DEPTH of work — `leve` (cosmetic) vs
 * `integral` (structural/whole-systems) vs `unknown` (needs work, text can't
 * grade it). This is what unblocks #45's refurb cost bands: light and heavy
 * reform sit in the same category but map to very different money. It is a
 * prompt/parsing split off the SAME evidence the base verdict already
 * requires — NOT a second speculative pass — so the same "cite it or don't
 * assert it" discipline applies (see `parseRenovationSeverity` in
 * `lib/ai-assessment/condition.ts`, which degrades an ungradeable
 * `a_reformar` to `unknown` rather than guessing). The field is only
 * meaningful for `a_reformar`; the parser forces it to `null` for every other
 * verdict, so `reformado`/`obra_nueva`/`unclear` are unchanged.
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

Categorías (\`condition\`) — el eje que decide la categoría es **"¿hay que
meter dinero en obra antes de poder usarlo o alquilarlo?"**, no "¿cuándo se
reformó por última vez?":
- \`obra_nueva\` — promoción nueva, a estrenar, sin usar.
- \`reformado\` — **no necesita obra**: se puede entrar a vivir o alquilar tal
  cual. Incluye tanto una reforma reciente explícita ("reformado en 2023", "a
  estrenar tras reforma integral", "calidades de lujo") COMO un piso
  simplemente en buen estado que nadie describe como "reformado" pero que
  tampoco necesita nada ("piso en buen estado, listo para entrar",
  "conservado", "para entrar a vivir ya"). Este segundo caso es el más
  habitual del mercado español — no lo empujes a \`unclear\` solo porque el
  anuncio no usa la palabra "reformado": lo que importa es la ausencia de obra
  pendiente, no la fecha de la última reforma.
- \`a_reformar\` — necesita reforma, de cualquier calibre, para ser habitable
  o competitivo: instalaciones antiguas, baño/cocina a renovar, humedades,
  reforma integral o estructural.
- \`unclear\` — el anuncio no da información suficiente para decidir si
  necesita obra o no (ni lo dice ni da pistas indirectas de un lado u otro).

### Calibre de la reforma (\`renovation_severity\`) — SOLO si \`condition\` es \`a_reformar\`

Cuando —y solo cuando— la categoría es \`a_reformar\`, gradúa la PROFUNDIDAD de
la obra en \`renovation_severity\`. Esto alimenta la estimación de coste de
reforma (comprar-y-reformar): "repintar y cambiar la cocina" y "reforma
estructural completa" caen ambas en \`a_reformar\` pero cuestan cosas muy
distintas.
- \`leve\` — reforma cosmética/ligera: pintura, actualizar cocina o baño,
  suelos, carpintería, acabados. Sin obra estructural ni de instalaciones
  completas ("a reformar, actualizar cocina y baño", "para dar un lavado de
  cara", "cambiar suelos").
- \`integral\` — reforma pesada/estructural: "reforma integral", menciones
  estructurales, varias instalaciones a cambiar (eléctrica + fontanería + …),
  dejar el piso en bruto, "para reformar integralmente", "necesita reforma
  completa".
- \`unknown\` — es \`a_reformar\` pero el texto no dice lo suficiente para
  graduar el calibre. Igual que con la categoría: no lo adivines. Si solo
  sabes que "hay que reformar" sin pistas de cuánto, usa \`unknown\`.

Aplica la MISMA disciplina de evidencia que a la categoría: gradúa el calibre
a partir de lo que el anuncio dice de verdad (la misma cita que sostiene el
veredicto sirve aquí), nunca de una suposición. Para cualquier otra categoría
(\`reformado\`, \`obra_nueva\`, \`unclear\`) NO emitas \`renovation_severity\`
o ponlo a \`null\` — no aplica.

**El silencio NO es prueba de \`reformado\`.** Que un anuncio no mencione el
estado es lo más habitual del mundo, y no hay ninguna convención de mercado
por la que el silencio implique que el inmueble no necesita obra. Sin señal,
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

**Nota sobre la regla 2 anterior:** en esta tarea, "no lo sé" se expresa con
\`unclear\`, no con \`unknown\` — \`unknown\` no es un valor válido de
\`condition\` y rompería el formato de salida. Usa \`unclear\` con una
\`confidence\` baja cuando el anuncio no dé información suficiente, tal y como
se explicó arriba.

Formato de salida:
{
  "condition": "obra_nueva" | "reformado" | "a_reformar" | "unclear",
  "renovation_severity": "leve" | "integral" | "unknown" | null,
  "confidence": 0.0-1.0,
  "issues": ["problemas concretos citados: humedades, instalación eléctrica antigua, necesita baño nuevo, …"],
  "evidence": "cita literal del anuncio, o \\"\\" si no hay",
  "evidence_source": "portal del que sale la cita (p. ej. \\"fotocasa\\"), o null",
  "reasoning": "una o dos frases en español"
}
(\`renovation_severity\` solo tiene sentido si \`condition\` es \`a_reformar\`;
en el resto de casos, \`null\`.)`;

  return { stable, volatile: propertyVolatile(vars) };
}

/**
 * #396 — render the closed vocabulary from the `REDFLAG_TYPES` enum + its labels
 * and one-line definitions, so the enum is the single source of truth: adding a
 * named type makes it appear here automatically, with no prose to edit (the
 * enum-render test enforces this). `other` is handled separately by the builder
 * because it also carries the `candidate_type` / trending mechanics, so it is
 * excluded here — this list covers only the NAMED types.
 */
function renderRedflagVocabulary(): string {
  return REDFLAG_TYPES.filter((t) => t !== "other")
    .map((t) => `- \`${t}\` (${REDFLAG_LABELS[t] ?? t}) — ${REDFLAG_DEFINITIONS[t]}`)
    .join("\n");
}

/**
 * #396 — render the trending `other` candidate slugs the orchestrator computed
 * ONCE per batch and passed in (top-N by count). Handles the empty/cold-start
 * case explicitly: before any slug has been proposed often enough the model is
 * simply told there are none yet, and the prompt stays valid — that is the
 * normal initial state, not an error.
 */
function renderTrendingCandidates(candidates?: RedflagTrendingCandidate[]): string {
  if (!candidates || candidates.length === 0) {
    return (
      "Todavía no hay candidatos `candidate_type` propuestos con frecuencia " +
      "suficiente (es lo normal al principio). Si necesitas `other`, acuña un " +
      "slug nuevo siguiendo las reglas de arriba."
    );
  }
  const lines = candidates.map((c) => `- \`${c.candidateType}\` (${c.count})`).join("\n");
  return (
    "Estos slugs `candidate_type` YA se han propuesto antes para problemas " +
    "fuera del vocabulario cerrado (con su nº de apariciones). Si tu problema " +
    "encaja en uno de ellos, REUTILÍZALO tal cual en vez de acuñar un sinónimo:\n\n" +
    lines
  );
}

/**
 * #407 — sentinel values that are NOT mappable concepts, just "we don't know /
 * nothing here" system state on their axis. Excluded from the cross-axis
 * vocabulary render so the model is only pointed at real concepts to map to.
 */
const CROSS_AXIS_SENTINELS = new Set(["unknown", "unclear", "none"]);

/** Render an axis enum's mappable values (sentinels dropped) as a comma list. */
function renderAxisValues(values: readonly string[]): string {
  return values
    .filter((v) => !CROSS_AXIS_SENTINELS.has(v))
    .map((v) => `\`${v}\``)
    .join(", ");
}

/**
 * #407 — the FULL cross-axis vocabulary, rendered from every axis's enum (the
 * single source of truth — no duplicated prose). The owner saw the model coin
 * candidates (`sin_posesion`, `regimen_vpo`, `venta_deuda`, `nuda_propiedad`)
 * for concepts that ALREADY exist on their own axes, because the redflags prompt
 * only knew the redflags vocabulary. This block tells the model: if a finding
 * matches one of these existing concepts, it is captured by its own axis — do
 * NOT coin a `candidate_type` for it.
 *
 * Pure: renders whatever the enum arrays contain, so adding a value to any axis
 * makes it appear here automatically (the enum-render test enforces this).
 */
function renderCrossAxisVocabulary(): string {
  return `### Conceptos que YA existen en OTROS ejes de evaluación

Estos hallazgos NO son \`other\`: ya se capturan en su propio eje. Si tu hallazgo
encaja con uno de estos conceptos ya existentes, **NO acuñes un \`candidate_type\`**
— se registra en su eje, no como redflag. Reserva \`other\` + \`candidate_type\`
SOLO para un problema que no encaje ni en el vocabulario cerrado de redflags de
arriba ni en ninguno de estos ejes.

- **Ocupación** (eje \`occupancy.status\` — ¿se puede poseer?): ${renderAxisValues(OCCUPANCY_STATUSES)}
- **Transacción** (eje \`transaction.kind\` — ¿qué se transmite?): ${renderAxisValues(TRANSACTION_KINDS)}
- **Propiedad** (eje \`ownership.extent\` — ¿cuánto derecho se transmite?): ${renderAxisValues(OWNERSHIP_EXTENTS)}
- **Estado / conservación** (eje \`condition\`): ${renderAxisValues(CONDITION_CATEGORIES)}
- **Ubicación** (eje \`location\`): ${renderAxisValues(BEACH_PROXIMITIES)}, \`heritage_zone\`
- **Oportunidad** (eje \`opportunity\`): ${renderAxisValues(OPPORTUNITY_SIGNALS)}

**Distinción clave en ocupación (no la confundas):** \`occupied_illegally\`
(okupas, ocupación sin título) es el caso GRAVE; \`tenanted\` (alquilado, con un
inquilino que paga renta y contrato vigente) también es "sin posesión inmediata"
pero es MUCHO menos malo — es una rentabilidad, no un problema legal. Los dos ya
están cubiertos por el eje de ocupación: elige el valor correcto en ese eje en
vez de inventar un \`candidate_type\` como \`sin_posesion\`. Lo mismo con VPO
(\`is_vpo\`, eje oportunidad — no \`regimen_vpo\`), venta de deuda
(\`transaction.venta_deuda\`) y nuda propiedad (\`ownership.nuda_propiedad\`).`;
}

/**
 * #407 — render the `candidate_type` slugs a human reviewed on
 * `/admin/candidatos` and explicitly DISMISSED, so the model is told not to
 * propose them again. Handles the empty case explicitly (nothing dismissed yet
 * is the normal initial state, not an error). The reason, when present, is shown
 * so the model understands WHY it was rejected.
 */
function renderDismissedCandidates(dismissed?: DismissedCandidate[]): string {
  if (!dismissed || dismissed.length === 0) {
    return "Todavía no se ha rechazado ningún candidato.";
  }
  const lines = dismissed
    .map((d) => (d.reason ? `- \`${d.slug}\` — ${d.reason}` : `- \`${d.slug}\``))
    .join("\n");
  return (
    "Un humano YA revisó estos slugs `candidate_type` y decidió que NO son " +
    "categorías reales. NO los vuelvas a proponer como `candidate_type` (ni un " +
    "sinónimo de ellos): si tu hallazgo es ese mismo concepto rechazado, no lo " +
    "incluyas como `other`.\n\n" +
    lines
  );
}

/**
 * #27 / #361 / #396 — redflags: generic property-problem extraction, per
 * deduplicated property.
 *
 * Same property-level pattern as occupancy/condition — see their doc
 * comments. Originally legal/financial only (#27); #361 broadened it to also
 * flag PHYSICAL problems (`unfinished_construction`, `structural_damage`) that
 * fall through every other axis — a half-built shell is neither occupancy, nor
 * `a_reformar`, nor `obra_nueva`. This flow has the highest cost for a false
 * positive of the three (issue #27, EC-3): a fabricated risk erodes trust in
 * the whole tool. The prompt therefore leans harder on "only what's actually
 * stated", and `parseRedFlagsResult` (lib/ai-assessment/redflags.ts) backs it
 * up in code by dropping any flag without a literal citation — the same
 * evidence discipline applies to physical flags.
 *
 * Deliberate overlap with #25's `ownership.proindiviso` — see
 * lib/ai-assessment/redflags.ts's module doc for why both flows keep it.
 *
 * #396 (Fase 7 of #385): the closed vocabulary is now RENDERED from the
 * `REDFLAG_TYPES` enum (`renderRedflagVocabulary`) rather than duplicated as
 * fixed prose, and the top-N trending `other` `candidate_type` slugs seen so
 * far (`vars.trendingCandidates`, computed once per batch by the orchestrator)
 * are injected so the model reuses an existing candidate before coining a
 * synonym. The builder stays PURE: it renders whatever list it is handed and
 * never queries the DB. The trending block sits in `stable` on purpose — it is
 * identical for every property in a batch (so OpenRouter prompt caching still
 * hits within the batch), and it changes only between batches as the corpus
 * grows.
 */
export function buildRedflagsPrompt(vars: FlowVars): {
  stable: string;
  volatile?: string;
} {
  const typeUnion = REDFLAG_TYPES.map((t) => `"${t}"`).join(" | ");

  const stable = `${DOMAIN_PREAMBLE}

## Tarea: señales de alerta (problemas legales, financieros y físicos)

Extrae menciones que un inversor debería revisar ANTES de hacer una oferta:
problemas legales/financieros (para revisar con un abogado) Y problemas
físicos del inmueble (para revisar con un técnico).
NO estás dando asesoramiento legal ni técnico ni emitiendo un veredicto:
estás señalando qué hay que comprobar. Cada hallazgo se presentará al usuario
como "el anuncio menciona X — verifícalo de forma independiente", nunca como
un hecho confirmado.

### Vocabulario cerrado de tipos (\`type\`)

Usa uno de estos tipos con nombre SIEMPRE que el problema encaje en su
definición (cubren problemas legales/financieros Y físicos del inmueble):
${renderRedflagVocabulary()}

${renderCrossAxisVocabulary()}

### El tipo \`other\` y su \`candidate_type\`

- \`other\` — ${REDFLAG_DEFINITIONS.other}
  Primero: usa un tipo con nombre de la lista de arriba si encaja. Solo si
  NINGUNO encaja, usa \`other\`. Antes de acuñar un slug nuevo, MIRA la lista de
  "candidatos recientes" de más abajo y reutiliza uno si tu problema es el mismo
  concepto — así evitamos sinónimos (p.ej. no crear \`obra_sin_acabar\` cuando ya
  existe \`unfinished_construction\`, ni tres variantes del mismo candidato).
  Cuando uses \`other\`, propón ADEMÁS un \`candidate_type\`: un slug corto en
  \`snake_case\` (2-4 palabras, minúsculas, sin acentos ni espacios; usa \`_\` como
  separador) que nombre ese problema como si fuera un tipo nuevo del vocabulario
  (p.ej. \`servidumbre_paso\`, \`ruido_excesivo\`, \`inundacion_riesgo\`), y una
  \`definition\`: la misma definición de una línea que darías a un tipo con nombre.
  El slug NO se muestra al usuario todavía ni se convierte en filtro: sirve para
  agrupar los \`other\` por concepto. Solo para \`other\`; los tipos con nombre NO
  llevan \`candidate_type\` ni \`definition\`. El guard de evidencia se mantiene:
  un \`other\` sin \`evidence\` se descarta aunque traiga \`candidate_type\`.

### Candidatos recientes (\`other\`) ya propuestos

${renderTrendingCandidates(vars.trendingCandidates)}

### Candidatos ya revisados y RECHAZADOS por un humano

${renderDismissedCandidates(vars.dismissedCandidates)}

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

**Nota sobre la regla 2 anterior:** aquí no hay un campo de estado individual
que pueda valer \`unknown\` — la ausencia de hallazgos se expresa devolviendo
\`flags: []\` (ver más abajo), no con un valor "no lo sé" por hallazgo.
${AREA_PRICE_SIGNAL_RULES}

Formato de salida:
{
  "flags": [
    {
      "type": ${typeUnion},
      "description": "qué debería comprobar el inversor, una frase",
      "evidence": "cita literal del anuncio en la que te apoyas",
      "evidence_source": "portal del que sale la cita, o null",
      "candidate_type": "solo si type='other': slug snake_case corto (2-4 palabras) que nombre el problema; omítelo en los tipos con nombre",
      "definition": "solo si type='other': definición de una línea del candidate_type; omítelo en los tipos con nombre"
    }
  ],
  "confidence": 0.0-1.0,
  "reasoning": "una o dos frases en español"
}

Si no hay ninguna señal, devuelve \`{"flags": [], "confidence": <n>, "reasoning": "..."}\`.
Una lista vacía es un resultado correcto y frecuente — NO fuerces hallazgos.`;

  return { stable, volatile: propertyVolatileWithAreaPrice(vars) };
}

/**
 * #388 (Fase 3 de #385) — location: beach proximity (graded) + heritage zone,
 * per deduplicated property.
 *
 * Same property-level, single-shot, temperature-0 pattern as
 * condition/redflags (see their doc comments). This is the owner's headline
 * ask — "primera línea de playa / vistas al mar" — derived from the advert
 * text because no portal exposes it as a filter.
 *
 * ## LLM-only, never regex (owner decision, 2026-08-06)
 *
 * The owner explicitly does not trust keyword/regex matching for this signal.
 * This prompt IS the detector: the model reads the text and classifies with a
 * cited literal quote per verdict. There is no ILIKE/regex classifier anywhere
 * in the runtime path (see `lib/ai-assessment/location.ts` and
 * docs/decisions/D-095-location-axis.md). Text-only for now (no coastline/geo
 * dataset exists).
 *
 * `beach_proximity` is GRADED, not boolean, because primera línea and vistas al
 * mar are different facts an investor weighs differently. Each of the two
 * sub-signals (beach, heritage) demands its OWN literal evidence quote or
 * degrades to the safe default in `parseLocationResult`.
 */
export function buildLocationPrompt(vars: FlowVars): {
  stable: string;
  volatile?: string;
} {
  const stable = `${DOMAIN_PREAMBLE}

## Tarea: ubicación (proximidad a la playa y casco histórico)

Clasifica DOS señales de ubicación que ningún portal expone como filtro y que
solo se pueden deducir del texto del anuncio. No inventes geografía: básate
ÚNICAMENTE en lo que el anuncio dice; NO uses tu conocimiento de la ciudad ni
del código postal para adivinar. No hay datos de costa ni de coordenadas: si el
texto no lo dice, la señal es \`none\`/\`false\`.

### 1) Proximidad a la playa (\`beach_proximity\`) — enum GRADUADO

Distingue TRES grados, no un booleano. Elige el MÁS ALTO que el texto sostenga
con una cita literal:
- \`frontline\` — **primera línea de playa**: "primera línea", "a pie de playa",
  "acceso directo a la playa/al mar", "en la misma playa", "frente al mar" con
  acceso directo. Es la señal más fuerte y más escasa: exígela solo si el texto
  afirma que el inmueble está pegado a la playa o el paseo, no solo cerca.
- \`sea_view\` — **vistas al mar/playa** sin ser primera línea: "vistas al mar",
  "vistas a la playa", "con vistas frontales al mar". Ver el mar NO implica
  estar a pie de playa: si dice vistas pero no primera línea, es \`sea_view\`.
- \`near_beach\` — **cerca de la playa, andando**: "a 5 min de la playa", "playa
  a 300 m", "junto al paseo marítimo", "zona de playa". Cerca, pero ni primera
  línea ni con vistas declaradas.
- \`none\` — el anuncio no menciona la playa, el mar ni el paseo marítimo. Es el
  caso más habitual; no lo fuerces.

**No confundas los grados.** "Vistas al mar" NO es \`frontline\`. "Cerca de la
playa" NO es \`sea_view\`. Ante la duda entre dos grados, elige el MÁS BAJO (el
más conservador) y cita la frase exacta en \`beach_evidence\`.

### 2) Casco histórico (\`heritage_zone\`) — booleano

\`true\` solo si el texto sitúa el inmueble en el **casco/centro histórico** de
la ciudad (o zona catalogada/protegida): "casco histórico", "casco antiguo",
"centro histórico", "ciudad vieja", "casco viejo", "zona histórica protegida".
Es a la vez prestigio de ubicación y una posible complicación de licencias de
reforma, por eso lo marcamos. Un "centro" o "zona céntrica" a secas NO es casco
histórico: exige la referencia explícita a lo histórico/antiguo/protegido. En
cualquier otro caso, \`false\`.

### Evidencia obligatoria por cada señal

Por CADA veredicto que no sea el valor por defecto DEBES aportar una cita
literal del anuncio:
- \`beach_evidence\` sostiene \`beach_proximity\` (obligatoria salvo \`none\`).
- \`heritage_evidence\` sostiene \`heritage_zone\` (obligatoria si es \`true\`).
Si no puedes citar nada para una señal, esa señal es \`none\`/\`false\`. Nunca
afirmes primera línea, vistas o casco histórico sin una frase del texto que lo
diga. \`evidence_source\` (\`beach_evidence_source\` / \`heritage_evidence_source\`)
indica de qué portal sale la cita.

### Varios anuncios del mismo inmueble

Puede que te dé varios anuncios del mismo inmueble físico en portales distintos.
Emite UN solo veredicto por señal para el inmueble: basta que UN anuncio afirme
"primera línea" o "casco histórico" para marcarlo, citando ese anuncio concreto
en la evidencia y su portal en el source.

${ASSESSMENT_RULES}

**Nota sobre la regla 2 anterior:** aquí "no lo sé / no se menciona" se expresa
con \`none\` (proximidad a la playa) y \`false\` (casco histórico), NO con la
cadena \`"unknown"\` — \`"unknown"\` no es un valor válido de estos campos y
rompería el formato de salida.

Formato de salida:
{
  "beach_proximity": "frontline" | "sea_view" | "near_beach" | "none",
  "beach_evidence": "cita literal del anuncio, o \\"\\" si es none",
  "beach_evidence_source": "portal del que sale la cita (p. ej. \\"fotocasa\\"), o null",
  "heritage_zone": true | false,
  "heritage_evidence": "cita literal del anuncio, o \\"\\" si es false",
  "heritage_evidence_source": "portal del que sale la cita, o null",
  "confidence": 0.0-1.0,
  "reasoning": "una o dos frases en español"
}`;

  return { stable, volatile: propertyVolatile(vars) };
}

/**
 * #398 (Fase 5 de #385) — opportunity: is_vpo (hard filter downstream) +
 * tourist_license (soft ranking boost), per deduplicated property.
 *
 * Same property-level, single-shot, temperature-0 pattern as
 * condition/redflags/location (see their doc comments). Mining the descriptions
 * showed both signals are under-exposed by the portals: VPO shows up in the
 * text 3.6× more than the portal checkbox, and a granted licencia turística is
 * text-only. So both are derived from the advert text.
 *
 * ## LLM-only, never regex (owner decision, 2026-08-06)
 *
 * The owner explicitly does not trust keyword/regex matching for text-derived
 * signals. This prompt IS the detector: the model reads the text and answers
 * with a cited literal quote per boolean. There is no ILIKE/regex classifier
 * anywhere in the runtime path (see `lib/ai-assessment/opportunity.ts` and
 * docs/decisions/D-095-location-axis.md — the same LLM-not-regex principle).
 *
 * Each of the two booleans demands its OWN literal evidence quote or degrades
 * to `false` in `parseOpportunityResult`.
 */
export function buildOpportunityPrompt(vars: FlowVars): {
  stable: string;
  volatile?: string;
} {
  const stable = `${DOMAIN_PREAMBLE}

## Tarea: oportunidad (VPO y licencia turística)

Clasifica DOS señales de oportunidad para el inversor que muchas veces no
aparecen en los campos estructurados del portal y que se deducen del texto del
anuncio. No inventes: básate ÚNICAMENTE en lo que el anuncio dice. Si el texto
no lo dice, la señal es \`false\`.

### 1) VPO / vivienda protegida (\`is_vpo\`) — booleano

\`true\` solo si el texto afirma que la vivienda es de **Protección Oficial** o
**protegida**: "VPO", "V.P.O.", "vivienda de protección oficial", "vivienda
protegida", "VPP", "vivienda con protección pública", "precio tasado/máximo de
venta por ser protegida", "sujeta a régimen de protección". Es una restricción
material (tope de precio de reventa y/o restricción del comprador), por eso el
inversor filtra por ella. En cualquier otro caso, \`false\`. Un anuncio que solo
diga "buen precio" o "protegido de miradas/del sol" NO es VPO.

### 2) Licencia turística / VUT (\`tourist_license\`) — booleano

\`true\` solo si el texto afirma que la vivienda **ya tiene concedida** una
licencia turística o de vivienda de uso turístico: "licencia turística",
"licencia VUT", "vivienda de uso turístico con licencia", "apto turístico con
licencia", "número de registro turístico". Marca \`true\` únicamente cuando la
licencia YA existe/está concedida. Un anuncio que diga "ideal para alquiler
turístico", "posibilidad de licencia turística" o "apto para uso turístico" SIN
afirmar que la licencia está concedida NO cuenta como \`true\` — eso es un
potencial, no una licencia. Ante la duda, \`false\`.

### Evidencia obligatoria por cada señal

Por CADA booleano que marques \`true\` DEBES aportar una cita literal del anuncio:
- \`vpo_evidence\` sostiene \`is_vpo\` (obligatoria si es \`true\`).
- \`tourist_license_evidence\` sostiene \`tourist_license\` (obligatoria si es \`true\`).
Si no puedes citar nada para una señal, esa señal es \`false\`. Nunca afirmes VPO
ni licencia turística sin una frase del texto que lo diga. \`evidence_source\`
(\`vpo_evidence_source\` / \`tourist_license_evidence_source\`) indica de qué portal
sale la cita.

### Varios anuncios del mismo inmueble

Puede que te dé varios anuncios del mismo inmueble físico en portales distintos.
Emite UN solo veredicto por señal para el inmueble: basta que UN anuncio afirme
"VPO" o "licencia turística concedida" para marcarlo, citando ese anuncio
concreto en la evidencia y su portal en el source.

${ASSESSMENT_RULES}

**Nota sobre la regla 2 anterior:** aquí "no lo sé / no se menciona" se expresa
con \`false\` en ambos campos, NO con la cadena \`"unknown"\` — \`"unknown"\` no es un
valor válido de estos campos booleanos y rompería el formato de salida.

Formato de salida:
{
  "is_vpo": true | false,
  "vpo_evidence": "cita literal del anuncio, o \\"\\" si es false",
  "vpo_evidence_source": "portal del que sale la cita (p. ej. \\"fotocasa\\"), o null",
  "tourist_license": true | false,
  "tourist_license_evidence": "cita literal del anuncio, o \\"\\" si es false",
  "tourist_license_evidence_source": "portal del que sale la cita, o null",
  "confidence": 0.0-1.0,
  "reasoning": "una o dos frases en español"
}`;

  return { stable, volatile: propertyVolatile(vars) };
}

/**
 * #28 — extract: unstructured description → structured fields, per
 * deduplicated property.
 *
 * Property-level, not listing-level, DESPITE issue #28's own wording
 * ("per-advert structured fields") and `lib/llm.ts`'s original module doc
 * (written when #24 landed, before #28 itself did) — both predate the
 * observation that settled it: `rooms`/`bathrooms`/`m2_built`/`m2_useful`/
 * `floor`/`has_elevator` are all columns on `property`, not `listing` (see
 * `etl/schema/init.sql`). The dedup pipeline already reconciles per-listing
 * facts onto one property row; extraction fills gaps in THAT row, so it must
 * read the same "every live listing at once" evidence occupancy/condition/
 * redflags do — a private-seller advert stating "85m², 3 habitaciones" must
 * not be missed because the property's other listing (say, an agency's
 * shorter blurb) is what happened to get read. Using `propertyVolatile()`
 * (not `listingVolatile()`) keeps this flow on the same shared plumbing and
 * cache-key shape (`property_id`, #30) as its three siblings, instead of
 * needing its own listing-keyed storage path.
 *
 * Output schema is deliberately narrower than the placeholder this replaces
 * (which also asked for `year_built`/`energy_rating`/`features`/`m2_plot`):
 * issue #28's technical approach names exactly `m2_built`, `m2_useful`,
 * `rooms`, `bathrooms`, `floor`, `has_elevator` — the fields the hard-filter
 * engine (task 2.4) actually needs a fallback for. `confidence_per_field`
 * (not one scalar `confidence`) lets a consumer trust a high-confidence
 * `rooms` extraction while discounting a shakier `floor` guess from the same
 * response, per the issue's own reasoning.
 */
export function buildExtractPrompt(vars: FlowVars): {
  stable: string;
  volatile?: string;
} {
  const stable = `${DOMAIN_PREAMBLE}

## Tarea: extracción de campos estructurados

Muchos anuncios de particulares no traen campos estructurados: todo está en el
texto libre. Extrae lo que el portal no nos dio, para que ese anuncio no quede
injustamente fuera de los filtros del usuario por falta de datos.

Campos a extraer (todos opcionales):
- \`m2_built\` — metros cuadrados construidos.
- \`m2_useful\` — metros cuadrados útiles, SOLO si el texto los distingue
  explícitamente de los construidos.
- \`rooms\` — número de habitaciones o dormitorios.
- \`bathrooms\` — número de baños.
- \`floor\` — planta, como texto ("bajo", "3º", "ático", "2ºB"…).
- \`has_elevator\` — \`true\`/\`false\` solo si el texto lo menciona
  explícitamente ("con ascensor", "sin ascensor", "edificio sin ascensor").

Por cada campo que rellenes con un valor (no \`null\`), añade su confianza en
\`confidence_per_field\` bajo la misma clave (0.0-1.0). NO añadas una entrada en
\`confidence_per_field\` para un campo que dejaste en \`null\` — un campo ausente
no tiene una confianza que reportar.

### No inventes, no redondees, no "completes" (EC-2)

Si el texto no menciona un dato, ese campo es \`null\`. NO lo deduzcas a partir
de lo que sería típico para ese tipo de inmueble o esa zona (p. ej. no asumas
\`has_elevator: false\` solo porque el edificio parece antiguo, ni redondees
"unos 90 metros" a un número si el texto ya da un valor exacto en otra
frase — usa el valor exacto cuando exista). Convertir el silencio en un valor
concreto, aunque sea con confianza baja, es exactamente el fallo que este
flujo existe para evitar: un dato inventado es peor que un campo vacío para un
filtro que hará comparaciones numéricas con él.

### Varios anuncios del mismo inmueble

Puede que te dé varios anuncios del mismo inmueble físico en portales
distintos. Combínalos: si solo uno de ellos da un dato concreto (metros,
habitaciones, planta…), extráelo igualmente — que otro anuncio no lo mencione
no invalida el que sí lo hace.

${ASSESSMENT_RULES}

**Nota sobre la regla 2 anterior:** aquí "no lo sé" para un campo individual se
expresa dejando ese campo en \`null\`, NUNCA con la cadena \`"unknown"\` — estos
campos son numéricos, de texto libre corto o booleanos, y \`"unknown"\` rompería
el tipo esperado (un \`rooms: "unknown"\` no es un número válido). Deja el campo
en \`null\` y no le añadas entrada en \`confidence_per_field\`; no escribas la
palabra "unknown" en ningún campo de este formato.

Formato de salida:
{
  "m2_built": number | null,
  "m2_useful": number | null,
  "rooms": number | null,
  "bathrooms": number | null,
  "floor": string | null,
  "has_elevator": boolean | null,
  "confidence_per_field": { "<nombre_de_campo>": 0.0-1.0, ... },
  "reasoning": "una frase en español"
}`;

  return { stable, volatile: propertyVolatile(vars) };
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

/**
 * #29 — chat: conversational search over the ingested data.
 *
 * #543/F-13 (D-108): `stable` must be byte-identical across calls for this
 * flow — the CLI single-shot path is reachable here (whenever
 * `isAgenticToolsEnabled()` is false, `assemble.ts` routes even `chat`,
 * which always has tools, through the non-agentic `llmComplete` branch) and
 * sends `stable` verbatim on `--system-prompt`; any per-call text there
 * degrades the prompt cache straight back to zero reuse. `vars.profileName`/
 * `profileId` are per-conversation, not per-flow, so the scope sentence they
 * produce lives in `volatile` — never interpolated into `stable`.
 */
export function buildChatPrompt(vars: FlowVars): {
  stable: string;
  volatile?: string;
} {
  const scope = vars.profileName
    ? `La conversación está enmarcada en el perfil de búsqueda **${vars.profileName}**${
        vars.profileId ? ` (id ${vars.profileId})` : ""
      }. Cuando el usuario diga "mis candidatos" o "esta búsqueda", se refiere a ese perfil.`
    : undefined;

  const titleRule = isAgenticToolsEnabled()
    ? "\n7. En tu primera respuesta de cada conversación nueva, llama a la herramienta `set_title` con un título conciso de 5-7 palabras en español."
    : "";

  const stable = `${DOMAIN_PREAMBLE}

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

  return { stable, volatile: scope };
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
    case "location":
      return buildLocationPrompt(vars);
    case "opportunity":
      return buildOpportunityPrompt(vars);
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
