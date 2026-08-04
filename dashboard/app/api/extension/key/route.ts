/**
 * GET /api/extension/key — surface the admin API key to the authenticated admin (issue #256).
 *
 * The browser extension's options page needs `ADMIN_API_KEY` pasted into it. This
 * returns that key so the operator can copy it from the setup page instead of
 * digging it out of `.env`.
 *
 * SECURITY: this endpoint returns the admin credential in its body, so leaking it
 * unauthenticated would be a full compromise. It is gate-by-default in middleware
 * (`/api/extension/*` is not on the public allow-list) AND re-checks the credential
 * in-route (defense in depth + so the "rejects without auth" test does not depend on
 * middleware). The caller is already the authenticated admin — surfacing their own
 * key back to them on a same-origin, cookie-authenticated request adds no exposure
 * they don't already have (issue #256: single-operator, localhost). The key is read
 * from the environment only, never from config.yaml (see admin-api-auth.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { adminApiKeyValid, adminUnauthorized } from "@/lib/admin-api-auth";

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!adminApiKeyValid(request)) {
    return adminUnauthorized();
  }

  const key = process.env.ADMIN_API_KEY?.trim();
  if (!key) {
    // Fail closed: middleware returns 503 when ADMIN_API_KEY is unset, so a valid
    // request should never reach here without a key — but never emit an empty body
    // that the UI might render as a blank "copy me" field.
    return NextResponse.json(
      { error: "admin_not_configured", detail: "ADMIN_API_KEY no está configurada." },
      { status: 503 },
    );
  }

  return NextResponse.json({ key }, { headers: { "Cache-Control": "no-store" } });
}
