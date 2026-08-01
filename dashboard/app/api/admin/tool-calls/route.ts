import { NextRequest, NextResponse } from "next/server";
import { adminApiKeyValid, adminUnauthorized } from "@/lib/admin-api-auth";
import { fetchToolCallAggregates } from "@/lib/llm-tools/logging";

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!adminApiKeyValid(request)) {
    return adminUnauthorized();
  }

  const rows = await fetchToolCallAggregates();
  return NextResponse.json({ aggregates: rows, window_days: 30 });
}
