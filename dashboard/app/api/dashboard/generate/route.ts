/**
 * POST /api/dashboard/generate
 *
 * Request body: { prompt: string, stream?: boolean }
 * - stream false (default): success 200 = DashboardSpec JSON
 * - stream true: `application/x-ndjson` — lines emitted in order:
 *     { type: "meta",         requestId, message, promptPreview }
 *     { type: "conversation", requestId, conversationId, c_url }   ← new conversation row
 *     { type: "progress",     requestId, event: AgenticProgressEvent } (×N)
 *     { type: "phase",        requestId, message }                  (optional)
 *     { type: "result",       requestId, spec: DashboardSpec }      ← success
 *   OR
 *     { type: "error",        requestId, httpStatus, ...ApiErrorResponse }
 *
 * The `conversation` frame is sent once the server has persisted a row in the
 * conversations table. Clients should handle it being absent (DB failure) and
 * should not assume it arrives before the first `progress` frame.
 */

import { NextResponse } from "next/server";
import { generateDashboard } from "@/lib/llm";
import { buildLlmErrorPayload } from "@/lib/llm-error-payload";
import { validateSpec, type DashboardSpec } from "@/lib/schema";
import { lintDashboardSpec } from "@/lib/sql-heuristics";
import { ZodError } from "zod";
import {
  formatApiError,
  generateRequestId,
} from "@/lib/errors";
import {
  sql,
  createInteraction,
  appendInteractionLines,
  finishInteraction,
  type InteractionLine,
} from "@/lib/db-write";
import {
  createConversation,
  appendMessage,
  touchConversation,
  migrateConversationToDashboard,
} from "@/lib/conversations";
import { formatAgenticProgressLineEs } from "@/lib/format-agentic-progress";
import type { AgenticProgressEvent } from "@/lib/llm-tools/types";
import { loadDashboardLlmConfig } from "@/lib/llm-provider/config";

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

type GenerateFinishOk = { ok: true; spec: DashboardSpec };
type GenerateFinishErr = { ok: false; status: number; payload: Record<string, unknown> };

function finishGenerateFromRawLlm(rawResponse: string, requestId: string): GenerateFinishOk | GenerateFinishErr {
  const jsonStr = extractJson(rawResponse);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    console.error(`[${requestId}] El LLM devolvió JSON inválido (${jsonStr.length} chars)`);
    return {
      ok: false,
      status: 400,
      payload: formatApiError(
        "El modelo de IA devolvió una respuesta con formato incorrecto.",
        "LLM_INVALID_RESPONSE",
        undefined,
        requestId,
      ) as unknown as Record<string, unknown>,
    };
  }

  try {
    const spec = validateSpec(parsed);
    const sqlLint = lintDashboardSpec(spec);
    if (sqlLint.length > 0) {
      console.error(`[${requestId}] SQL heurístico rechazó el spec del LLM:`, sqlLint.join(" | "));
      return {
        ok: false,
        status: 400,
        payload: {
          ...formatApiError(
            "El modelo generó SQL con patrones inválidos para PostgreSQL (fechas/EXTRACT/COALESCE). Vuelve a generar o reformula el prompt.",
            "SQL_LINT",
            sqlLint.join(" | "),
            requestId,
          ),
        } as Record<string, unknown>,
      };
    }
    return { ok: true, spec };
  } catch (err: unknown) {
    const details =
      err instanceof ZodError
        ? err.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")
        : "Error de validación desconocido";

    console.error(`[${requestId}] El LLM devolvió un spec inválido:`, details);

    const allowedFields =
      err instanceof ZodError ? resolveWidgetAllowedFields(err, parsed) : undefined;

    return {
      ok: false,
      status: 400,
      payload: {
        ...formatApiError(
          "El modelo de IA generó un dashboard con estructura incorrecta.",
          "LLM_INVALID_RESPONSE",
          details,
          requestId,
        ),
        ...(allowedFields !== undefined ? { allowedFields } : {}),
      } as Record<string, unknown>,
    };
  }
}


