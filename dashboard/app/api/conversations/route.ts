/**
 * GET  /api/conversations — list conversations with filters and pagination
 * POST /api/conversations — create a new conversation
 */

import { NextRequest, NextResponse } from "next/server";
import {
  listConversations,
  createConversation,
  setInitialContext,
} from "@/lib/conversations";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";
import { buildFreeChatInitialContextSnapshot } from "@/lib/conversation-context";
import {
  getEffectiveDashboardModel,
  loadDashboardLlmConfig,
} from "@/lib/llm-provider/config";
import type { DashboardLlmFlow } from "@/lib/llm-provider/types";

const VALID_MODES = new Set([
  "generate",
  "modify",
  "analyze",
  "summary",
  "title",
  "weekly",
  "chat",
  "suggest",
  "gap",
]);

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { searchParams } = new URL(request.url);

  const include_archived = searchParams.get("include_archived") === "true";
  const only_archived = searchParams.get("only_archived") === "true";
  const context_kindsParam = searchParams.getAll("context_kind");
  const context_kinds = context_kindsParam.length > 0 ? context_kindsParam : undefined;
  const context_ref = searchParams.get("context_ref") ?? undefined;
  const modesParam = searchParams.getAll("mode").filter((m) => VALID_MODES.has(m));
  const modes = modesParam.length > 0 ? modesParam : undefined;
  const sinceRaw = searchParams.get("since") ?? undefined;
  if (sinceRaw !== undefined && isNaN(Date.parse(sinceRaw))) {
    return NextResponse.json(
      formatApiError(
        "El parámetro 'since' debe ser una fecha válida (ISO 8601).",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }
  const since = sinceRaw;
  const q = searchParams.get("q") ?? undefined;
  const page = parseInt(searchParams.get("page") ?? "1", 10);
  const limit = parseInt(searchParams.get("limit") ?? "50", 10);

  try {
    const rows = await listConversations({
      include_archived,
      only_archived,
      context_kinds,
      context_ref,
      modes,
      since,
      q,
      page: isNaN(page) ? 1 : page,
      limit: isNaN(limit) ? 50 : limit,
    });
    return NextResponse.json(rows);
  } catch (err) {
    console.error(`[${requestId}] GET /api/conversations error:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudieron cargar las conversaciones.",
        "DB_ERROR",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      formatApiError("El cuerpo de la solicitud no es JSON válido.", "INVALID_BODY", undefined, requestId),
      { status: 400 },
    );
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json(
      formatApiError("El cuerpo debe ser un objeto JSON.", "INVALID_BODY", undefined, requestId),
      { status: 400 },
    );
  }

  const b = body as Record<string, unknown>;
  const mode = b.mode;
  if (typeof mode !== "string" || !mode.trim()) {
    return NextResponse.json(
      formatApiError("El campo 'mode' es obligatorio.", "MISSING_MODE", undefined, requestId),
      { status: 400 },
    );
  }

  if (!VALID_MODES.has(mode)) {
    return NextResponse.json(
      formatApiError(
        `Modo '${mode}' no válido. Valores permitidos: ${[...VALID_MODES].join(", ")}.`,
        "INVALID_MODE",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  const context_url = typeof b.context_url === "string" ? b.context_url : undefined;
  const context_kind = typeof b.context_kind === "string" ? b.context_kind : undefined;
  const context_ref = typeof b.context_ref === "string" ? b.context_ref : undefined;
  const first_user_prompt =
    typeof b.first_user_prompt === "string" ? b.first_user_prompt : undefined;
  const llm_provider = typeof b.llm_provider === "string" ? b.llm_provider : undefined;
  const llm_driver = typeof b.llm_driver === "string" ? b.llm_driver : undefined;
  // Caller can explicitly pass the flow (e.g., "analyze"/"modify"); falls back to mode.
  const flow = (typeof b.flow === "string" ? b.flow : mode) as DashboardLlmFlow;

  try {
    const result = await createConversation({
      mode,
      context_url,
      context_kind,
      context_ref,
      first_user_prompt,
      llm_provider,
      llm_driver,
    });

    // Always snapshot initial_context at creation. We capture the snapshot
    // object and merge it into the response — `result` comes from the INSERT
    // RETURNING and has initial_context=null because setInitialContext runs
    // afterwards. Without this merge the client receives null and
    // "Contexto original" never appears on first send.
    let initialContextValue: Record<string, unknown> | null = null;
    try {
      if (context_kind === "global" || mode === "chat") {
        initialContextValue = buildFreeChatInitialContextSnapshot() as unknown as Record<string, unknown>;
      } else {
        const cfg = loadDashboardLlmConfig();
        initialContextValue = {
          model: getEffectiveDashboardModel(cfg, flow),
          provider: cfg.provider,
          driver: cfg.provider === "cli" ? cfg.cliDriver : null,
          system_prompt_stable: "",
          tools: [],
          config: { flow },
        };
      }
      await setInitialContext(result.id, initialContextValue as unknown as Parameters<typeof setInitialContext>[1]);
    } catch (snapshotErr) {
      console.warn(
        `[${requestId}] POST /api/conversations setInitialContext failed for ${result.id}:`,
        snapshotErr,
      );
    }

    return NextResponse.json(
      { ...result, initial_context: initialContextValue },
      { status: 201 },
    );
  } catch (err) {
    console.error(`[${requestId}] POST /api/conversations error:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo crear la conversación.",
        "DB_ERROR",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
