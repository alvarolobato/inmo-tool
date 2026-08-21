/**
 * POST /api/extension/block-episode — browser-extension block/challenge
 * episode report (issue #634).
 *
 * The extension can NOT inject into the dashboard origin (its manifest
 * host_permissions cover only the portal hosts), so — same pattern as
 * /api/extension/heartbeat — reporting a detected CAPTCHA/WAF block is
 * SERVER-MEDIATED: background.js fire-and-forget POSTs here exactly once per
 * NEW block episode (see its handleBlockDetected), after it has already
 * paused the run and fired a local chrome.notifications alert. /etl/salud
 * reads the recent history via GET /api/etl/data-health.
 *
 * `signature` is a marker id only (e.g. 'captcha_wall', 'cloudflare_challenge')
 * — the extension never sends page content or the captured URL, and this
 * route does not accept them; this is a public repo (no scraped listing
 * data in any committed OR stored payload from this route).
 *
 * Admin-gated exactly like /api/extension/capture and /api/extension/heartbeat:
 * gate-by-default in middleware (`/api/extension/*` is not on the public
 * allow-list) AND re-checked in-route (defense in depth).
 *
 * Error codes:
 *   400 — missing/invalid portal or signature
 *   401 — missing/invalid admin credentials
 *   500 — unexpected error persisting the episode
 */

import { NextRequest, NextResponse } from "next/server";
import { recordBlockEpisode } from "@/lib/db/extension-blocks";
import { adminApiKeyValid, adminUnauthorized } from "@/lib/admin-api-auth";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

// Writes a row per request; never prerender.
export const dynamic = "force-dynamic";

interface BlockEpisodeBody {
  portal?: unknown;
  signature?: unknown;
  detectedAt?: unknown;
}

const MAX_FIELD_LEN = 64;

function cleanField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_FIELD_LEN);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();
  if (!adminApiKeyValid(request)) {
    return adminUnauthorized();
  }

  let body: BlockEpisodeBody | null = null;
  try {
    body = (await request.json()) as BlockEpisodeBody;
  } catch {
    body = null;
  }

  const portal = cleanField(body?.portal);
  const signature = cleanField(body?.signature);
  if (!portal || !signature) {
    return NextResponse.json(
      formatApiError(
        "Falta portal o signature en el episodio de bloqueo.",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  const detectedAtRaw = typeof body?.detectedAt === "string" ? body.detectedAt : null;
  const parsed = detectedAtRaw ? new Date(detectedAtRaw) : new Date();
  const detectedAt = Number.isNaN(parsed.getTime()) ? new Date() : parsed;

  try {
    await recordBlockEpisode(portal, signature, detectedAt);
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(`[${requestId}] No se pudo registrar el episodio de bloqueo:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo registrar el episodio de bloqueo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
