/**
 * #25 + #145 — "what do I actually get if I buy this?", per deduplicated
 * property.
 *
 * Answers the question the owner cares about most, along three independent
 * axes (see `OccupancyResult`): can I take possession, am I buying the property
 * or the debt, and am I buying all of it or a share. Each is a reason a
 * property is priced far below apparent market value, and an investor tool that
 * surfaces a cheap-looking flat without flagging that it is a credit assignment
 * or a bare-ownership share is actively misleading — which makes this flow the
 * highest-value thing the AI layer does (issue #1 §9, #145).
 *
 * The flow, the `assessment_type`, and the route stay named `occupancy` even
 * though it now covers three axes: the name is load-bearing across the #24 flow
 * catalog, D-006, the `assessment_type` CHECK and the API path, and renaming it
 * buys nothing a doc comment cannot.
 *
 * Two design points that are load-bearing rather than incidental:
 *
 *  1. **Per property, after dedup — never per listing during ingest.** The same
 *     flat on three portals is one physical thing with one true occupancy
 *     status. Assessing per listing meant three LLM calls, three bills, and
 *     three verdicts that could disagree with nothing to reconcile them.
 *
 *  2. **The union of the merged descriptions is the input.** Occupancy is
 *     exactly the fact one seller discloses and another omits, so reading all
 *     the adverts together is strictly better evidence than reading any one of
 *     them. That is only reachable once dedup has unioned the listings, which
 *     is why this runs at the end of the pipeline.
 *
 * Server-only: imports lib/db-write (the `pg` client). Never import from a
 * client component.
 */

import { sql } from "@/lib/db-write";
import { assessOccupancy } from "@/lib/llm";
import type { ListingSnapshot } from "@/lib/llm-context";
import type { LlmAgenticContext } from "@/lib/llm-tools/types";

/**
 * Prompt version. Bump when the occupancy prompt changes in a way that could
 * change a verdict, so `ai_assessment`'s unique key treats the new output as a
 * distinct row rather than colliding with a verdict the old prompt produced.
 * #30 owns the wider caching/versioning story; this is the hook it will use.
 */
export const OCCUPANCY_PROMPT_VERSION = "occupancy/v1";

/** Occupancy status vocabulary — see the enum-language note in system-prompt.ts. */
export const OCCUPANCY_STATUSES = [
  "vacant",
  "tenanted",
  "occupied_illegally",
  "unknown",
] as const;

export type OccupancyStatus = (typeof OCCUPANCY_STATUSES)[number];

/** What legal instrument is being transferred (#145). */
export const TRANSACTION_KINDS = ["compraventa", "venta_deuda", "unknown"] as const;

export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

/** How much of the right is being transferred (#145). */
export const OWNERSHIP_EXTENTS = [
  "pleno_dominio",
  "nuda_propiedad",
  "usufructo",
  "proindiviso",
  "derecho_superficie",
  "unknown",
] as const;

export type OwnershipExtent = (typeof OWNERSHIP_EXTENTS)[number];

/** One axis's verdict: a label, how sure we are, and the quote that proves it. */
export interface Verdict<T> {
  value: T;
  confidence: number;
  /** Literal quote from one advert, or "" when nothing could be cited. */
  evidence: string;
  /** Which portal that quote came from, so the investor can go and check it. */
  evidence_source: string | null;
}

/**
 * Every non-standard condition found, as flat codes for cheap filtering and
 * badging. Derived from the three axes in `deriveCaveats()` — never taken from
 * the model — so a badge can never disagree with the verdict it summarises.
 */
export const CAVEAT_CODES = [
  "tenanted",
  "occupied_illegally",
  "venta_deuda",
  "nuda_propiedad",
  "usufructo",
  "proindiviso",
  "derecho_superficie",
] as const;

export type CaveatCode = (typeof CAVEAT_CODES)[number];

/**
 * The three axes of "what do I actually get if I buy this?" (#25 + #145).
 *
 * Deliberately three sibling verdicts rather than one enum: they are
 * independent, they co-occur in the wild, and a flat enum cannot represent
 * "squatted debt sale of a 50% share" — which is a listing that really exists.
 * Each axis carries its own confidence and its own cited evidence, because the
 * phrase proving the flat is squatted is rarely the phrase proving it is a
 * credit assignment.
 */
export interface OccupancyResult {
  /** Can I take possession? */
  occupancy: Verdict<OccupancyStatus>;
  /** Am I buying the property, or the debt secured on it? */
  transaction: Verdict<TransactionKind>;
  /** Am I buying the whole right, or a share / limited right of it? */
  ownership: Verdict<OwnershipExtent> & {
    /** Percentage being sold when stated ("el 50%" → 50), else null. */
    share_pct: number | null;
  };
  /** Derived, not model-authored. See CAVEAT_CODES. */
  caveats: CaveatCode[];
  reasoning: string;
}