const WIDGET_ALLOWED_FIELDS: Record<string, string[]> = {
  kpi_row: ["id", "type", "items"],
  bar_chart: ["id", "type", "title", "sql", "x", "y", "comparison_sql"],
  line_chart: ["id", "type", "title", "sql", "x", "y", "comparison_sql"],
  area_chart: ["id", "type", "title", "sql", "x", "y", "comparison_sql"],
  donut_chart: ["id", "type", "title", "sql", "x", "y", "comparison_sql"],
  table: ["id", "type", "title", "sql"],
  number: ["id", "type", "title", "sql", "format", "prefix"],
};

function resolveWidgetAllowedFields(zodError: ZodError, parsed: unknown): string[] | undefined {
  for (const issue of zodError.issues) {
    const [seg0, seg1] = issue.path;
    if (seg0 !== "widgets" || typeof seg1 !== "number" || issue.path.length > 3) continue;

    const widgetIndex = seg1;
    const parsedObj = parsed as Record<string, unknown> | null | undefined;
    const widgets = parsedObj?.widgets;
    if (!Array.isArray(widgets)) continue;

    const widget = widgets[widgetIndex] as Record<string, unknown> | undefined;
    const widgetType = typeof widget?.type === "string" ? widget.type : undefined;
    if (!widgetType) continue;

    if (!Object.prototype.hasOwnProperty.call(WIDGET_ALLOWED_FIELDS, widgetType)) {
      continue;
    }
    const fields = WIDGET_ALLOWED_FIELDS[widgetType];
    if (Array.isArray(fields)) return fields;
  }
  return undefined;
}

