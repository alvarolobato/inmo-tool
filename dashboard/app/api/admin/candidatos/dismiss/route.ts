/**
 * POST /api/admin/candidatos/dismiss — mark a `candidate_type` slug as
 * reviewed-and-rejected (#407).
 *
 * Body: { slug: string, reason?: string }. The slug is normalized with the same
 * `normalizeCandidateType` the redflags parser uses, so the stored key matches
 * exactly what the trending/promotion queries group by (a slug that normalizes
 * to empty is rejected with 400). Idempotent: dismissing the same slug again
 * updates the reason/timestamp.
 *
 * Effects (see `lib/db/redflag-candidates.ts`):
 *   - drops the slug from the promotion list (`/admin/candidatos`);
 *   - drops it from the redflags prompt's "recent candidates" trending block;
 *   - injects it into the prompt as "previously reviewed and rejected".
 *
 * Admin-gated (`ADMIN_API_KEY`) — same guard as every other /api/admin route.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { adminApiKeyValid, adminUnauthorized } from "@/lib/admin-api-auth";
import { dismissCandidateType } from "@/lib/db/redflag-candidates";
import { normalizeCandidateType } from "@/lib/ai-assessment/redflags";

const DismissSchema = z.object({
  slug: z.string(),
  reason: z.string().optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!adminApiKeyValid(request)) {
    return adminUnauthorized();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = DismissSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation error", details: parsed.error.format() },
      { status: 400 },
    );
  }

  // Normalize with the same rule the parser applies to model output, so the
  // dismissed key matches what the trending/promotion queries group by.
  const slug = normalizeCandidateType(parsed.data.slug);
  if (!slug) {
    return NextResponse.json(
      { error: "slug is empty after normalization" },
      { status: 400 },
    );
  }

  const reason = parsed.data.reason?.trim() || null;

  try {
    await dismissCandidateType(slug, reason);
  } catch (err) {
    console.error("[candidatos/dismiss] Failed to persist dismissal:", err);
    return NextResponse.json({ error: "Failed to dismiss candidate" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, slug, reason });
}
