/**
 * Normalize tool results and errors for the model (size limits, stable shape).
 */

import type { LlmAgenticContext } from "./types";

export interface ToolErrorBody {
  ok: false;
  code: string;
  message: string;
  requestId: string;
}

export interface ToolOkBody<T = unknown> {
  ok: true;
  data: T;
}

export type ToolResponseBody<T = unknown> = ToolOkBody<T> | ToolErrorBody;

export function toolError(
  code: string,
  message: string,
  ctx: LlmAgenticContext,
): ToolErrorBody {
  return { ok: false, code, message, requestId: ctx.requestId };
}

export function toolOk<T>(data: T): ToolOkBody<T> {
  return { ok: true, data };
}

export function stringifyToolPayload(
  body: ToolResponseBody,
  maxChars: number,
  ctx: LlmAgenticContext,
): string {
  try {
    const s = JSON.stringify(body);
    if (s.length <= maxChars) return s;
    const envelope: ToolOkBody<{
      _truncated: true;
      original_length: number;
      preview: string;
    }> = {
      ok: true,
      data: {
        _truncated: true,
        original_length: s.length,
        preview: s.slice(0, Math.max(0, maxChars - 220)),
      },
    };
    let out = JSON.stringify(envelope);
    if (out.length > maxChars) {
      out = JSON.stringify(
        toolOk({
          _truncated: true,
          preview: "[tool result exceeded size limit]",
        }),
      );
    }
    return out;
  } catch {
    return JSON.stringify(
      toolError("SERIALIZATION_ERROR", "Could not serialize tool result.", ctx),
    );
  }
}
