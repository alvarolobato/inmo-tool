/**
 * POST /api/etl/llm-quota — ingest a subscription-quota reading (D-107).
 * GET  /api/etl/llm-quota — read the latest reading and the cap's verdict.
 *
 * ## Why an endpoint instead of the dashboard reading it directly
 *
 * `claude -p "/usage"` only reports subscription consumption under the
 * interactive OAuth credential file. Verified by running the host's CLI with
 * the container's `CLAUDE_CODE_OAUTH_TOKEN`: it returns a local session-cost
 * summary instead. The dashboard container therefore *cannot* read the quota
 * no matter what it runs, so the reading has to be pushed in from where the
 * credentials live — the host — exactly like the launchd credential sync
 * (D-025). `scripts/claude-quota-poller.sh` is that pusher.
 *
 * The probe itself is free: `total_cost_usd: 0`, zero tokens, no model call.
 *
 * Admin-gated by middleware's `/api/etl/:path*` matcher, and the POST
 * re-checks the admin key explicitly since it writes.
 *
 * Error codes:
 *   400 — Body is not a usable `/usage` payload
 *   401 — Missing/invalid admin credentials
 *   500 — Unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import { adminApiKeyValid, adminUnauthorized } from "@/lib/admin-api-auth";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";
import { parseUsageOutput, evaluateQuota, isQuotaUnknown } from "@/lib/llm-quota";
import { saveQuotaReading, getLatestQuotaReading } from "@/lib/db/llm-quota";
import { getSystemConfig } from "@/lib/system-config/loader";

export const dynamic = "force-dynamic";

function readInt(key: string, fallback: number): number {
  try {
    const raw = getSystemConfig()[key]?.value;
    if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
    const n = Number(String(raw).trim());
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  } catch {
    return fallback;
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();
  if (!adminApiKeyValid(request)) return adminUnauthorized();

  try {
    const body = (await request.json()) as { usage_text?: unknown; source?: unknown };
    const text = typeof body.usage_text === "string" ? body.usage_text : "";
    if (!text.trim()) {
      return NextResponse.json(
        formatApiError("Falta usage_text.", "VALIDATION", undefined, requestId),
        { status: 400 },
      );
    }

    const snapshot = parseUsageOutput(text);
    if (isQuotaUnknown(snapshot)) {
      // Refuse to store a reading with no windows: an all-null row would look
      // like a fresh reading to the staleness check while telling us nothing,
      // which is worse than having no reading at all.
      return NextResponse.json(
        formatApiError(
          "No se reconoció ninguna ventana de consumo en usage_text. " +
            "¿Ha cambiado el formato de `claude -p \"/usage\"`?",
          "VALIDATION",
          undefined,
          requestId,
        ),
        { status: 400 },
      );
    }

    const source = typeof body.source === "string" && body.source.trim()
      ? body.source.trim().slice(0, 64)
      : "host-poller";
    await saveQuotaReading(snapshot, source);
    return NextResponse.json({ ok: true, snapshot });
  } catch (err) {
    console.error(`[${requestId}] POST llm-quota failed:`, err);
    return NextResponse.json(
      formatApiError(sanitizeErrorMessage(err), "UNKNOWN", undefined, requestId),
      { status: 500 },
    );
  }
}

export async function GET(): Promise<NextResponse> {
  const requestId = generateRequestId();
  try {
    const snapshot = await getLatestQuotaReading();
    const threshold = readInt("dashboard.llm_quota_stop_pct", 0);
    const maxAge = readInt("dashboard.llm_quota_max_age_seconds", 1800);
    return NextResponse.json({
      snapshot,
      threshold_pct: threshold,
      max_age_seconds: maxAge,
      verdict: evaluateQuota(snapshot, threshold, maxAge),
    });
  } catch (err) {
    console.error(`[${requestId}] GET llm-quota failed:`, err);
    return NextResponse.json(
      formatApiError(sanitizeErrorMessage(err), "UNKNOWN", undefined, requestId),
      { status: 500 },
    );
  }
}
