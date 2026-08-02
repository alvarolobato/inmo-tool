/**
 * POST /api/profiles/materialize-all — Re-run the hard-filter engine
 * (task 2.4, #18) for every active (non-archived) profile.
 *
 * The "simplest v1" trigger issue #18 names for the after-new-listings-land
 * case: cheap enough at this project's current data volumes to re-run for
 * all profiles rather than target only the ones a specific connector run
 * might have affected.
 *
 * Called automatically by the Python connector orchestrator at the end of
 * every run (issue #94 — see `notify_materialize_all` in
 * `etl/orchestrator.py`), closing the gap where a freshly-ingested property
 * stayed unscored indefinitely until a human manually triggered
 * materialization. Still callable by hand for an out-of-band refresh.
 *
 * Auth: requires the admin key (issue #94). This is a cross-container,
 * network-facing write trigger — it re-materializes every profile and kicks
 * off scoring — so it is gated exactly like `/api/admin/*` and the extension
 * capture route (#75's security fix). `middleware.ts`'s matcher does NOT
 * cover `/api/profiles/*`, so the check lives in the handler; both mechanisms
 * accept the same credential forms (`x-admin-key`, `Authorization: Bearer`,
 * or the `ps_admin` cookie), so an operator's browser session and the ETL's
 * header-based call both authenticate against the same secret.
 *
 * Error codes:
 *   401 — Missing/invalid admin credentials
 *   500 — Unexpected error
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { materializeAllProfiles } from "@/lib/filtering/materialize";
import { adminApiKeyValid, adminUnauthorized } from "@/lib/admin-api-auth";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!adminApiKeyValid(request)) {
    return adminUnauthorized();
  }

  const requestId = generateRequestId();
  try {
    const results = await materializeAllProfiles();
    return NextResponse.json({ profiles: results });
  } catch (err) {
    console.error(`[${requestId}] Error al recalcular candidatos de todos los perfiles:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudieron recalcular los candidatos de los perfiles.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
