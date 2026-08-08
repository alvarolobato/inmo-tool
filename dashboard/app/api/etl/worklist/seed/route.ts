/**
 * POST /api/etl/worklist/seed — trigger a sitemap seed of the capture worklist
 * (issue #260).
 *
 * The worklist page's "Refrescar sitemap" button. Body: `{ portal?: string }`
 * (defaults to 'cimenta2'). Inserts a pending `capture_worklist_seed_trigger`
 * row and returns its id; the ETL poll loop (etl/worklist_seed.py) picks it up
 * within ~10s, fetches the portal's public sitemap (ONE static GET,
 * discovery-only) and upserts pending worklist rows.
 *
 * Why a queue table, not a synchronous seed: the sitemap fetch + parse runs in
 * the Python ETL container — the dashboard can only signal it, never execute it
 * in-process. Exactly the etl_manual_trigger idiom (dashboard/app/api/etl/run).
 *
 * Admin-gated by middleware.ts's `/api/etl/:path*` matcher; the handler also
 * re-checks the admin key explicitly (belt-and-suspenders, matching the
 * connector-run write route) since it writes into the ingestion pipeline.
 *
 * Error codes:
 *   400 — Invalid body, or a portal that has no sitemap seeder
 *   401 — Missing/invalid admin credentials
 *   409 — A seed for this portal is already pending
 *   500 — Unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import { adminApiKeyValid, adminUnauthorized } from "@/lib/admin-api-auth";
import {
  createWorklistSeedTrigger,
  getPendingWorklistSeedTrigger,
  PG_UNIQUE_VIOLATION,
} from "@/lib/db/worklist-seed";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";
import { SITEMAP_SEEDABLE_PORTALS } from "@/lib/worklist";

// Writes Postgres per request; never prerender at build (no DB then).
export const dynamic = "force-dynamic";

// The default portal to seed when the body omits one: the first
// extension-capturable sitemap-seedable portal, or undefined when none qualify
// (issue #454 — cimenta2 moved to ETL fetch, so today the list is empty and a
// bodyless request is a 400 rather than silently seeding a stale portal).
const DEFAULT_PORTAL: string | undefined = SITEMAP_SEEDABLE_PORTALS[0];

interface SeedBody {
  portal?: unknown;
}

function pgErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();
  if (!adminApiKeyValid(request)) {
    return adminUnauthorized();
  }

  // Body is optional: no body (or `{}`) seeds the default portal.
  let body: SeedBody = {};
  const raw = await request.text();
  if (raw.trim() !== "") {
    try {
      body = JSON.parse(raw) as SeedBody;
    } catch {
      return NextResponse.json(
        formatApiError("El cuerpo de la petición no es JSON válido.", "VALIDATION", undefined, requestId),
        { status: 400 },
      );
    }
  }

  let portal = DEFAULT_PORTAL;
  if (body.portal !== undefined && body.portal !== null) {
    if (typeof body.portal !== "string" || body.portal.trim() === "") {
      return NextResponse.json(
        formatApiError("'portal' debe ser un texto no vacío.", "VALIDATION", undefined, requestId),
        { status: 400 },
      );
    }
    portal = body.portal.trim();
  }

  if (portal === undefined || !SITEMAP_SEEDABLE_PORTALS.includes(portal)) {
    const admitted =
      SITEMAP_SEEDABLE_PORTALS.length > 0
        ? `Portales admitidos: ${SITEMAP_SEEDABLE_PORTALS.join(", ")}.`
        : "Ningún portal admite siembra por sitemap actualmente " +
          "(los conectores fetch-por-ETL como cimenta2 no se siembran en la " +
          "lista de la extensión, #454).";
    return NextResponse.json(
      formatApiError(
        `El portal "${portal ?? ""}" no admite siembra por sitemap. ${admitted}`,
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  try {
    let triggerId: number;
    try {
      triggerId = await createWorklistSeedTrigger(portal);
    } catch (err) {
      if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
        const pending = await getPendingWorklistSeedTrigger(portal);
        return NextResponse.json(
          {
            ...formatApiError(
              "Ya hay una siembra pendiente para este portal. Espera a que termine.",
              "CONFLICT",
              undefined,
              requestId,
            ),
            pending_trigger_id: pending?.id ?? null,
          },
          { status: 409 },
        );
      }
      throw err;
    }

    return NextResponse.json({ trigger_id: triggerId, status: "pending", portal });
  } catch (err) {
    console.error(`[${requestId}] Error al encolar la siembra de la worklist:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo encolar la siembra. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
