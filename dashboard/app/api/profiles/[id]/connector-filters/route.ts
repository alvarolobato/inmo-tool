/**
 * /api/profiles/[id]/connector-filters — owner-pinned search URLs per
 * (profile × connector × section) — issue #478 P1.
 *
 * GET:    list the pinned overrides for a profile.
 * PUT:    pin (or re-pin) an override — the FIXED search URL that becomes the
 *         connector's recall source for this profile (tier 0 in the resolver,
 *         superseding the derived URL). Validates the profile exists and is not
 *         archived, that the URL is an http(s) URL whose host belongs to the
 *         connector, and that the connector is an extension capture portal (HTTP
 *         connectors are "todavía no soportado" until Phase 4). URL stored
 *         VERBATIM (shape= intact) — never re-substituted.
 * DELETE: remove an override, reverting to the derived URL. `connector` (and
 *         optional `sectionKey`) come from the query string.
 *
 * Auth: the app is admin-gated by middleware, but this route ALSO checks
 * `adminApiKeyValid` explicitly as defense-in-depth because Phase 3 calls PUT
 * from the browser extension via the `x-admin-key` channel (the pattern the
 * extension/* routes use). Error messages are Spanish-facing (pattern:
 * captured-search-urls/route.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { adminApiKeyValid, adminUnauthorized } from "@/lib/admin-api-auth";
import { getProfileById } from "@/lib/db/profiles";
import { CAPTURE_PORTALS } from "@/lib/worklist";
import {
  findOverridesForProfile,
  upsertProfileConnectorFilter,
  deleteProfileConnectorFilter,
  type ProfileConnectorFilterSource,
} from "@/lib/db/profile-connector-filter";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

type RouteContext = { params: Promise<{ id: string }> | { id: string } };

const ALLOWED_URL_SCHEMES = new Set(["http:", "https:"]);
const ALLOWED_SOURCES = new Set<ProfileConnectorFilterSource>(["manual", "extension"]);
// A pinned URL is verbatim but should still be bounded so a malformed value
// can't bloat a row.
const MAX_URL_LEN = 4000;

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * The host suffix an override URL must fall under for `connector`, or null when
 * the connector is not (yet) supported. Phase 1 supports only the extension
 * capture portals (CAPTURE_PORTALS); HTTP connectors arrive in Phase 4 with
 * their own `override_host_suffix` from the connector registry.
 */
function hostSuffixForConnector(connector: string): string | null {
  return CAPTURE_PORTALS.find((p) => p.portal === connector)?.hostSuffix ?? null;
}

/** True when `host` is exactly `suffix` or a subdomain of it (rejects look-alikes). */
function isHostUnder(host: string, suffix: string): boolean {
  const h = host.toLowerCase();
  return h === suffix || h.endsWith("." + suffix);
}

interface PutBody {
  connector?: unknown;
  sectionKey?: unknown;
  url?: unknown;
  source?: unknown;
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = generateRequestId();
  if (!adminApiKeyValid(request)) return adminUnauthorized();

  const { id: rawId } = await context.params;
  const id = parseId(rawId);
  if (id === null) {
    return NextResponse.json(
      formatApiError("Id de perfil no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  try {
    const rows = await findOverridesForProfile(id);
    return NextResponse.json({ success: true, rows });
  } catch (err) {
    console.error(`[${requestId}] Error al listar los filtros por conector:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudieron cargar los filtros por conector.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = generateRequestId();
  if (!adminApiKeyValid(request)) return adminUnauthorized();

  const { id: rawId } = await context.params;
  const id = parseId(rawId);
  if (id === null) {
    return NextResponse.json(
      formatApiError("Id de perfil no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  let body: PutBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      formatApiError("Cuerpo de la petición inválido (se esperaba JSON).", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  const connector = typeof body.connector === "string" ? body.connector.trim() : "";
  if (!connector) {
    return NextResponse.json(
      formatApiError("Falta el campo 'connector'.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  const hostSuffix = hostSuffixForConnector(connector);
  if (hostSuffix === null) {
    return NextResponse.json(
      formatApiError(
        `El conector '${connector}' todavía no soporta filtros fijados (llega en la Fase 4).`,
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  if (!body.url || typeof body.url !== "string") {
    return NextResponse.json(
      formatApiError("Falta el campo 'url'.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }
  if (body.url.length > MAX_URL_LEN) {
    return NextResponse.json(
      formatApiError("La 'url' es demasiado larga.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(body.url);
  } catch {
    return NextResponse.json(
      formatApiError("'url' no es una URL válida.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }
  if (!ALLOWED_URL_SCHEMES.has(parsedUrl.protocol)) {
    return NextResponse.json(
      formatApiError("'url' debe usar http o https.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }
  if (!isHostUnder(parsedUrl.hostname, hostSuffix)) {
    return NextResponse.json(
      formatApiError(
        `La 'url' debe pertenecer al dominio del conector (${hostSuffix}).`,
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  const sectionKey = typeof body.sectionKey === "string" ? body.sectionKey : "";
  const source: ProfileConnectorFilterSource =
    typeof body.source === "string" && ALLOWED_SOURCES.has(body.source as ProfileConnectorFilterSource)
      ? (body.source as ProfileConnectorFilterSource)
      : "manual";

  try {
    const profile = await getProfileById(id);
    if (!profile || profile.archived_at !== null) {
      return NextResponse.json(
        formatApiError(
          "Perfil de búsqueda no encontrado o archivado.",
          "NOT_FOUND",
          undefined,
          requestId,
        ),
        { status: 404 },
      );
    }

    // Store the URL VERBATIM — do not normalise `body.url` (shape= must survive).
    const row = await upsertProfileConnectorFilter({
      profileId: id,
      connector,
      sectionKey,
      url: body.url,
      source,
    });
    return NextResponse.json({ success: true, row });
  } catch (err) {
    console.error(`[${requestId}] Error al guardar el filtro por conector:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo guardar el filtro por conector.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = generateRequestId();
  if (!adminApiKeyValid(request)) return adminUnauthorized();

  const { id: rawId } = await context.params;
  const id = parseId(rawId);
  if (id === null) {
    return NextResponse.json(
      formatApiError("Id de perfil no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  const connector = request.nextUrl.searchParams.get("connector")?.trim() ?? "";
  if (!connector) {
    return NextResponse.json(
      formatApiError("Falta el parámetro 'connector'.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }
  const sectionKey = request.nextUrl.searchParams.get("sectionKey") ?? "";

  try {
    const deleted = await deleteProfileConnectorFilter(id, connector, sectionKey);
    if (!deleted) {
      return NextResponse.json(
        formatApiError("No hay ningún filtro fijado para ese conector.", "NOT_FOUND", undefined, requestId),
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true, deleted: true });
  } catch (err) {
    console.error(`[${requestId}] Error al eliminar el filtro por conector:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo eliminar el filtro por conector.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