export class NoListingsError extends Error {
  constructor(propertyId: number) {
    super(`Property ${propertyId} has no live listings to assess.`);
    this.name = "NoListingsError";
  }
}

interface RawListingRow {
  id: number;
  source: string;
  url: string | null;
  status: string;
  operation: string | null;
  current_price: string | null;
  description: string | null;
  first_seen_at: string | null;
}

interface RawPropertyRow {
  id: number;
  property_type: string | null;
  m2_built: string | null;
  rooms: number | null;
  bathrooms: number | null;
  floor: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

/**
 * Load every live listing of a property as assessment input, newest-first.
 *
 * Newest-first because a withdrawn or stale advert should not outweigh a
 * current one when the model weighs contradictory claims — the ordering is
 * part of the evidence, not cosmetic.
 *
 * Only `active` listings: a description from a listing that has since been
 * sold or withdrawn describes a state of the world that may no longer hold.
 */
export async function loadPropertyListings(
  propertyId: number,
): Promise<ListingSnapshot[]> {
  const propRows = await sql<RawPropertyRow>(
    `SELECT id, property_type, m2_built, rooms, bathrooms, floor,
            address, city, province
       FROM property WHERE id = $1`,
    [propertyId],
  );
  const prop = propRows[0];
  if (!prop) return [];

  const rows = await sql<RawListingRow>(
    `SELECT id, source, url, status, operation, current_price,
            description, first_seen_at
       FROM listing
      WHERE property_id = $1 AND status = 'active'
      ORDER BY first_seen_at DESC NULLS LAST, id DESC`,
    [propertyId],
  );

  return rows.map((l) => ({
    propertyId: prop.id,
    listingId: l.id,
    source: l.source,
    url: l.url ?? undefined,
    description: l.description ?? undefined,
    operation: l.operation,
    propertyType: prop.property_type,
    price: num(l.current_price),
    m2Built: num(prop.m2_built),
    rooms: prop.rooms,
    bathrooms: prop.bathrooms,
    floor: prop.floor,
    address: prop.address,
    city: prop.city,
    province: prop.province,
  }));
}

/**
 * Parse one axis out of the model's JSON.
 *
 * Strict about the label because these feed scoring and the deal pipeline: an
 * unrecognised value is degraded to `unknown` with zero confidence rather than
 * written through, so a prompt drift or a hallucinated category can never look
 * like a confident verdict downstream. A missing axis object degrades the same
 * way — silence from the model is "we did not learn anything", never a default
 * "all clear", which on the #145 axes would be an actively dangerous reading.
 */
function parseVerdict<T extends string>(
  node: unknown,
  key: string,
  allowed: readonly T[],
): Verdict<T> {
  const o = (typeof node === "object" && node !== null ? node : {}) as Record<
    string,
    unknown
  >;
  const rawValue = typeof o[key] === "string" ? (o[key] as string) : "unknown";
  const known = (allowed as readonly string[]).includes(rawValue);
  const value = (known ? rawValue : "unknown") as T;

  const rawConfidence = typeof o.confidence === "number" ? o.confidence : 0;

  return {
    value,
    confidence: known ? clamp01(rawConfidence) : 0,
    evidence: typeof o.evidence === "string" ? o.evidence : "",
    evidence_source:
      typeof o.evidence_source === "string" && o.evidence_source.trim() !== ""
        ? o.evidence_source
        : null,
  };
}

/**
 * Every non-standard condition present, derived from the three axes.
 *
 * Computed here rather than asked of the model so the summary and the verdicts
 * it summarises always come from one computation and cannot drift apart (the
 * same rule `explainScore()` follows for rank_explanation).
 *
 * `unknown` never produces a caveat: absence of evidence is not evidence of a
 * problem, and a caveat badge implies we found something.
 */
export function deriveCaveats(
  occupancy: OccupancyStatus,
  transaction: TransactionKind,
  ownership: OwnershipExtent,
): CaveatCode[] {
  const caveats: CaveatCode[] = [];
  if (occupancy === "tenanted" || occupancy === "occupied_illegally") {
    caveats.push(occupancy);
  }
  if (transaction === "venta_deuda") caveats.push("venta_deuda");
  if (ownership !== "pleno_dominio" && ownership !== "unknown") {
    caveats.push(ownership);
  }
  return caveats;
}

/** Parse and validate the model's JSON into the three-axis result. */
export function parseOccupancyResult(raw: string): OccupancyResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new Error(`Occupancy flow returned non-JSON output: ${raw.slice(0, 200)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Occupancy flow returned a non-object JSON value.");
  }

  const o = parsed as Record<string, unknown>;

  const occupancy = parseVerdict(o.occupancy, "status", OCCUPANCY_STATUSES);
  const transaction = parseVerdict(o.transaction, "kind", TRANSACTION_KINDS);
  const ownershipBase = parseVerdict(o.ownership, "extent", OWNERSHIP_EXTENTS);

  const ownershipNode = (
    typeof o.ownership === "object" && o.ownership !== null ? o.ownership : {}
  ) as Record<string, unknown>;

  return {
    occupancy,
    transaction,
    ownership: {
      ...ownershipBase,
      share_pct: parseSharePct(ownershipNode.share_pct),
    },
    caveats: deriveCaveats(occupancy.value, transaction.value, ownershipBase.value),
    reasoning: typeof o.reasoning === "string" ? o.reasoning : "",
  };
}

/**
 * A share percentage is only meaningful in (0, 100]. Anything else — a stray
 * 0, a 150, a string, a fraction the model wrote as 0.5 — is dropped to null
 * rather than guessed at: a wrong share is worse than a missing one when it is
 * what tells the investor they are buying half a flat.
 */
function parseSharePct(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v <= 0 || v > 100) return null;
  return v;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Models sometimes wrap JSON in ```json fences despite being told not to. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced ? fenced[1] : trimmed;
}

/**
 * What goes in the `ai_assessment.confidence` COLUMN when the row holds three
 * independent verdicts.
 *
 * There is no honest single number, so rather than invent a composite the
 * column carries **the confidence of the finding that matters** — the highest
 * confidence among the axes that produced a caveat, or the occupancy
 * confidence when the property is clean. That keeps a coarse SQL filter like
 * `confidence > 0.7` meaning "we are sure about what we found", instead of
 * averaging a confident `venta_deuda` away against an `unknown` occupancy.
 *
 * Anything needing per-axis precision reads `result`, which keeps all three.
 */
export function summaryConfidence(result: OccupancyResult): number {
  const flagged: number[] = [];
  if (
    result.occupancy.value === "tenanted" ||
    result.occupancy.value === "occupied_illegally"
  ) {
    flagged.push(result.occupancy.confidence);
  }
  if (result.transaction.value === "venta_deuda") {
    flagged.push(result.transaction.confidence);
  }
  if (
    result.ownership.value !== "pleno_dominio" &&
    result.ownership.value !== "unknown"
  ) {
    flagged.push(result.ownership.confidence);
  }
  return flagged.length > 0 ? Math.max(...flagged) : result.occupancy.confidence;
}

/** Persist a verdict, replacing any prior one for the same prompt version. */
export async function saveOccupancyAssessment(
  propertyId: number,
  result: OccupancyResult,
  model: string | null,
): Promise<void> {
  await sql(
    `INSERT INTO ai_assessment
        (property_id, assessment_type, result, confidence, model, prompt_version, generated_at)
     VALUES ($1, 'occupancy', $2::jsonb, $3, $4, $5, NOW())
     ON CONFLICT ON CONSTRAINT ai_assessment_property_key
     DO UPDATE SET result = EXCLUDED.result,
                   confidence = EXCLUDED.confidence,
                   model = EXCLUDED.model,
                   generated_at = EXCLUDED.generated_at`,
    [
      propertyId,
      JSON.stringify(result),
      summaryConfidence(result),
      model,
      OCCUPANCY_PROMPT_VERSION,
    ],
  );
}

/** Read the cached verdict for a property, if one exists. */
export async function getOccupancyAssessment(
  propertyId: number,
): Promise<{ result: OccupancyResult; model: string | null; generated_at: string | null } | null> {
  const rows = await sql<{
    result: OccupancyResult;
    model: string | null;
    generated_at: string | null;
  }>(
    `SELECT result, model, generated_at
       FROM ai_assessment
      WHERE property_id = $1
        AND assessment_type = 'occupancy'
        AND prompt_version = $2`,
    [propertyId, OCCUPANCY_PROMPT_VERSION],
  );
  return rows[0] ?? null;
}

/**
 * Assess one property end-to-end: load its merged listings, ask the model,
 * validate, persist.
 *
 * Throws `NoListingsError` when the property has no live listings — there is
 * nothing to read, and writing an `unknown` verdict would misrepresent "we
 * never looked" as "we looked and could not tell".
 */
export async function assessPropertyOccupancy(
  propertyId: number,
  opts?: { requestId?: string | null; ctx?: LlmAgenticContext },
): Promise<OccupancyResult> {
  const listings = await loadPropertyListings(propertyId);
  if (listings.length === 0) throw new NoListingsError(propertyId);

  const { text, model } = await assessOccupancy(listings, opts);
  const result = parseOccupancyResult(text);
  await saveOccupancyAssessment(propertyId, result, model);
  return result;
}
