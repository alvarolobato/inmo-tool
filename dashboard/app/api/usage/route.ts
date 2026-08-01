/**
 * GET /api/usage — LLM usage aggregates from llm_usage table.
 *
 * Returns HTTP 200 always. Returns zero-shape when table is empty or DB unreachable.
 *
 * `by_endpoint[]` includes `endpoint_label_es` and `endpoint_detail_es` (stable copy for
 * known `logUsage` keys in `lib/llm.ts`); unknown keys still return a generic label/detail.
 */

import { NextResponse } from "next/server";
import { getLlmUsageAggregates } from "@/lib/llm-usage-stats";

export async function GET(): Promise<NextResponse> {
  const body = await getLlmUsageAggregates();
  return NextResponse.json(body);
}
