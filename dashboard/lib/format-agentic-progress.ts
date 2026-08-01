import type { AgenticProgressEvent } from "@/lib/llm-tools/types";
import type { LogLine } from "@/components/LogBlock";

export interface TimedEvent {
  event: AgenticProgressEvent;
  ms: number;
}

/**
 * Convert a single AgenticProgressEvent to a LogLine immediately.
 * Returns null for event types that don't produce visible log lines
 * (e.g. `round` with round=1, `assistant_tools`, `tool_start`).
 *
 * For `model_text_delta` and `model_thinking_delta`: returns a line whose
 * `body` carries the cumulative text so the caller can coalesce repeated
 * deltas into a single growing log entry (replacing the last line of that
 * label). The `body` is only populated when the event carries a `text` field.
 */
export function agenticEventToLogLine(event: AgenticProgressEvent, ms: number): LogLine | null {
  const ts = `+${(ms / 1000).toFixed(1)}s`;
  switch (event.type) {
    case "tool_done":
      return {
        timestamp: ts,
        kind: "tool",
        label: event.name,
        detail: event.ok ? `${event.ms}ms` : `error · ${event.errorCode ?? "err"}`,
      };
    case "round":
      if (event.round > 1) {
        return { timestamp: ts, kind: "reason", label: "Razonando", detail: `ronda ${event.round}` };
      }
      return null;
    case "model_step_start":
      return { timestamp: ts, kind: "reason", label: "Modelo pensando…", detail: undefined };
    case "model_text_delta":
      // Show the cumulative text as `body` when available so the user can
      // read the model's response as it streams. During tool-calling rounds
      // the text is JSON arguments (not prose) but showing it is still more
      // informative than just a character count.
      return {
        timestamp: ts,
        kind: "reason",
        label: "Modelo respondiendo",
        detail: `${event.totalChars} caracteres`,
        body: event.text,
      };
    case "model_thinking_delta":
      return {
        timestamp: ts,
        kind: "reason",
        label: "Claude está razonando",
        detail: `${event.totalChars} caracteres`,
        body: event.text,
      };
    case "finalizing":
      return { timestamp: ts, kind: "done", label: "Respuesta lista", detail: `${event.messageChars} chars` };
    case "assistant_tools":
    case "tool_start":
      return null;
    default:
      return null;
  }
}

/** Labels whose consecutive ticks should be coalesced into a single growing
 *  log line (model_text_delta + model_thinking_delta variants). Shared by the
 *  server-side pushAgenticLogLine helper and the client-side appendCoalesced
 *  helper used in ChatSidebar / review page. */
export const COALESCEABLE_LABELS: ReadonlySet<string> = new Set([
  "Modelo respondiendo",
  "Claude está razonando",
]);

/**
 * Append a `LogLine` to a streaming buffer, coalescing consecutive ticks of
 * the same coalesce-eligible label (currently "Modelo respondiendo" and
 * "Claude está razonando" — see {@link COALESCEABLE_LABELS}) into a single
 * line that grows. Called by API routes that buffer NDJSON `progress` frames
 * so the client doesn't receive one frame per token.
 */
export function pushAgenticLogLine<T extends { logLine: LogLine }>(
  buffer: T[],
  entry: T,
): void {
  const lastLabel = buffer[buffer.length - 1]?.logLine.label;
  const newLabel = entry.logLine.label;
  if (
    buffer.length > 0 &&
    COALESCEABLE_LABELS.has(newLabel) &&
    lastLabel === newLabel
  ) {
    buffer[buffer.length - 1] = entry;
    return;
  }
  buffer.push(entry);
}

/**
 * Client-side counterpart: append a `LogLine` to an array, coalescing
 * consecutive ticks of the same coalesce-eligible label. Returns the
 * mutated array (which is the same reference as `lines`) so callers can
 * pass it straight to `setState([...lines])`.
 */
export function appendCoalescedLogLine(lines: LogLine[], next: LogLine): LogLine[] {
  const lastLabel = lines[lines.length - 1]?.label;
  if (
    lines.length > 0 &&
    COALESCEABLE_LABELS.has(next.label) &&
    lastLabel === next.label
  ) {
    lines[lines.length - 1] = next;
  } else {
    lines.push(next);
  }
  return lines;
}

/** Build a LogLine collector for use as onAgenticProgress, then call toLogLines() after the run. */
export function createLogCollector(): {
  onAgenticProgress: (event: AgenticProgressEvent) => void;
  toLogLines: () => LogLine[];
} {
  const timed: TimedEvent[] = [];
  const t0 = Date.now();
  return {
    onAgenticProgress: (event) => timed.push({ event, ms: Date.now() - t0 }),
    toLogLines: () => eventsToLogLines(timed),
  };
}

function eventsToLogLines(events: TimedEvent[]): LogLine[] {
  const lines: LogLine[] = [];
  for (const { event, ms } of events) {
    const line = agenticEventToLogLine(event, ms);
    if (!line) continue;
    // Coalesce consecutive streaming ticks of the same eligible label so
    // LogBlock shows one growing line per kind instead of one per chunk.
    appendCoalescedLogLine(lines, line);
  }
  return lines;
}

/**
 * Human-readable line (Spanish) for dashboard generation UI + logs.
 * Used by the generate route which streams raw events (not LogLines).
 * NOTE: This function is called once per event — callers that want coalescing
 * must deduplicate consecutive identical labels themselves (see
 * run-dashboard-generate-stream.ts).
 */
export function formatAgenticProgressLineEs(event: AgenticProgressEvent): string {
  switch (event.type) {
    case "round":
      return `Ronda ${event.round}/${event.maxRounds} — llamada al modelo…`;
    case "model_step_start":
      return `Modelo pensando… (${event.provider}${event.driver ? `/${event.driver}` : ""})`;
    case "model_text_delta":
      return `Modelo respondiendo · ${event.totalChars} caracteres`;
    case "model_thinking_delta":
      return `Claude está razonando · ${event.totalChars} caracteres`;
    case "assistant_tools":
      return `Herramientas solicitadas: ${event.tools.join(", ")}`;
    case "tool_start": {
      const preview = event.argsPreview ? `: ${event.argsPreview}` : "…";
      return `  → ${event.name}${preview}`;
    }
    case "tool_done": {
      const icon = event.ok ? "✓" : "✗";
      const err = event.errorCode ? ` (${event.errorCode})` : "";
      const preview = event.argsPreview ? ` · ${event.argsPreview.slice(0, 60)}` : "";
      return `  ${icon} ${event.name} — ${event.ms} ms${err}${preview}`;
    }
    case "finalizing":
      return `Respuesta lista · ${event.messageChars} caracteres`;
    default: {
      return JSON.stringify(event);
    }
  }
}
