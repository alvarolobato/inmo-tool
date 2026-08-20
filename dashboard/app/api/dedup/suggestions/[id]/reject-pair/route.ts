/**
 * POST /api/dedup/suggestions/[id]/reject-pair — enqueue a `reject_pair`
 * request against one representative suggestion (issue #605 Part 2
 * revision, PR #611 review B1). See confirm/route.ts's docstring for the
 * shared queue/poll contract; this route only differs in which action it
 * enqueues.
 *
 * `[id]` is the GROUP's representative suggestion — normally
 * `evidence[0].suggestion_id`, the strongest-confidence row the dashboard
 * showed as the primary comparison. The ETL side (`etl.dedup.engine.
 * reject_property_pair`, called by `etl/dedup/actions.py`'s
 * `process_pending_actions`) derives the PROPERTY pair from that
 * suggestion's listings and rejects EVERY currently-pending
 * suggested_merge row between the two properties — not just this one id —
 * plus persists a permanent `property_merge_veto`. This is deliberately
 * ONE action for the whole group, not one per underlying evidence row: a
 * per-row fan-out would leave a partial-failure state (some rows rejected,
 * some not) with no way to retry cleanly, and would only ever bind the
 * exact listing pairs the dashboard's snapshot happened to show.
 *
 * A rejected property pair is permanent — `property_merge_veto` has no
 * "undo" path, same as a plain `reject`'s listing-level permanence
 * (`_load_recorded_pairs` keeps 'rejected' in its skip set forever).
 */

import { NextRequest, NextResponse } from "next/server";
import { handleDedupActionRequest } from "@/lib/dedup-action-route";

type RouteContext = {
  params: Promise<{ id: string }> | { id: string };
};

export async function POST(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return handleDedupActionRequest(context, "reject_pair");
}
