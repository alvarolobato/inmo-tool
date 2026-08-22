// @vitest-environment jsdom
/**
 * jsdom tests for the popup's "Forzar captura + diagnóstico" button
 * (issue #671), covering the PR #675 review's S2 finding and the removal of
 * the network-capture button.
 *
 * S2: the button is deliberately UNGATED by host — a page the extension
 * refuses to classify is exactly when a diagnostic is needed (issue #671) —
 * and it uploads the page's fully-rendered DOM. Before this fix it fired on
 * a single click with no confirmation and no URL shown, so one misclick with
 * a bank or webmail tab focused shipped that page's authenticated DOM to the
 * dashboard. Notably the *network* button had a `confirm()` while the button
 * that actually sends the DOM did not.
 *
 * Runs against the REAL `browser-extension/popup.html` markup and the REAL
 * `popup.js` handler — a hand-rolled stand-in could pass while the shipped
 * button stays unguarded. Same harness as
 * extension-popup-armed-status.test.ts (see its header for why popup.js has
 * to be `require()`d against a live jsdom document rather than imported).
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const EXT_DIR = path.resolve(process.cwd(), "../browser-extension/");
const req = createRequire(path.join(process.cwd(), "package.json"));

const TARGET_URL = "https://mi-banco.example.com/cuentas/movimientos?desde=2026-01-01";

interface ChromeStub {
  runtime: { sendMessage: ReturnType<typeof vi.fn> };
  tabs: { query: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn> };
  scripting: { executeScript: ReturnType<typeof vi.fn> };
  storage: { sync: { get: ReturnType<typeof vi.fn> } };
}

let chromeStub: ChromeStub;

function popupHtmlBody(): string {
  const html = readFileSync(path.join(EXT_DIR, "popup.html"), "utf-8");
  const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
  if (!bodyMatch) throw new Error("popup.html: no <body> found");
  return bodyMatch[1];
}

function loadPopup(): void {
  const resolved = req.resolve(path.join(EXT_DIR, "popup.js"));
  delete req.cache[resolved];
  document.body.innerHTML = popupHtmlBody();

  chromeStub = {
    runtime: { sendMessage: vi.fn(async () => ({ success: true })) },
    tabs: {
      // Empty at load time so popup.js's own init() short-circuits via
      // showError() — the per-test tab is installed after load, below.
      query: vi.fn(async () => []),
      sendMessage: vi.fn(async () => ({
        html: "<html><body>saldo</body></html>",
        url: TARGET_URL,
        title: "Mis movimientos",
        diagnostic: { detection: {} },
      })),
    },
    scripting: { executeScript: vi.fn(async () => []) },
    storage: { sync: { get: vi.fn(async () => ({})) } },
  };
  (globalThis as unknown as { chrome: ChromeStub }).chrome = chromeStub;

  req(path.join(EXT_DIR, "popup.js"));
}

/** Make the active tab resolvable, as it is in a real popup. */
function withActiveTab(): void {
  chromeStub.tabs.query.mockResolvedValue([{ id: 42, url: TARGET_URL }]);
}

/** Let the click handler's awaits settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(async () => {
  loadPopup();
  // popup.js calls init() on load, which fires its own GET_AUTO_STATE
  // runtime.sendMessage. Let that settle and forget it, so the assertions
  // below are about the button's traffic only.
  await flush();
  chromeStub.runtime.sendMessage.mockClear();
  chromeStub.tabs.sendMessage.mockClear();
  chromeStub.scripting.executeScript.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  const resolved = req.resolve(path.join(EXT_DIR, "popup.js"));
  delete req.cache[resolved];
  delete (globalThis as Record<string, unknown>).chrome;
  document.body.innerHTML = "";
});

describe('popup "Forzar captura + diagnóstico" — confirmation before the DOM is uploaded (PR #675 S2)', () => {
  it("asks for confirmation and names the exact URL about to be sent", async () => {
    withActiveTab();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    document.querySelector<HTMLButtonElement>("#diagnostic-btn")!.click();
    await flush();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const message = confirmSpy.mock.calls[0][0] as string;
    expect(message, "the owner must see WHICH page is about to be uploaded").toContain(TARGET_URL);
  });

  it("sends nothing at all when the confirmation is declined — not even a page read", async () => {
    withActiveTab();
    vi.spyOn(window, "confirm").mockReturnValue(false);

    document.querySelector<HTMLButtonElement>("#diagnostic-btn")!.click();
    await flush();

    // The DOM is never even requested from the content script, so a declined
    // confirm leaks nothing from the page into the extension either.
    expect(chromeStub.tabs.sendMessage).not.toHaveBeenCalled();
    expect(chromeStub.scripting.executeScript).not.toHaveBeenCalled();
    expect(chromeStub.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("sends SEND_DIAGNOSTIC once the confirmation is accepted", async () => {
    withActiveTab();
    vi.spyOn(window, "confirm").mockReturnValue(true);

    document.querySelector<HTMLButtonElement>("#diagnostic-btn")!.click();
    await flush();

    expect(chromeStub.tabs.sendMessage).toHaveBeenCalledWith(42, { type: "CAPTURE_DIAGNOSTIC" });
    const sent = chromeStub.runtime.sendMessage.mock.calls.find(
      (c) => (c[0] as { type?: string })?.type === "SEND_DIAGNOSTIC",
    );
    expect(sent, "SEND_DIAGNOSTIC was dispatched").toBeTruthy();
    expect((sent![0] as { url: string }).url).toBe(TARGET_URL);
    expect(document.querySelector("#diagnostic-status")!.textContent).toContain("enviado");
  });

  it("reports the failure and never prompts when there is no active tab", async () => {
    chromeStub.tabs.query.mockResolvedValue([]);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    document.querySelector<HTMLButtonElement>("#diagnostic-btn")!.click();
    await flush();

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(chromeStub.runtime.sendMessage).not.toHaveBeenCalled();
    expect(document.querySelector("#diagnostic-status")!.textContent).toContain("pestaña");
  });
});

describe("popup network-capture button — removed before #675 merged (issue #684)", () => {
  it('ships no "Grabar red y recargar" control', () => {
    expect(document.querySelector("#network-record-btn")).toBeNull();
    expect(popupHtmlBody()).not.toContain("Grabar red");
  });

  it("still ships the diagnostic button, outside every #state-* panel", () => {
    const btn = document.querySelector("#diagnostic-btn");
    expect(btn).not.toBeNull();
    // The always-reachable guarantee (issue #671): the footer is not inside
    // any panel showState() toggles.
    expect(btn!.closest("[id^='state-']")).toBeNull();
    expect(btn!.closest("#diagnostic-footer")).not.toBeNull();
  });
});
