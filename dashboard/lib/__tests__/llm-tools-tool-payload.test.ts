import { describe, it, expect } from "vitest";
import {
  toolError,
  toolOk,
  stringifyToolPayload,
} from "@/lib/llm-tools/tool-payload";
import type { LlmAgenticContext } from "@/lib/llm-tools/types";

const ctx: LlmAgenticContext = {
  requestId: "req_payload_test",
  endpoint: "test",
};

describe("toolError", () => {
  it("returns ok=false with code, message, and request id from ctx", () => {
    const out = toolError("INVALID_ARGS", "bad input", ctx);
    expect(out).toEqual({
      ok: false,
      code: "INVALID_ARGS",
      message: "bad input",
      requestId: "req_payload_test",
    });
  });

  it("propagates a different request id from a different context", () => {
    const other = { ...ctx, requestId: "req_xyz" };
    const out = toolError("FORBIDDEN", "no access", other);
    expect(out.requestId).toBe("req_xyz");
  });
});

describe("toolOk", () => {
  it("wraps arbitrary data in an ok-true envelope", () => {
    const out = toolOk({ rows: [["a", 1]], columns: ["x", "y"] });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data).toEqual({ rows: [["a", 1]], columns: ["x", "y"] });
    }
  });

  it("preserves primitive data types", () => {
    const out = toolOk(42);
    expect(out).toEqual({ ok: true, data: 42 });
  });
});

describe("stringifyToolPayload", () => {
  it("returns the JSON string when it fits within maxChars", () => {
    const body = toolOk({ a: 1 });
    const out = stringifyToolPayload(body, 1000, ctx);
    expect(JSON.parse(out)).toEqual(body);
  });

  it("returns a truncated envelope when the payload exceeds maxChars", () => {
    const big = "x".repeat(2000);
    const body = toolOk({ blob: big });
    const out = stringifyToolPayload(body, 500, ctx);
    expect(out.length).toBeLessThanOrEqual(500);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.data._truncated).toBe(true);
    expect(typeof parsed.data.original_length).toBe("number");
    expect(parsed.data.original_length).toBeGreaterThan(500);
    expect(typeof parsed.data.preview).toBe("string");
  });

  it("returns a minimal fallback envelope when even the truncated form does not fit", () => {
    const big = "x".repeat(50_000);
    const body = toolOk({ blob: big });
    // Tiny budget that the truncated envelope (which includes _truncated/
    // original_length/preview) cannot satisfy. stringifyToolPayload then
    // falls back to a minimal envelope without `original_length` whose
    // preview is the fixed string "[tool result exceeded size limit]".
    // This minimal form *can* exceed the budget too — it is intentionally
    // emitted as-is rather than truncating further, so the receiver always
    // sees a valid JSON envelope.
    const out = stringifyToolPayload(body, 30, ctx);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.data._truncated).toBe(true);
    expect(parsed.data.preview).toMatch(/exceeded size limit/);
    // The minimal-fallback envelope intentionally drops `original_length`
    // (only `_truncated` + `preview` survive), in contrast to the regular
    // truncated envelope above which carries `original_length`.
    expect(parsed.data.original_length).toBeUndefined();
  });

  it("returns a SERIALIZATION_ERROR for non-serializable data", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    // Use `as` because the public type is structural and allows arbitrary `data`.
    const body = toolOk(circular);
    const out = stringifyToolPayload(body, 1000, ctx);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("SERIALIZATION_ERROR");
    expect(parsed.requestId).toBe(ctx.requestId);
  });
});
