/**
 * The RENDER-WAIT leg, background half (issue #700, D-162).
 *
 * `render_wait_ms` is the only leg of the three that is measured in the
 * browser, and it therefore crosses a boundary nothing else in this repo
 * crosses: content-script → `chrome.runtime.sendMessage` → background's
 * EXTRACT listener → `handleExtraction` → POST /api/extension/capture. Every
 * other leg is written by code that also reads it; this one is written by an
 * independently-installed Chrome artifact, so a silent drop anywhere along the
 * chain shows up as "the column is always NULL" and nothing else.
 *
 * These tests pin the two places it can be silently dropped in the service
 * worker:
 *   1. the onMessage listener must forward the WHOLE message object — it
 *      destructures nothing, and a future refactor that "tidies" it into
 *      `handleExtraction({ url: msg.url, html: msg.html })` would drop the
 *      field with no test failing;
 *   2. `handleExtraction` must put `renderWaitMs` on the wire when it has a
 *      number, and OMIT the key entirely when it doesn't (D-162: "not
 *      measured" is absence, never 0).
 *
 * Harness copied from extension-diagnostic-background.test.ts: background.js
 * loaded via Node's CommonJS `require` against a from-scratch chrome/self/
 * fetch stub, `importScripts` shimmed to `require()` the sibling files.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXT_DIR = fileURLToPath(new URL("../../browser-extension/", import.meta.url));
const req = createRequire(import.meta.url);

const SIBLING_FILES = [
  "detect.js",
  "batch.js",
  "capture-search-url.js",
  "observe-search-url.js",
  "network-recorder.js",
  "background.js",
];

function resetRequireCache() {
  for (const file of SIBLING_FILES) {
    const resolved = req.resolve(path.join(EXT_DIR, file));
    delete req.cache[resolved];
  }
}

type Listener = (
  msg: Record<string, unknown>,
  sender: unknown,
  sendResponse: (res: unknown) => void,
) => boolean | undefined;

function makeStorageArea(store: Record<string, unknown>) {
  return {
    get: async (keys?: string | string[] | null) => {
      if (keys == null) return { ...store };
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in store) out[k] = store[k];
      return out;
    },
    set: vi.fn(async (obj: Record<string, unknown>) => {
      Object.assign(store, obj);
    }),
    remove: async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) delete store[k];
    },
  };
}

function makeChromeMock() {
  const listeners: Listener[] = [];
  const sync: Record<string, unknown> = {
    apiUrl: "http://localhost:4000",
    apiKey: "test-admin-key",
  };
  return {
    listeners,
    storage: {
      local: makeStorageArea({}),
      session: makeStorageArea({}),
      sync: makeStorageArea(sync),
    },
    tabs: {
      create: vi.fn(async () => ({ id: 1 })),
      update: vi.fn(async () => ({})),
      remove: vi.fn(async () => {}),
      get: vi.fn(async () => ({})),
      query: vi.fn(async () => []),
      sendMessage: vi.fn(async () => null),
      onUpdated: { addListener: vi.fn() },
      onActivated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    alarms: { create: vi.fn(), clear: vi.fn(async () => true), onAlarm: { addListener: vi.fn() } },
    runtime: {
      onMessage: {
        addListener: vi.fn((fn: Listener) => {
          listeners.push(fn);
        }),
      },
      onStartup: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      getManifest: () => ({ version: "0.18.0-test" }),
      lastError: undefined,
    },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn(), setTitle: vi.fn() },
    scripting: {
      executeScript: vi.fn(async () => {}),
      registerContentScripts: vi.fn(async () => {}),
      unregisterContentScripts: vi.fn(async () => {}),
    },
    permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true) },
  };
}

function makeFetchMock() {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ success: true, capture_id: 99 }),
  }));
}

function loadBackground(
  chromeMock: ReturnType<typeof makeChromeMock>,
  fetchMock: ReturnType<typeof makeFetchMock>,
) {
  resetRequireCache();
  (globalThis as unknown as { self: unknown }).self = globalThis;
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  (globalThis as unknown as { importScripts: (...f: string[]) => void }).importScripts = (
    ...files: string[]
  ) => {
    for (const file of files) req(path.join(EXT_DIR, file));
  };
  req(path.join(EXT_DIR, "background.js"));
}

afterEach(() => {
  vi.restoreAllMocks();
  resetRequireCache();
  const g = globalThis as Record<string, unknown>;
  delete g.self;
  delete g.chrome;
  delete g.fetch;
  delete g.importScripts;
  delete g.InmoDetect;
  delete g.InmoBatch;
  delete g.InmoSearchUrl;
  delete g.InmoObserve;
  delete g.InmoNetworkRecorder;
});

const LISTING_URL = "https://www.idealista.com/inmueble/100000001/";

/** Dispatch one EXTRACT message through the REAL onMessage listener. */
async function dispatchExtract(
  chromeMock: ReturnType<typeof makeChromeMock>,
  msg: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    for (const fn of chromeMock.listeners) {
      fn(msg, {}, (res) => {
        if (settled) return;
        settled = true;
        resolve(res);
      });
    }
  });
}

