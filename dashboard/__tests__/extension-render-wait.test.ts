// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://www.idealista.com/inmueble/100000001/" }
/**
 * The RENDER-WAIT leg, content-script half (issue #700, D-162).
 *
 * `render_wait_ms` is the leg the owner's question was actually about: how
 * long the browser sat waiting for a client-rendered portal to paint before
 * the DOM could be snapshotted. It is measured HERE and nowhere else, so if
 * this file's stopwatch is wrong or missing the column is silently NULL (or
 * silently constant) and no server-side test can tell.
 *
 * Loads the REAL content-script.js in jsdom against a chrome stub, same
 * spirit as extension-diagnostic-background.test.ts does for background.js:
 * the auto-capture loop's timing wiring is what's under test, so a copy of it
 * would test nothing.
 *
 * Fixture HTML is SYNTHETIC — generic portal chrome and invented copy, no
 * scraped listing content (public repo).
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";

// jsdom's `import.meta.url` is the fake PAGE url (https://www.idealista.com/…),
// not a file: URL, so the usual `new URL("…", import.meta.url)` idiom throws
// here. vitest runs with the dashboard as cwd.
const EXT_DIR = path.resolve(process.cwd(), "..", "browser-extension");
const req = createRequire(path.join(process.cwd(), "package.json"));

const EXT_FILES = [
  "detect.js",
  "diagnostic.js",
  "discover.js",
  "observe-search-url.js",
  "capture-search-url.js",
  "content-script.js",
];

function resetRequireCache() {
  for (const file of EXT_FILES) {
    let resolved: string;
    try {
      resolved = req.resolve(path.join(EXT_DIR, file));
    } catch {
      continue;
    }
    delete req.cache[resolved];
  }
}

/**
 * A rendered idealista detail page: satisfies the portal's readySelectors AND
 * the body-text floor, so `isRenderReady` is true. (The Hipoges failure mode
 * this whole issue came from is the opposite — see the last test.)
 */
const RENDERED_HTML = `
  <main>
    <h1 class="main-info__title-main">Piso en venta en calle Inventada</h1>
    <div class="info-data-price">180.000 €</div>
    <div class="adCommentsLanguage">
      Vivienda exterior muy luminosa con tres dormitorios y dos baños completos.
      Reformada íntegramente, suelos de tarima, ventanas con doble
      acristalamiento y climatización por conductos. La finca dispone de
      ascensor y portal reformado. Zona muy bien comunicada, con transporte
      público, colegios y comercios a pocos minutos andando. Se entrega libre
      de cargas y de inquilinos, lista para entrar a vivir desde el primer día.
      Posibilidad de plaza de garaje en el mismo edificio por precio aparte.
    </div>
    <div class="details-property_features"><ul><li>83 m²</li><li>3 hab.</li></ul></div>
  </main>`;

/** The empty client-rendered shell: readySelectors present, but no content. */
const EMPTY_SHELL_HTML = `<main><h1></h1></main>`;

const QUIESCENCE_MS = 800; // content-script.js's own constant
const MAX_WAIT_MS = 20000; // ditto

interface SentMessage {
  type?: string;
  url?: string;
  html?: string;
  renderWaitMs?: unknown;
}

let sent: SentMessage[] = [];

function installChromeStub() {
  const sync: Record<string, unknown> = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener: vi.fn() },
      sendMessage: vi.fn(
        (msg: SentMessage, cb?: (res: unknown) => void) => {
          sent.push(msg);
          if (typeof cb === "function") cb({ success: true, capture_id: 1 });
          return Promise.resolve({ active: false });
        },
      ),
    },
    storage: {
      sync: {
        get: async (keys?: string | string[] | null) => {
          if (keys == null) return { ...sync };
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of list) if (k in sync) out[k] = sync[k];
          return out;
        },
        set: async (obj: Record<string, unknown>) => {
          Object.assign(sync, obj);
        },
      },
    },
  };
}

/**
 * Render `html`, load the extension modules, and let content-script.js's
 * startup IIFE reach `startAutoCaptureLoop`. Returns nothing — assertions read
 * `sent`. Time is frozen; the caller advances it.
 */
async function loadContentScript(html: string) {
  document.body.innerHTML = html;
  Object.defineProperty(document, "readyState", { value: "complete", configurable: true });
  resetRequireCache();
  for (const file of EXT_FILES) req(path.join(EXT_DIR, file));
  // The startup IIFE awaits initValidationMode() + autoCaptureEnabled() before
  // arming the loop; flush those microtasks without moving the clock.
  await vi.advanceTimersByTimeAsync(0);
}

/** The EXTRACT message the auto-capture loop sent, if any. */
function extractMsg(): SentMessage | undefined {
  return sent.find((m) => m.type === "EXTRACT");
}

beforeEach(() => {
  sent = [];
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-22T10:00:00Z"));
  installChromeStub();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetRequireCache();
  document.body.innerHTML = "";
  const g = globalThis as Record<string, unknown>;
  delete g.chrome;
  delete g.InmoDetect;
  delete g.InmoDiagnostic;
  delete g.InmoDiscover;
  delete g.InmoObserve;
  delete g.InmoSearchUrl;
});

describe("content-script auto-capture reports renderWaitMs (issue #700)", () => {
  it("sends EXTRACT with the elapsed wait, measured from when watching started", async () => {
    await loadContentScript(RENDERED_HTML);
    // Page was already render-ready, so the only wait is the quiescence settle.
    await vi.advanceTimersByTimeAsync(QUIESCENCE_MS);

    const msg = extractMsg();
    expect(msg).toBeDefined();
    expect(msg?.url).toBe("https://www.idealista.com/inmueble/100000001/");
    expect(msg?.renderWaitMs).toBe(QUIESCENCE_MS);
  });

  it("GROWS with the time the portal actually took — it is a stopwatch, not a constant", async () => {
    // The mutation this pins: hard-code the field (or start the clock at
    // snapshot time instead of at watch time) and both this and the previous
    // test can't both hold. A slow portal must produce a bigger number.
    await loadContentScript(EMPTY_SHELL_HTML);

    // 4s of an unrendered Angular-style shell — the readySelector matches but
    // carries no text, exactly the Hipoges shape.
    await vi.advanceTimersByTimeAsync(4000);
    expect(extractMsg()).toBeUndefined();

    // Content finally paints; the next readiness poll picks it up.
    document.body.innerHTML = RENDERED_HTML;
    await vi.advanceTimersByTimeAsync(1000 + QUIESCENCE_MS);

    const msg = extractMsg();
    expect(msg).toBeDefined();
    // Poll granularity is 500ms, so pin the band rather than an exact tick:
    // strictly more than the 4s of waiting, and no more than the whole
    // wait + one poll + the settle.
    expect(msg?.renderWaitMs).toBeGreaterThan(4000);
    expect(msg?.renderWaitMs).toBeLessThanOrEqual(5000 + QUIESCENCE_MS);
  });

  it("sends NOTHING when the page never renders — the known gap that belongs to #644", async () => {
    // This is the Hipoges failure the owner felt: 20s of waiting, then the
    // loop gives up WITHOUT POSTing, so the server has no record the listing
    // was attempted at all. Pinned deliberately: `render_wait_ms` measures
    // successful captures only, and a portal that mostly times out looks, in
    // the timing data, like a portal nobody visited. Reporting abandoned waits
    // needs an event channel the capture POST can't carry (#644).
    await loadContentScript(EMPTY_SHELL_HTML);
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS + 5000);

    expect(extractMsg()).toBeUndefined();
  });
});
