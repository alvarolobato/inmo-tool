/**
 * Shared plumbing for property-level assessment flows.
 *
 * #25 (occupancy) established the pattern: assess per deduplicated
 * `property_id`, not per `listing_id`, reading every live advert at once so a
 * disclosure in one portal's text rescues the silence in another's (see
 * `dashboard/lib/ai-assessment/occupancy.ts` for the full rationale). #26
 * (condition) and #27 (redflags) follow the same pattern — a listing's
 * renovation state or legal red flags are properties of the physical flat,
 * not of any one advert, and the same "one seller discloses, another omits"
 * argument applies.
 *
 * Extracted here when #26/#27 landed so `loadPropertyListings` — including
 * its non-obvious "empty description ⇒ no listings" rule (#156 review,
 * must-fix 2) — is fixed once for three callers instead of duplicated three
 * times. `Verdict<T>` / `parseVerdict` / `clamp01` / `stripCodeFence` move for
 * the same reason: they are the per-axis parsing discipline every flow's
 * `parseXResult()` needs (unknown-on-silence, confidence clamped to [0,1],
 * evidence-or-nothing), not something specific to occupancy's three axes.
 *
 * `occupancy.ts` re-exports `NoListingsError` and `loadPropertyListings` from
 * here so existing imports (`from "../occupancy"` in occupancy's own tests)
 * keep working unchanged.
 */

import { sql } from "@/lib/db-write";
import type { ListingSnapshot } from "@/lib/llm-context";

export class NoListingsError extends Error {
  constructor(propertyId: number) {
    super(`Property ${propertyId} has no live listings to assess.`);
    this.name = "NoListingsError";
  }
}

/**
 * Raw shapes as `pg` actually returns them — NOT as the schema declares them.
 *
 * `id` is BIGSERIAL, and node-postgres hands BIGINT back as a **string**
 * (int8 exceeds JS's safe integer range, so pg-types deliberately refuses to
 * guess). Without an explicit Number() these flow into `ListingSnapshot`
 * typed as `number` while actually holding `"17"`, and every downstream
 * `===` against a real number silently fails. NUMERIC columns have the same
 * property — that is what `num()` below exists for.
 */
interface RawListingRow {
  id: string;
  source: string;
  url: string | null;
  status: string;
  operation: string | null;
  current_price: string | null;
  description: string | null;
  first_seen_at: string | null;
}

interface RawPropertyRow {
  id: string;
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
 *
 * Returns `[]` — same as "no active listings" — when every active listing's
 * description is null/empty (#156 review, must-fix 2). A listing with no
 * description gives `formatListing` nothing to emit, and a silence-implies-
 * default rule (occupancy's ejes 2/3, or any future flow with one) would then
 * read "nothing contradicts the default" from a payload that was never
 * shown anything, not from adverts that discussed the topic and stayed
 * silent. Every property-level flow's `assessProperty*` turns an empty array
 * into `NoListingsError` (404), which keeps "we never looked" and "we looked
 * and found nothing" distinguishable end to end.
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

  const hasDescription = rows.some((l) => (l.description ?? "").trim() !== "");
  if (!hasDescription) return [];

  return rows.map((l) => ({
    propertyId: Number(prop.id),
    listingId: Number(l.id),
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
 * Ceiling on the confidence of a verdict reached from silence rather than a
 * citation (#156 review, must-fix 1). Some axes have a legitimate "default"
 * reading when nothing contradicts it (occupancy's transaction/ownership
 * axes: nobody sells a debt or a bare share without saying so, so silence
 * itself is weak evidence of the ordinary case) — but that reading must never
 * be as confident as a cited finding. This is the code-side enforcement: a
 * ceiling the model's own confidence is clamped against, not a value invented
 * when one is missing.
 */
export const SILENCE_CONFIDENCE_CAP = 0.7;

/**
 * Parse one axis out of the model's JSON.
 *
 * Strict about the label because these feed scoring and the deal pipeline: an
 * unrecognised value is degraded to `unknown` with zero confidence rather than
 * written through, so a prompt drift or a hallucinated category can never look
 * like a confident verdict downstream. A missing axis object degrades the same
 * way — silence from the model is "we did not learn anything", never a default
 * "all clear".
 *
 * `silenceDefault`, when given, is the value the axis's prompt tells the model
 * to answer *from silence* (see occupancy's ejes 2/3). When the parsed value
 * equals it AND no evidence was cited, confidence is capped at
 * `SILENCE_CONFIDENCE_CAP` regardless of what the model reported. Axes with no
 * silence-default convention (occupancy's eje 1; condition; every axis where
 * silence just means "we don't know") omit the argument and are unaffected —
 * silence there forces `unknown`/`unclear` via `known` being false, not a
 * clamp.
 */
export function parseVerdict<T extends string>(
  node: unknown,
  key: string,
  allowed: readonly T[],
  fallback: T,
  silenceDefault?: T,
): Verdict<T> {
  const o = (typeof node === "object" && node !== null ? node : {}) as Record<
    string,
    unknown
  >;
  const rawValue = typeof o[key] === "string" ? (o[key] as string) : fallback;
  const known = (allowed as readonly string[]).includes(rawValue);
  const value = (known ? rawValue : fallback) as T;

  const rawConfidence = typeof o.confidence === "number" ? o.confidence : 0;
  const evidence = typeof o.evidence === "string" ? o.evidence : "";

  let confidence = known ? clamp01(rawConfidence) : 0;
  if (evidence === "" && silenceDefault !== undefined && value === silenceDefault) {
    confidence = Math.min(confidence, SILENCE_CONFIDENCE_CAP);
  }

  return {
    value,
    confidence,
    evidence,
    evidence_source:
      typeof o.evidence_source === "string" && o.evidence_source.trim() !== ""
        ? o.evidence_source
        : null,
  };
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Models sometimes wrap JSON in ```json fences despite being told not to. */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced ? fenced[1] : trimmed;
}
