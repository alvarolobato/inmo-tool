import { NextRequest, NextResponse } from "next/server";
import { adminApiKeyValid, adminUnauthorized } from "@/lib/admin-api-auth";
import { fetchSlowQueries } from "@/lib/admin-slow-queries";

export type { SlowQuery, SlowQueriesResponse } from "@/lib/admin-slow-queries";

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!adminApiKeyValid(request)) {
    return adminUnauthorized();
  }

  const body = await fetchSlowQueries();
  return NextResponse.json(body);
}
