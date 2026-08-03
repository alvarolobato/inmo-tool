/**
 * POST /api/dedup/suggestions/[id]/reject — enqueue a reject request for one
 * review-queue suggestion. See confirm/route.ts's docstring for the full
 * queue/poll contract (the reject path is identical, only the enqueued
 * `action` differs).
 *
 * A rejected suggestion's `status` stays 'rejected' forever — `engine.run`'s
 * `_load_recorded_pairs` keeps every non-'confirmed' status (pending,
 * rejected, conflict) in its skip set, so a rejected pair is never
 * re-suggested by a later dedup run.
 */

import { NextRequest, NextResponse } from "next/server";
import { handleDedupActionRequest } from "@/lib/dedup-action-route";

type RouteContext = {
  params: Promise<{ id: string }> | { id: string };
};

export async function POST(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return handleDedupActionRequest(context, "reject");
}
