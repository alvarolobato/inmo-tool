/**
 * Test helpers for POST /api/dashboard/generate with `{ stream: true }` (NDJSON body).
 */

export function mockJsonFetchOk(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  };
}

export function mockNdjsonGenerateSuccess(spec: Record<string, unknown>, requestId = "req_stream_test") {
  const lines = [
    JSON.stringify({
      type: "meta",
      requestId,
      message: "Generación con IA iniciada",
      promptPreview: "…",
    }),
    JSON.stringify({
      type: "progress",
      requestId,
      event: { type: "round", round: 1, maxRounds: 8 },
    }),
    JSON.stringify({
      type: "phase",
      requestId,
      message: "Validando JSON del panel…",
    }),
    JSON.stringify({ type: "result", requestId, spec }),
  ].join("\n");

  return {
    ok: true,
    status: 200,
    headers: new Headers({
      "Content-Type": "application/x-ndjson; charset=utf-8",
    }),
    json: () => Promise.reject(new Error("NDJSON response — read body")),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${lines}\n`));
        controller.close();
      },
    }),
  };
}

/** ReadableStream that never closes — for loading-state tests. */
export function mockNdjsonGenerateHang() {
  return {
    ok: true,
    status: 200,
    headers: new Headers({
      "Content-Type": "application/x-ndjson; charset=utf-8",
    }),
    json: () => Promise.reject(new Error("NDJSON stream")),
    body: new ReadableStream({
      start() {
        /* intentionally never close */
      },
    }),
  };
}
