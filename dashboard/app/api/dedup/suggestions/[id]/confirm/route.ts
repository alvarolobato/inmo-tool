/**
 * POST /api/dedup/suggestions/[id]/confirm — enqueue a confirm request for
 * one review-queue suggestion.
 *
 * Does NOT merge anything itself. It inserts a `suggested_merge_action`
 * row; the ETL container's poll loop (etl/dedup/actions.py) drains it by
 * calling the real `engine.confirm_suggestion()` — see lib/dedup.ts's
 * module docstring for why. The response returns immediately with the new
 * action's id; the frontend polls GET /api/dedup/actions/[id] for the
 * result.
 *
 * Error codes:
 *   400 — Invalid suggestion id
 *   404 — No such suggestion
 *   409 — Suggestion is no longer 'pending' (already confirmed/rejected/conflict)
 *   500 — Unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import { handleDedupActionRequest } from "@/lib/dedup-action-route";

type RouteContext = {
  params: Promise<{ id: string }> | { id: string };
};

export async function POST(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return handleDedupActionRequest(context, "confirm");
}
