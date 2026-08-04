/**
 * POST /api/etl/run — trigger an ad-hoc connector sweep (issue #244).
 * GET  /api/etl/run?id=N — report the status of a previously-triggered run.
 *
 * Revives a capability that was a hard `501`: the `etl_manual_trigger` table
 * was wired on the write side but nothing polled it. Now `etl/manual_trigger.py`
 * does. POST inserts a pending row (optionally scoped to one connector) and
 * returns its id; the ETL poll loop picks it up within ~10s and runs
 * `run_all_connectors`. GET lets the UI poll for pending/running/done/failed.
 *
 * Why a queue table, not a synchronous run: the orchestrator is Python in a
 * separate container — the dashboard can only signal a run, never execute one
 * in-process (same reasoning as the extension-capture path).
 *
 * Admin-gated by middleware.ts's `/api/etl/:path*` matcher; the POST also
 * re-checks the admin key explicitly (belt-and-suspenders, matching the
 * extension-capture write route) since it writes into the ingestion pipeline.
 *
 * Error codes:
 *   400 — Invalid body, or a non-numeric ?id on GET
 *   401 — Missing/invalid admin credentials
 *   404 — Unknown connector (POST) / unknown trigger id (GET)
 *   409 — Connector no longer registered, or a run is already pending
 *   500 — Unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import { adminApiKeyValid, adminUnauthorized } from "@/lib/admin-api-auth";
import { getConnectorRegistryInfo } from "@/lib/db/connectors";
import {
  createManualTrigger,
  getManualTriggerStatus,
  getPendingTrigger,
  PG_UNIQUE_VIOLATION,
} from "@/lib/db/manual-trigger";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

// Queries/writes Postgres per request; never prerender at build (no DB then).
export const dynamic = "force-dynamic";

interface RunBody {
  connector_name?: unknown;
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

  // Body is optional: no body (or `{}`) means a full sweep. An explicit
  // `connector_name` scopes the run to that one connector.
  let body: RunBody = {};
  const raw = await request.text();
  if (raw.trim() !== "") {
    try {
      body = JSON.parse(raw) as RunBody;
    } catch {
      return NextResponse.json(
        formatApiError("El cuerpo de la petición no es JSON válido.", "VALIDATION", undefined, requestId),
        { status: 400 },
      );
    }
  }

  let connectorName: string | null = null;
  if (body.connector_name !== undefined && body.connector_name !== null) {
    if (typeof body.connector_name !== "string" || body.connector_name.trim() === "") {
      return NextResponse.json(
        formatApiError("'connector_name' debe ser un texto no vacío.", "VALIDATION", undefined, requestId),
        { status: 400 },
      );
    }
    connectorName = body.connector_name.trim();
  }

  try {
    // Validate a named connector before queuing a row that could never run —
    // the same "control that looks like it works but doesn't" failure the
    // connector-config PATCH route guards against (issue #100).
    if (connectorName !== null) {
      const registry = await getConnectorRegistryInfo(connectorName);
      if (registry === null) {
        return NextResponse.json(
          formatApiError(
            `No existe ningún conector registrado con el nombre "${connectorName}".`,
            "NOT_FOUND",
            undefined,
            requestId,
          ),
          { status: 404 },
        );
      }
      if (!registry.registered) {
        return NextResponse.json(
          formatApiError(
            `El conector "${connectorName}" ya no está registrado en el ETL, así que no puede ejecutarse.`,
            "CONFLICT",
            undefined,
            requestId,
          ),
          { status: 409 },
        );
      }
    }

    let triggerId: number;
    try {
      triggerId = await createManualTrigger(connectorName);
    } catch (err) {
      // The single-pending-row partial index: a run is already queued and
      // hasn't been picked up yet. Report it rather than silently failing —
      // the UI can poll the existing one.
      if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
        const pending = await getPendingTrigger();
        return NextResponse.json(
          {
            ...formatApiError(
              "Ya hay una ejecución pendiente. Espera a que empiece antes de lanzar otra.",
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

    return NextResponse.json({
      trigger_id: triggerId,
      status: "pending",
      connector_name: connectorName,
    });
  } catch (err) {
    console.error(`[${requestId}] Error al encolar la ejecución del ETL:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo encolar la ejecución. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();
  const idParam = request.nextUrl.searchParams.get("id");
  const id = Number(idParam);
  if (!idParam || !Number.isInteger(id) || id <= 0) {
    return NextResponse.json(
      formatApiError("Falta el parámetro 'id' o no es un entero válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  try {
    const row = await getManualTriggerStatus(id);
    if (row === null) {
      return NextResponse.json(
        formatApiError(`No existe ninguna ejecución con id ${id}.`, "NOT_FOUND", undefined, requestId),
        { status: 404 },
      );
    }
    return NextResponse.json(row);
  } catch (err) {
    console.error(`[${requestId}] Error al consultar el estado de la ejecución ${id}:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo consultar el estado de la ejecución. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
