/**
 * POST /api/profiles/[id]/candidates/[propertyId]/feedback — record a
 * feedback event (accept/reject/star/note/correction) for a candidate
 * (task 3.1, #20).
 * GET  /api/profiles/[id]/candidates/[propertyId]/feedback — full feedback
 * history for this candidate in this profile, plus the derived current
 * accept/reject/star state.
 *
 * Feedback is keyed on `property_id` (task 1.2's design), with an optional
 * `listingId` recording which specific site listing was on screen — never
 * used to identify what the feedback applies to. Feedback given while
 * viewing either of a deduplicated property's linked listings lands on the
 * same state (EC-5).
 *
 * A real (non-no-op) accept/reject/star event also retrains and rescores
 * this profile's model (task 3.2, #21) before the response returns — awaited
 * synchronously, not fire-and-forget, so a client reading candidate scores
 * immediately after this POST sees the update (issue #21's EC-3). A retrain
 * failure is logged and swallowed rather than failing the request: the
 * feedback itself already recorded successfully by that point, and issue
 * #21's own design means retraining can legitimately no-op (e.g. only one
 * feedback class exists so far) without that being an error condition.
 * `note`/`correction` don't trigger a retrain — neither ever changes a
 * training label (issue #21's Technical approach #1), so retraining after
 * one would just reproduce the same model.
 *
 * Error codes:
 *   400 — Invalid ids, body, or feedback_type
 *   404 — Profile not found/archived, property not a matched candidate for
 *         this profile, or listingId doesn't belong to this property
 *   500 — Unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";
import {
  DERIVED_STATE_FEEDBACK_TYPES,
  FEEDBACK_TYPES,
  getCurrentState,
  getFeedbackHistory,
  listingBelongsToProperty,
  recordFeedback,
  recordStateFeedbackIfChanged,
} from "@/lib/db/feedback";
import { isPropertyMatchedForProfile } from "@/lib/property-detail";
import { retrainAndRescoreProfile } from "@/lib/scoring/retrain";
import { getProfileById } from "@/lib/db/profiles";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

type RouteContext = {
  params: Promise<{ id: string; propertyId: string }> | { id: string; propertyId: string };
};

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const FeedbackBodySchema = z.object({
  feedbackType: z.enum(FEEDBACK_TYPES as unknown as [string, ...string[]]),
  listingId: z.number().int().positive().optional(),
  note: z.string().trim().min(1).max(4000).optional(),
  value: z.unknown().optional(),
});

async function resolveProfileAndProperty(
  profileId: number,
  propertyId: number,
  requestId: string,
): Promise<NextResponse | null> {
  const profile = await getProfileById(profileId);
  if (!profile || profile.archived_at !== null) {
    return NextResponse.json(
      formatApiError("Perfil de búsqueda no encontrado o archivado.", "NOT_FOUND", undefined, requestId),
      { status: 404 },
    );
  }

  const matched = await isPropertyMatchedForProfile(profileId, propertyId);
  if (!matched) {
    return NextResponse.json(
      formatApiError("Esta propiedad no es un candidato de este perfil.", "NOT_FOUND", undefined, requestId),
      { status: 404 },
    );
  }

  return null;
}

export async function GET(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id: rawId, propertyId: rawPropertyId } = await context.params;
  const profileId = parsePositiveInt(rawId);
  const propertyId = parsePositiveInt(rawPropertyId);

  if (profileId === null || propertyId === null) {
    return NextResponse.json(
      formatApiError("Id de perfil o de propiedad no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  try {
    const errorResponse = await resolveProfileAndProperty(profileId, propertyId, requestId);
    if (errorResponse) return errorResponse;

    const [history, currentState] = await Promise.all([
      getFeedbackHistory(profileId, propertyId),
      getCurrentState(profileId, propertyId),
    ]);

    return NextResponse.json({ currentState, history });
  } catch (err) {
    console.error(`[${requestId}] Error al cargar el historial de feedback:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo cargar el historial de feedback.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id: rawId, propertyId: rawPropertyId } = await context.params;
  const profileId = parsePositiveInt(rawId);
  const propertyId = parsePositiveInt(rawPropertyId);

  if (profileId === null || propertyId === null) {
    return NextResponse.json(
      formatApiError("Id de perfil o de propiedad no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      formatApiError("Cuerpo JSON no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  let body: z.infer<typeof FeedbackBodySchema>;
  try {
    body = FeedbackBodySchema.parse(rawBody);
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json(
        formatApiError("Feedback no válido.", "VALIDATION", JSON.stringify(err.issues), requestId),
        { status: 400 },
      );
    }
    throw err;
  }

  // 'note' requires actual text; 'correction' requires structured value.
  // accept/reject/star carry neither — they're pure state signals.
  if (body.feedbackType === "note" && !body.note) {
    return NextResponse.json(
      formatApiError("El campo 'note' es obligatorio para feedback de tipo 'note'.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }
  if (body.feedbackType === "correction" && body.value === undefined) {
    return NextResponse.json(
      formatApiError(
        "El campo 'value' es obligatorio para feedback de tipo 'correction'.",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  try {
    const errorResponse = await resolveProfileAndProperty(profileId, propertyId, requestId);
    if (errorResponse) return errorResponse;

    if (body.listingId !== undefined) {
      const belongs = await listingBelongsToProperty(body.listingId, propertyId);
      if (!belongs) {
        return NextResponse.json(
          formatApiError(
            "El listing indicado no pertenece a esta propiedad.",
            "NOT_FOUND",
            undefined,
            requestId,
          ),
          { status: 404 },
        );
      }
    }

    // accept/reject/star are a single-active-toggle state (lib/db/feedback.ts's
    // getCurrentState); `clear` (#379) is the explicit "un-mark" that resets
    // that state to neutral. Re-recording the state that's already active — or
    // clearing an already-neutral property — is a no-op rather than logging a
    // redundant event. The check-and-insert is atomic
    // (recordStateFeedbackIfChanged, backed by a Postgres advisory lock) — a
    // plain check-then-insert here previously let two rapid clicks both insert
    // (verified live in PR #89's review).
    if (DERIVED_STATE_FEEDBACK_TYPES.includes(body.feedbackType as (typeof DERIVED_STATE_FEEDBACK_TYPES)[number])) {
      const result = await recordStateFeedbackIfChanged({
        profileId,
        propertyId,
        listingId: body.listingId ?? null,
        feedbackType: body.feedbackType as (typeof DERIVED_STATE_FEEDBACK_TYPES)[number],
      });

      if (result.noop) {
        const history = await getFeedbackHistory(profileId, propertyId);
        return NextResponse.json({ currentState: result.currentState, history, noop: true });
      }

      try {
        await retrainAndRescoreProfile(profileId);
      } catch (err) {
        console.error(`[${requestId}] No se pudo reentrenar el modelo de puntuación tras el feedback:`, err);
      }

      const history = await getFeedbackHistory(profileId, propertyId);
      return NextResponse.json(
        { event: result.event, currentState: result.currentState, history },
        { status: 201 },
      );
    }

    const event = await recordFeedback({
      profileId,
      propertyId,
      listingId: body.listingId ?? null,
      feedbackType: body.feedbackType as (typeof FEEDBACK_TYPES)[number],
      note: body.note ?? null,
      value: body.value,
    });

    const [history, currentState] = await Promise.all([
      getFeedbackHistory(profileId, propertyId),
      getCurrentState(profileId, propertyId),
    ]);

    return NextResponse.json({ event, currentState, history }, { status: 201 });
  } catch (err) {
    console.error(`[${requestId}] Error al registrar feedback:`, err);
    return NextResponse.json(
      formatApiError("No se pudo registrar el feedback.", "DB_QUERY", sanitizeErrorMessage(err), requestId),
      { status: 500 },
    );
  }
}