export async function POST(request: Request): Promise<NextResponse | Response> {
  const requestId = generateRequestId();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      formatApiError("Cuerpo JSON no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !("prompt" in body) ||
    typeof (body as Record<string, unknown>).prompt !== "string"
  ) {
    return NextResponse.json(
      formatApiError(
        "El cuerpo debe incluir un campo 'prompt' de tipo texto.",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  const record = body as Record<string, unknown>;
  const prompt = (record.prompt as string).trim();
  if (prompt.length === 0) {
    return NextResponse.json(
      formatApiError("El prompt no puede estar vacío.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  const wantStream = record.stream === true;

  if (wantStream) {
    const encoder = new TextEncoder();
    const cfg = loadDashboardLlmConfig();
    const llmProvider = cfg.provider;
    const llmDriver = cfg.provider === "cli" ? cfg.cliDriver : null;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (obj: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
        };

        const ts = () => new Date().toISOString();

        // Send the first meta line immediately — do NOT await DB before this.
        // We fire both createInteraction and createConversation concurrently so
        // the conversation appears in the list right away, even before the LLM
        // returns. The conversation ID is sent back so the frontend can link to it.
        send({
          type: "meta",
          requestId,
          message: "Generación con IA iniciada",
          promptPreview: prompt.slice(0, 200),
        });

        // Start persisting the interaction concurrently.
        const interactionLines: InteractionLine[] = [];
        let interactionId: string | null = null;
        const interactionIdPromise = createInteraction({
          requestId,
          endpoint: "generate",
          prompt,
          llmProvider,
          llmDriver: llmDriver ?? null,
        }).then((id) => {
          interactionId = id;
        }).catch((e) => {
          console.error(`[${requestId}] createInteraction failed:`, e);
        });

        // Create a conversations row immediately so this generation is visible
        // in the conversations list and the user can find it even if it fails.
        let conversationId: string | null = null;
        const conversationPromise = createConversation({
          mode: "generate",
          context_kind: "dashboard",
          first_user_prompt: prompt,
          llm_provider: llmProvider,
          llm_driver: llmDriver ?? undefined,
        }).then(async (conv) => {
          conversationId = conv.id;
          await appendMessage(conv.id, "user", { text: prompt });
          // Send the conversation URL so the frontend can show a link immediately.
          // last_status starts NULL (in-progress); success/failure paths update it.
          send({ type: "conversation", requestId, conversationId: conv.id, c_url: conv.c_url });
        }).catch((e) => {
          console.error(`[${requestId}] createConversation failed:`, e);
        });

        const pushLine = (line: InteractionLine) => {
          interactionLines.push(line);
        };

        const flushLines = async () => {
          // Ensure the insert has resolved before flushing lines
          await interactionIdPromise;
          if (!interactionId || interactionLines.length === 0) return;
          const toFlush = interactionLines.splice(0);
          try {
            await appendInteractionLines(interactionId, toFlush);
          } catch (e) {
            console.error(`[${requestId}] appendInteractionLines failed:`, e);
          }
        };

        pushLine({ kind: "meta", text: "Generación con IA iniciada", ts: ts() });

        let rawResponse: string;
        try {
          rawResponse = await generateDashboard(prompt, {
            requestId,
            endpoint: "generateDashboard",
            onAgenticProgress: (ev: AgenticProgressEvent) => {
              send({ type: "progress", requestId, event: ev });
              const text = formatAgenticProgressLineEs(ev);
              const kind: InteractionLine["kind"] =
                ev.type === "tool_start" || ev.type === "assistant_tools"
                  ? "tool_call"
                  : ev.type === "tool_done"
                    ? (ev.ok ? "tool_result" : "error")
                    : "meta";
              pushLine({ kind, text, ts: ts() });
            },
          });
        } catch (err: unknown) {
          const { status: errStatus, payload: errPayload } = buildLlmErrorPayload(err, requestId, cfg, "generate");
          const errText = errPayload.error || "Error al generar";
          pushLine({ kind: "error", text: errText, ts: ts() });
          await flushLines();
          if (interactionId) {
            await finishInteraction(interactionId, "error", errText).catch((e) =>
              console.error(`[${requestId}] finishInteraction(error) failed:`, e),
            );
          }
          console.error(`[${requestId}] Error al generar dashboard con LLM:`, err);
          await conversationPromise;
          if (conversationId) {
            const errContent = errPayload.details
              ? `${errText}\n\nDetalle: ${errPayload.details}`
              : errText;
            await appendMessage(conversationId, "assistant", { text: errContent })
              .catch((e) => console.error(`[${requestId}] appendMessage(error) failed:`, e));
            await touchConversation(conversationId, "error").catch(() => {});
          }
          // Spread payload first so its requestId is canonical (AgenticRunnerError
          // carries its own requestId that may differ from the outer one).
          send({ ...errPayload, type: "error", httpStatus: errStatus });
          controller.close();
          return;
        }

        send({ type: "phase", requestId, message: "Validando JSON del panel…" });
        pushLine({ kind: "phase", text: "Validando JSON del panel…", ts: ts() });

        const finish = finishGenerateFromRawLlm(rawResponse, requestId);
        if (!finish.ok) {
          const errText =
            typeof finish.payload["error"] === "string"
              ? finish.payload["error"]
              : "Validación fallida";
          pushLine({ kind: "error", text: errText, ts: ts() });
          await flushLines();
          if (interactionId) {
            await finishInteraction(interactionId, "error", errText).catch((e) =>
              console.error(`[${requestId}] finishInteraction(error) failed:`, e),
            );
          }
          await conversationPromise;
          if (conversationId) {
            await appendMessage(conversationId, "assistant", { text: errText })
              .catch((e) => console.error(`[${requestId}] appendMessage(validation error) failed:`, e));
            await touchConversation(conversationId, "error").catch(() => {});
          }
          send({
            type: "error",
            requestId,
            httpStatus: finish.status,
            ...finish.payload,
          });
          controller.close();
          return;
        }

        // Save the dashboard SERVER-SIDE before announcing success. Previously
        // the spec was only returned over the stream and the browser saved it
        // via POST /api/dashboards — if that request never happened (tab
        // closed, network error) the LLM cost was spent, the conversation said
        // "Panel generado" and no dashboard existed.
        send({ type: "phase", requestId, message: "Guardando el panel…" });
        pushLine({ kind: "phase", text: "Guardando el panel…", ts: ts() });
        let dashboardId: number;
        try {
          const rows = await sql<{ id: number }>(
            `INSERT INTO dashboards (name, description, spec)
             VALUES ($1, $2, $3::jsonb)
             RETURNING id`,
            [
              finish.spec.title || "Dashboard sin título",
              finish.spec.description ?? null,
              JSON.stringify(finish.spec),
            ],
          );
          if (!rows[0]?.id) throw new Error("INSERT dashboards did not return an id");
          dashboardId = rows[0].id;
        } catch (saveErr) {
          const errText = "El panel se generó pero no se pudo guardar.";
          console.error(`[${requestId}] dashboard save failed:`, saveErr);
          pushLine({ kind: "error", text: errText, ts: ts() });
          await flushLines();
          if (interactionId) {
            await finishInteraction(interactionId, "error", errText).catch(() => {});
          }
          await conversationPromise;
          if (conversationId) {
            await appendMessage(conversationId, "assistant", { text: errText }).catch(() => {});
            await touchConversation(conversationId, "error").catch(() => {});
          }
          send({
            ...formatApiError(errText, "DB_QUERY", undefined, requestId),
            type: "error",
            httpStatus: 500,
          });
          controller.close();
          return;
        }

        pushLine({ kind: "meta", text: "Panel generado correctamente.", ts: ts() });
        await flushLines();
        if (interactionId) {
          // Link the interaction to the saved dashboard, then mark it done.
          await sql(`UPDATE llm_interactions SET dashboard_id = $2 WHERE id = $1`, [
            interactionId,
            dashboardId,
          ]).catch((e) => console.error(`[${requestId}] interaction link failed:`, e));
          await finishInteraction(
            interactionId,
            "completed",
            JSON.stringify(finish.spec),
          ).catch((e) =>
            console.error(`[${requestId}] finishInteraction(completed) failed:`, e),
          );
        }
        // Migrate the conversation to dashboard context (mode='modify',
        // context_ref, context_url) and record the success message.
        await conversationPromise;
        if (conversationId) {
          await migrateConversationToDashboard(conversationId, String(dashboardId)).catch(
            (e) => console.error(`[${requestId}] conversation migrate failed:`, e),
          );
          const successText = `Panel generado: "${finish.spec.title ?? "Sin título"}"`;
          await appendMessage(conversationId, "assistant", { text: successText })
            .catch((e) => console.error(`[${requestId}] appendMessage(success) failed:`, e));
          await touchConversation(conversationId, "ok").catch(() => {});
        }

        send({
          type: "result",
          requestId,
          spec: finish.spec,
          dashboardId,
          redirectUrl: `/dashboard/${dashboardId}`,
        });
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
      },
    });
  }

  const cfg = loadDashboardLlmConfig();
  const llmProvider = cfg.provider;
  const llmDriver = cfg.provider === "cli" ? cfg.cliDriver : null;

  let interactionId: string | null = null;
  try {
    interactionId = await createInteraction({
      requestId,
      endpoint: "generate",
      prompt,
      llmProvider,
      llmDriver: llmDriver ?? null,
    });
  } catch (e) {
    console.error(`[${requestId}] createInteraction (non-stream) failed:`, e);
  }

  let rawResponse: string;
  try {
    rawResponse = await generateDashboard(prompt, {
      requestId,
      endpoint: "generateDashboard",
    });
  } catch (err: unknown) {
    const { status, payload } = buildLlmErrorPayload(err, requestId, cfg, "generate");
    if (interactionId) {
      await finishInteraction(interactionId, "error", payload.error).catch((e) =>
        console.error(`[${requestId}] finishInteraction(error) failed:`, e),
      );
    }
    console.error(`[${requestId}] Error al generar dashboard con LLM:`, err);
    return NextResponse.json(payload, { status });
  }

  const finish = finishGenerateFromRawLlm(rawResponse, requestId);
  if (!finish.ok) {
    if (interactionId) {
      const errText =
        typeof finish.payload["error"] === "string"
          ? finish.payload["error"]
          : "Validación fallida";
      await finishInteraction(interactionId, "error", errText).catch((e) =>
        console.error(`[${requestId}] finishInteraction(error) failed:`, e),
      );
    }
    return NextResponse.json(finish.payload, { status: finish.status });
  }
  if (interactionId) {
    await finishInteraction(interactionId, "completed", JSON.stringify(finish.spec)).catch((e) =>
      console.error(`[${requestId}] finishInteraction(completed) failed:`, e),
    );
  }
  return NextResponse.json(finish.spec, { status: 200 });
}