/**
 * The JSON body of the POST to /api/extension/capture. Selected by endpoint,
 * not by index: loading background.js also fires the presence heartbeat
 * (#509) through the same `fetch`, and it is usually call 0.
 */
function postedBody(fetchMock: ReturnType<typeof makeFetchMock>): Record<string, unknown> {
  const calls = fetchMock.mock.calls as unknown as Array<[string, { body: string }]>;
  const capture = calls.filter(([url]) => url.endsWith("/api/extension/capture"));
  expect(capture).toHaveLength(1);
  return JSON.parse(capture[0][1].body);
}

describe("EXTRACT → capture POST carries renderWaitMs (issue #700)", () => {
  it("puts the measured render wait on the wire", async () => {
    const chromeMock = makeChromeMock();
    const fetchMock = makeFetchMock();
    loadBackground(chromeMock, fetchMock);

    const res = await dispatchExtract(chromeMock, {
      type: "EXTRACT",
      url: LISTING_URL,
      html: "<html><body>anuncio</body></html>",
      renderWaitMs: 19500,
    });

    expect(res).toMatchObject({ success: true, capture_id: 99 });
    expect(postedBody(fetchMock)).toEqual({
      url: LISTING_URL,
      html: "<html><body>anuncio</body></html>",
      renderWaitMs: 19500,
    });
  });

  it("forwards the WHOLE message, not a hand-picked {url, html} pair", async () => {
    // The listener at background.js's `msg.type === 'EXTRACT'` branch passes
    // `msg` through verbatim. This is the mutation guard for that: destructure
    // the listener down to {url, html} and this test is the only thing that
    // fails — the capture itself still succeeds, and render_wait_ms silently
    // becomes NULL forever.
    const chromeMock = makeChromeMock();
    const fetchMock = makeFetchMock();
    loadBackground(chromeMock, fetchMock);

    await dispatchExtract(chromeMock, {
      type: "EXTRACT",
      url: LISTING_URL,
      html: "<html></html>",
      renderWaitMs: 4321,
    });

    expect(postedBody(fetchMock).renderWaitMs).toBe(4321);
  });

  it("OMITS the key entirely when the caller didn't time it — never null, never 0", async () => {
    // The manual/forced-capture path doesn't wait for render at all, so it has
    // nothing to report. D-162 rule 2: not-measured must not be coerced to a
    // number, and 0 would assert "instant".
    const chromeMock = makeChromeMock();
    const fetchMock = makeFetchMock();
    loadBackground(chromeMock, fetchMock);

    await dispatchExtract(chromeMock, {
      type: "EXTRACT",
      url: LISTING_URL,
      html: "<html></html>",
    });

    const body = postedBody(fetchMock);
    expect(body).toEqual({ url: LISTING_URL, html: "<html></html>" });
    expect("renderWaitMs" in body).toBe(false);
  });

  it("drops a non-numeric renderWaitMs at the extension boundary too", async () => {
    // Belt and braces with the route's own coercion: a value that isn't a
    // number never reaches the wire, so a bad build can't fill the column with
    // garbage that the server then has to reject.
    const chromeMock = makeChromeMock();
    const fetchMock = makeFetchMock();
    loadBackground(chromeMock, fetchMock);

    await dispatchExtract(chromeMock, {
      type: "EXTRACT",
      url: LISTING_URL,
      html: "<html></html>",
      renderWaitMs: "19500",
    });

    expect("renderWaitMs" in postedBody(fetchMock)).toBe(false);
  });

  it("a zero-length wait IS reported — 0 measured is not the same as not measured", async () => {
    const chromeMock = makeChromeMock();
    const fetchMock = makeFetchMock();
    loadBackground(chromeMock, fetchMock);

    await dispatchExtract(chromeMock, {
      type: "EXTRACT",
      url: LISTING_URL,
      html: "<html></html>",
      renderWaitMs: 0,
    });

    expect(postedBody(fetchMock).renderWaitMs).toBe(0);
  });
});
