/**
 * PATCH /api/etl/connectors/:name — update one connector's config: enable/
 * disable, geography override, native site filters (issue #100).
 *
 * Admin-gated by middleware.ts's `/api/etl/:path*` matcher (see the sibling
 * route's docstring for why this lives under /api/etl).
 *
 * Error codes:
 *   400 — Invalid body, or a filter key this connector doesn't support
 *   401 — Missing/invalid admin credentials (enforced by middleware)
 *   404 — No such connector in the registry
 *   500 — Unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { ConnectorConfigPatchSchema } from "@/lib/connectors-schema";
import { getConnectorRegistryInfo, updateConnectorConfig } from "@/lib/db/connectors";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

// Matches the union style used by the other dynamic routes in this app
// (see app/api/profiles/[id]/route.ts) — Next 15 passes a Promise, but the
// unit tests call the handler directly with a plain object.
type RouteContext = { params: Promise<{ name: string }> | { name: string } };

export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { name } = await context.params;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      formatApiError("El cuerpo de la petición no es JSON válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  let patch;
  try {
    patch = ConnectorConfigPatchSchema.parse(rawBody);
  } catch (err) {
    const detail = err instanceof ZodError ? err.issues.map((i) => i.message).join("; ") : undefined;
    return NextResponse.json(
      formatApiError("Configuración de conector no válida.", "VALIDATION", detail, requestId),
      { status: 400 },
    );
  }

  try {
    // 404 on an unregistered name rather than silently writing a row that
    // would never take effect: `_scopes_for_connector` looks up by exact
    // name, so a typo'd row is a no-op the operator has no way to notice
    // (the ETL only warns about it at run start — issue #99). Rejecting it
    // here is the earliest honest failure point.
    const registry = await getConnectorRegistryInfo(name);
    if (registry === null) {
      return NextResponse.json(
        formatApiError(
          `No existe ningún conector registrado con el nombre "${name}".`,
          "NOT_FOUND",
          undefined,
          requestId,
        ),
        { status: 404 },
      );
    }

    // A connector no longer in the Python registry can never run again, so
    // every config change is a no-op the operator has no way to notice —
    // the same "control that looks like it works but doesn't" failure the
    // capability checks below exist to prevent (issue #100 review). 409:
    // the request is well-formed, it conflicts with the resource's state.
    if (!registry.registered) {
      return NextResponse.json(
        formatApiError(
          `El conector "${name}" ya no está registrado en el ETL, así que su configuración no tendría ningún efecto.`,
          "CONFLICT",
          "Solo se conserva para que su historial de ejecuciones siga siendo legible.",
          requestId,
        ),
        { status: 409 },
      );
    }

    // A connector that never runs discover() (Idealista — capture-only,
    // issue #75) has no scope to override and no filters to apply. Accepting
    // either would store config that can never take effect, which is exactly
    // the "control that looks like it works but doesn't" issue #100 calls out.
    if (!registry.supports_discovery) {
      if (patch.geography_override) {
        return NextResponse.json(
          formatApiError(
            `El conector "${name}" es de solo captura: no realiza búsquedas propias, así que un ámbito geográfico no tendría ningún efecto.`,
            "VALIDATION",
            undefined,
            requestId,
          ),
          { status: 400 },
        );
      }
      if (patch.filters && Object.keys(patch.filters).length > 0) {
        return NextResponse.json(
          formatApiError(
            `El conector "${name}" es de solo captura: no admite filtros de búsqueda.`,
            "VALIDATION",
            undefined,
            requestId,
          ),
          { status: 400 },
        );
      }
    }

    // Cross-check filter keys against what this connector actually honours.
    // Only filters live-verified per site are declared in the registry
    // (issue #99 confirmed exactly one: Fotocasa's exact-match room count),
    // so an unverified filter can't be persisted even by a hand-built
    // request that bypasses the UI.
    if (patch.filters) {
      const unsupported = Object.keys(patch.filters).filter(
        (key) => !registry.supported_filters.includes(key),
      );
      if (unsupported.length > 0) {
        return NextResponse.json(
          formatApiError(
            `El conector "${name}" no admite el filtro: ${unsupported.join(", ")}.`,
            "VALIDATION",
            `Filtros admitidos: ${registry.supported_filters.join(", ") || "(ninguno)"}`,
            requestId,
          ),
          { status: 400 },
        );
      }
    }

    await updateConnectorConfig(name, patch);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(`[${requestId}] Error al actualizar el conector ${name}:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo actualizar la configuración del conector. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
