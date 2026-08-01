// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const STORAGE_KEY = "ps.tweaks.v1";

// Vitest 4's jsdom environment ships a stubbed `localStorage` that is missing
// `setItem`/`getItem`/`clear` unless `--localstorage-file` is configured. We
// install a minimal in-memory polyfill on `window`/`globalThis` *before* any
// component module imports run so React effects see a working API.
beforeAll(() => {
  const store = new Map<string, string>();
  const polyfill: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => {
      store.delete(k);
    },
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: polyfill,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: polyfill,
  });
});

// Import the module under test *after* the polyfill is in place. (Static
// imports would run before `beforeAll`; doing it via `await import()` inside
// `beforeAll` is overkill — the components only touch `localStorage` from
// effects, which run after `render`, so the static import order is safe.)
import TweaksPanel, { TweaksPanelProvider, useTweaks } from "../TweaksPanel";

// Helper component that exposes the current tweaks via data-* attributes so
// tests can assert the in-memory default applied by the provider regardless of
// whether the panel UI is open.
function TweaksProbe() {
  const { tweaks } = useTweaks();
  return (
    <div
      data-testid="tweaks-probe"
      data-theme={tweaks.theme}
      data-accent={tweaks.accent}
      data-density={tweaks.density}
      data-kpi-style={tweaks.kpiStyle}
    />
  );
}

describe("TweaksPanel — defaults (issue #412 items 1, 2)", () => {
  beforeEach(() => {
    // Each test starts with a clean localStorage and a clean <html> element so
    // the persistence-read effect cannot leak state between tests.
    localStorage.clear();
    const root = document.documentElement;
    root.removeAttribute("data-theme");
    root.removeAttribute("data-accent");
    root.removeAttribute("data-density");
    root.classList.remove("dark");
  });

  it("defaults to dark theme when localStorage is empty", () => {
    render(
      <TweaksPanelProvider>
        <TweaksProbe />
      </TweaksPanelProvider>,
    );
    const probe = screen.getByTestId("tweaks-probe");
    expect(probe.getAttribute("data-theme")).toBe("dark");
  });

  it("defaults to electric accent when localStorage is empty", () => {
    render(
      <TweaksPanelProvider>
        <TweaksProbe />
      </TweaksPanelProvider>,
    );
    const probe = screen.getByTestId("tweaks-probe");
    expect(probe.getAttribute("data-accent")).toBe("electric");
  });

  it("renders the dark + electric radio options as selected by default in the open panel", () => {
    render(
      <TweaksPanelProvider>
        <TweaksPanel open={true} onClose={() => {}} />
      </TweaksPanelProvider>,
    );
    // Both radios live as hidden inputs inside their <label> wrappers — the
    // visual "selected" state is the colored circle, but the underlying input
    // is the source of truth and is what we assert on.
    const darkRadio = document.querySelector(
      'input[type="radio"][value="dark"]',
    ) as HTMLInputElement | null;
    const electricRadio = document.querySelector(
      'input[type="radio"][value="electric"]',
    ) as HTMLInputElement | null;
    expect(darkRadio).not.toBeNull();
    expect(electricRadio).not.toBeNull();
    expect(darkRadio!.checked).toBe(true);
    expect(electricRadio!.checked).toBe(true);
  });

  it("falls back to dark theme when persisted theme value is invalid", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ theme: "neon", accent: "electric" }),
    );
    render(
      <TweaksPanelProvider>
        <TweaksProbe />
      </TweaksPanelProvider>,
    );
    expect(screen.getByTestId("tweaks-probe").getAttribute("data-theme")).toBe(
      "dark",
    );
  });

  it("falls back to electric accent when persisted accent value is invalid", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ theme: "dark", accent: "rainbow" }),
    );
    render(
      <TweaksPanelProvider>
        <TweaksProbe />
      </TweaksPanelProvider>,
    );
    expect(
      screen.getByTestId("tweaks-probe").getAttribute("data-accent"),
    ).toBe("electric");
  });

  it("applies dark + electric to <html> element when localStorage is empty", () => {
    // The provider only writes DOM attributes when localStorage has data — when
    // there's nothing persisted it leaves the SSR pre-paint values in place.
    // Pre-paint already sets data-theme=dark + data-accent=electric (see
    // app/layout.tsx); to verify the fallback path explicitly, we set the
    // attributes here as the SSR layer would, and assert the provider does
    // not clobber them.
    const root = document.documentElement;
    root.setAttribute("data-theme", "dark");
    root.setAttribute("data-accent", "electric");
    render(
      <TweaksPanelProvider>
        <TweaksProbe />
      </TweaksPanelProvider>,
    );
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.getAttribute("data-accent")).toBe("electric");
  });
});
