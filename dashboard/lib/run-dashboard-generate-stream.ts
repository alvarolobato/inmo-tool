import type { DashboardSpec } from "@/lib/schema";
import type { AgenticProgressEvent } from "@/lib/llm-tools/types";
import {
  formatAgenticProgressLineEs,
  COALESCEABLE_LABELS,
} from "@/lib/format-agentic-progress";
import {
  isApiErrorResponse,
  type ApiErrorResponse,
  type ErrorCode,
} from "@/lib/errors";

/** A progress line emitted to the generate dialog. */
export interface GenerateProgressLine {
  text: string;
  /** Thinking/reasoning body text to show expanded below the label line. */
  body?: string;
}

export interface DashboardGenerateStreamHandlers {
  onMeta?: (requestId: string, lines: string[], fullPrompt?: string) => void;
  /** Called when the server creates a conversation for this generation. */
  onConversation?: (conversationId: string, cUrl: string) => void;
  /**
   * Called with a progress line to append or update in the log.
   * `replace=true` means update the last line in-place (coalescing).
   * `body` carries thinking/reasoning text to render expanded below the label.
   */
  onLine?: (line: GenerateProgressLine, replace?: boolean) => void;
}

/** Result of a streamed generation: the spec plus the server-saved dashboard id. */
export interface DashboardGenerateStreamResult {
  spec: DashboardSpec;
  /** ID of the dashboard the server saved. Null only on legacy JSON fallback. */
  dashboardId: number | null;
}

/**
 * Calls POST /api/dashboard/generate with `{ stream: true }` and consumes NDJSON
 * until a `result` line. Falls back to a plain JSON body if the server returns
 * `application/json` (older deployments).
 */
export async function runDashboardGenerateStream(
  prompt: string,
  handlers: DashboardGenerateStreamHandlers,
): Promise<DashboardGenerateStreamResult> {
  const res = await fetch("/api/dashboard/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, stream: true }),
  });

  const ct = res.headers.get("content-type") ?? "";

  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as unknown;
    if (isApiErrorResponse(data)) {
      throw data;
    }
    throw new Error(
      typeof data === "object" && data !== null && "error" in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${res.status}`,
    );
  }

  if (ct.includes("application/json")) {
    return { spec: (await res.json()) as DashboardSpec, dashboardId: null };
  }

  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("No se pudo leer la respuesta del servidor");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let finalSpec: DashboardSpec | null = null;
  let finalDashboardId: number | null = null;
  // Capture the prompt so the meta handler can pass it to onMeta for the
  // expandable full-prompt section in DashboardGenerateProgressDialog.
  const currentPrompt = prompt;

  // Coalescing state: track the last label emitted to detect consecutive
  // coalesceable ticks (model_text_delta / model_thinking_delta).
  let lastCoalescedLabel: string | null = null;

  const emitLine = (progressLine: GenerateProgressLine, coalesceable: boolean) => {
    const label = coalesceable ? progressLine.text.split(" · ")[0] ?? progressLine.text : null;
    const replace = coalesceable && label !== null && label === lastCoalescedLabel;
    lastCoalescedLabel = coalesceable ? label : null;
    handlers.onLine?.(progressLine, replace);
  };

  const processLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    if (msg.type === "meta" && typeof msg.requestId === "string") {
      const lines: string[] = [];
      if (typeof msg.message === "string") lines.push(msg.message);
      if (typeof msg.promptPreview === "string") {
        lines.push(`Resumen del prompt: ${msg.promptPreview}`);
      }
      // Pass the full prompt text so the dialog can show it in an expandable section.
      handlers.onMeta?.(msg.requestId, lines, currentPrompt);
    }

    if (msg.type === "conversation" && typeof msg.conversationId === "string") {
      // Server created a conversation row — notify so the UI can show a link.
      handlers.onConversation?.(
        msg.conversationId as string,
        typeof msg.c_url === "string" ? msg.c_url : `/c/${msg.conversationId}`,
      );
    }

    if (msg.type === "progress" && msg.event) {
      const ev = msg.event as AgenticProgressEvent;
      const formatted = formatAgenticProgressLineEs(ev);
      // Coalesce consecutive streaming ticks of the same label.
      const coalesceable = COALESCEABLE_LABELS.has(formatted.split(" · ")[0] ?? "");
      // For thinking events, pass the accumulated text as body so the dialog
      // can render it expanded below the label line.
      const body =
        ev.type === "model_thinking_delta" && typeof ev.text === "string" && ev.text
          ? ev.text
          : ev.type === "model_text_delta" && typeof ev.text === "string" && ev.text
            ? ev.text
            : undefined;
      emitLine({ text: formatted, body }, coalesceable);
    }

    if (msg.type === "phase" && typeof msg.message === "string") {
      emitLine({ text: String(msg.message) }, false);
    }

    if (msg.type === "result" && msg.spec) {
      finalSpec = msg.spec as DashboardSpec;
      finalDashboardId =
        typeof msg.dashboardId === "number" && Number.isInteger(msg.dashboardId)
          ? msg.dashboardId
          : null;
    }

    if (msg.type === "error") {
      const payload: ApiErrorResponse = {
        error: String(msg.error ?? "Error"),
        code:
          typeof msg.code === "string" ? (msg.code as ErrorCode) : ("UNKNOWN" as ErrorCode),
        ...(typeof msg.details === "string" ? { details: msg.details } : {}),
        timestamp: typeof msg.timestamp === "string" ? msg.timestamp : new Date().toISOString(),
        requestId: typeof msg.requestId === "string" ? msg.requestId : "",
      };
      throw payload;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        processLine(line);
      }
    }
    buffer += decoder.decode();
    processLine(buffer);
  } finally {
    reader.cancel().catch(() => {});
  }

  if (!finalSpec) {
    throw new Error("La generación terminó sin resultado del panel");
  }
  return { spec: finalSpec, dashboardId: finalDashboardId };
}
