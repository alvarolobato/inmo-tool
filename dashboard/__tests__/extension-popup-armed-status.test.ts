// @vitest-environment jsdom
/**
 * jsdom test for the popup's always-visible armed/disarmed status line
 * (issue #587's "show it's armed" half; review T3 on #613 — this had zero
 * coverage until now).
 *
 * `renderAutoArmedStatus` is what actually writes "Auto: ON — próxima
 * comprobación HH:MM · última tanda hace X" / "Auto: OFF" into the DOM. A
 * popup can wire it up perfectly and still lie if the formatting/branching
 * logic is wrong — showing "armed" for a dead scheduler is the exact failure
 * this line exists to prevent (see the PR/issue #587 discussion), so this
 * needs to run against the REAL `browser-extension/popup.html` markup (the
 * real `#auto-armed-status` element, not a hand-rolled stand-in that could
 * silently drift from what's shipped) and the REAL `popup.js` function — not
 * a re-implementation of the formatting rules under test.
 *
 * Harness: popup.js has top-level side effects (querying `document` for every
 * `#state-*`/button id, registering two top-level `addEventListener` calls,
 * and calling `init()` unconditionally at the bottom) — not importable via a
 * plain ESM `import` the way the side-effect-free `detect.js`/`batch.js` are
 * (see extension-detect.test.ts's comment). So this loads the real
 * `popup.html` body into jsdom's `document` first (every id popup.js's
 * top-level code touches must exist), then `require()`s popup.js against a
 * minimal `chrome` stub — same fresh-module-per-load pattern as
 * background.js's own harness (extension-auto-restart.test.ts). `init()`
 * runs for real on load; the chrome stub makes it resolve via `showError()`
 * (no active tab) — a harmless, deterministic short-circuit that never
 * touches `#auto-armed-status`, so it can't interfere with the assertions
 * below.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// jsdom's environment shims `import.meta.url` to a non-file scheme, so the
// `fileURLToPath(new URL(..., import.meta.url))` pattern the node-environment
// extension test harnesses use (extension-auto-restart.test.ts,
// extension-background-batch-queue.test.ts) throws here. `npm test` always
// runs vitest from `dashboard/` (see package.json), so resolve relative to
// that instead.
const EXT_DIR = path.resolve(process.cwd(), "../browser-extension/");
const req = createRequire(path.join(process.cwd(), "package.json"));

interface PopupModule {
  renderAutoArmedStatus: (auto: {
    enabled?: boolean;
    nextCheckAt?: number | null;
    lastBatchAt?: number | null;
    blocked?: { portal: string; signature: string; detectedAt: number } | null;
  } | null) => void;
  renderAutoStatus: (auto: unknown) => void;
  formatClockTime: (ms: unknown) => string | null;
  formatElapsed: (fromMs: unknown) => string | null;
  blockSignatureLabelEs: (signature: unknown) => string;
}

function loadPopup(): PopupModule {
  const resolved = req.resolve(path.join(EXT_DIR, "popup.js"));
  delete req.cache[resolved];

  // Real markup, not a hand-rolled stand-in — see file header.
  const html = readFileSync(path.join(EXT_DIR, "popup.html"), "utf-8");
  const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
  if (!bodyMatch) throw new Error("popup.html: no <body> found");
  document.body.innerHTML = bodyMatch[1];

  // Minimal chrome stub: GET_AUTO_STATE rejects and there's no active tab, so
  // popup.js's own init() short-circuits via showError() — see file header.
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      sendMessage: vi.fn(async () => {
        throw new Error("no worker in this test");
      }),
    },
    tabs: {
      query: vi.fn(async () => []),
    },
    storage: {
      sync: { get: vi.fn(async () => ({})) },
    },
  };

  return req(path.join(EXT_DIR, "popup.js")) as PopupModule;
}

afterEach(() => {
  vi.restoreAllMocks();
  const resolved = req.resolve(path.join(EXT_DIR, "popup.js"));
  delete req.cache[resolved];
  delete (globalThis as Record<string, unknown>).chrome;
  document.body.innerHTML = "";
});

describe("renderAutoArmedStatus — popup 'is it armed' status line (issue #587/#613 T3)", () => {
  it("Auto OFF (or no state at all) reads exactly 'Auto: OFF'", () => {
    const { renderAutoArmedStatus } = loadPopup();
    const el = document.querySelector("#auto-armed-status")!;
    expect(el).not.toBeNull();

    renderAutoArmedStatus(null);
    expect(el.textContent).toBe("Auto: OFF");

    renderAutoArmedStatus({ enabled: false, nextCheckAt: Date.now() + 60_000 });
    expect(el.textContent).toBe("Auto: OFF");
  });

  it("Auto ON with a future nextCheckAt shows the clock time and the elapsed last-run", () => {
    const { renderAutoArmedStatus } = loadPopup();
    const el = document.querySelector("#auto-armed-status")!;

    const nextCheckAt = new Date();
    nextCheckAt.setHours(14, 30, 0, 0);
    const lastBatchAt = Date.now() - 5 * 60_000; // 5 minutes ago

    renderAutoArmedStatus({ enabled: true, nextCheckAt: nextCheckAt.getTime(), lastBatchAt });

    const expectedClock = nextCheckAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    expect(el.textContent).toBe(
      `Auto: ON — próxima comprobación ${expectedClock} — última tanda hace 5 min`,
    );
  });

  it("Auto ON with no armed alarm yet (nextCheckAt null — a live unit, or the instant after a restart) says so honestly, not a fabricated time", () => {
    const { renderAutoArmedStatus } = loadPopup();
    const el = document.querySelector("#auto-armed-status")!;

    renderAutoArmedStatus({ enabled: true, nextCheckAt: null, lastBatchAt: null });
    expect(el.textContent).toBe("Auto: ON — próxima comprobación pendiente");
    // No "última tanda" clause at all when there's no last run yet — proves
    // the omission is conditional, not just an empty string slipped in.
    expect(el.textContent).not.toContain("última tanda");
  });

  it("renderAutoStatus (the real GET_AUTO_STATE render path) drives the armed line too, not just the batch line", () => {
    const { renderAutoStatus } = loadPopup();
    const el = document.querySelector("#auto-armed-status")!;

    renderAutoStatus({
      enabled: true,
      status: "waiting",
      nextCheckAt: Date.now() + 300_000,
      lastBatchAt: Date.now() - 60_000,
      batchesDone: 3,
      totalPending: 12,
      force: false,
    });
    expect(el.textContent).toMatch(/^Auto: ON — próxima comprobación \d{1,2}:\d{2}/);

    renderAutoStatus({ enabled: false });
    expect(el.textContent).toBe("Auto: OFF");
  });
});

describe("formatClockTime / formatElapsed — the armed line's pure formatters", () => {
  it("formatClockTime rejects non-finite/non-number input rather than printing garbage", () => {
    const { formatClockTime } = loadPopup();
    expect(formatClockTime(null)).toBeNull();
    expect(formatClockTime(undefined)).toBeNull();
    expect(formatClockTime(NaN)).toBeNull();
    expect(typeof formatClockTime(Date.now())).toBe("string");
  });

  it("formatElapsed buckets into 'hace un momento' / 'hace N min' / 'hace N h'", () => {
    const { formatElapsed } = loadPopup();
    const now = Date.now();
    expect(formatElapsed(now - 10_000)).toBe("hace un momento"); // 10s ago
    expect(formatElapsed(now - 5 * 60_000)).toBe("hace 5 min");
    expect(formatElapsed(now - 3 * 3_600_000)).toBe("hace 3 h");
    expect(formatElapsed(null)).toBeNull();
  });
});

describe("renderAutoArmedStatus — blocked state takes priority (issue #634 / D-134)", () => {
  it("a blocked episode overrides the ON line — 'armed' must never lie about a paused run", () => {
    const { renderAutoArmedStatus } = loadPopup();
    const el = document.querySelector("#auto-armed-status")!;

    renderAutoArmedStatus({
      enabled: true,
      nextCheckAt: Date.now() + 60_000,
      lastBatchAt: Date.now(),
      blocked: { portal: "idealista", signature: "captcha_wall", detectedAt: Date.now() },
    });

    // The exact assertion that fails red if the blocked branch is dropped:
    // without it this would render the normal "Auto: ON — próxima
    // comprobación…" line instead.
    expect(el.textContent).toContain("BLOQUEADO");
    expect(el.textContent).toContain("idealista");
    expect(el.textContent).toContain("muro CAPTCHA");
    expect(el.textContent).not.toContain("próxima comprobación");
    expect(el.classList.contains("blocked")).toBe(true);
  });

  it("a blocked episode overrides even the OFF line — Auto disabled but a manual/batch run is still paused-blocked", () => {
    const { renderAutoArmedStatus } = loadPopup();
    const el = document.querySelector("#auto-armed-status")!;

    renderAutoArmedStatus({
      enabled: false,
      blocked: { portal: "aliseda", signature: "geetest_challenge", detectedAt: Date.now() },
    });

    expect(el.textContent).toContain("BLOQUEADO");
    expect(el.textContent).not.toBe("Auto: OFF");
  });

  it("no blocked episode falls through to the normal ON/OFF rendering and clears the CSS hook", () => {
    const { renderAutoArmedStatus } = loadPopup();
    const el = document.querySelector("#auto-armed-status")!;

    renderAutoArmedStatus({
      enabled: true,
      blocked: {
        portal: "idealista",
        signature: "captcha_wall",
        detectedAt: Date.now(),
      },
    });
    expect(el.classList.contains("blocked")).toBe(true);

    renderAutoArmedStatus({ enabled: false, blocked: null });
    expect(el.textContent).toBe("Auto: OFF");
    expect(el.classList.contains("blocked")).toBe(false);
  });

  it("an unrecognised signature id still renders something (falls back to the raw id)", () => {
    const { blockSignatureLabelEs } = loadPopup();
    expect(blockSignatureLabelEs("some_future_signature")).toBe("some_future_signature");
    expect(blockSignatureLabelEs("captcha_wall")).toBe("muro CAPTCHA");
  });
});
