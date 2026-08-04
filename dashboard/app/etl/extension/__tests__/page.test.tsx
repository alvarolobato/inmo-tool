// @vitest-environment jsdom
/**
 * Unit tests for the extension setup page (issue #256).
 *
 * The page is also covered by a D-041 e2e (extension-setup.spec.ts), but v8
 * coverage only counts vitest — so its client-side logic (key fetch + mask,
 * reveal toggle, copy handlers with their clipboard fallback, and the fetch
 * error branch) is exercised here so it does not drag the global coverage
 * ratio below the #160 floor.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import ExtensionSetupPage from "../page";

// Tremor's <Card> pulls in components that touch ResizeObserver in jsdom.
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;

const ADMIN_KEY = "test-admin-key-256";

/** Install a mock clipboard; returns the writeText spy. */
function stubClipboard(impl?: () => Promise<void>): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(impl ?? (() => Promise.resolve()));
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

function stubFetch(handler: (url: string) => Promise<Response> | Response) {
  const fn = vi.fn((input: RequestInfo | URL) => Promise.resolve(handler(String(input))));
  vi.stubGlobal("fetch", fn);
  return fn;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("ExtensionSetupPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the API URL from window.location.origin and the download link", async () => {
    stubClipboard();
    stubFetch(() => jsonResponse({ key: ADMIN_KEY }));

    render(<ExtensionSetupPage />);

    expect(await screen.findByTestId("extension-setup-page")).toBeInTheDocument();
    expect(screen.getByTestId("extension-api-url")).toHaveTextContent(window.location.origin);
    expect(screen.getByTestId("extension-download-btn")).toHaveAttribute(
      "href",
      "/api/extension/download",
    );
  });

  it("masks the key by default and reveals/hides it on toggle", async () => {
    stubClipboard();
    stubFetch(() => jsonResponse({ key: ADMIN_KEY }));

    render(<ExtensionSetupPage />);

    const keyEl = await screen.findByTestId("extension-api-key");
    // Masked: bullet characters, not the real key.
    await waitFor(() => expect(keyEl).toHaveTextContent("•"));
    expect(keyEl).not.toHaveTextContent(ADMIN_KEY);

    // Reveal → real key.
    fireEvent.click(screen.getByTestId("extension-api-key-reveal"));
    expect(keyEl).toHaveTextContent(ADMIN_KEY);

    // Hide → masked again.
    fireEvent.click(screen.getByTestId("extension-api-key-reveal"));
    expect(keyEl).not.toHaveTextContent(ADMIN_KEY);
  });

  it("copies the API URL to the clipboard and confirms", async () => {
    const writeText = stubClipboard();
    stubFetch(() => jsonResponse({ key: ADMIN_KEY }));

    render(<ExtensionSetupPage />);
    await screen.findByTestId("extension-setup-page");

    const copyBtn = screen.getByTestId("extension-api-url-copy");
    fireEvent.click(copyBtn);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(window.location.origin));
    await waitFor(() => expect(copyBtn).toHaveTextContent("Copiado"));
  });

  it("copies the real key (not the mask) even while masked", async () => {
    const writeText = stubClipboard();
    stubFetch(() => jsonResponse({ key: ADMIN_KEY }));

    render(<ExtensionSetupPage />);
    // Wait until the key has loaded so the copy button is enabled.
    await waitFor(() =>
      expect(screen.getByTestId("extension-api-key-copy")).not.toBeDisabled(),
    );

    fireEvent.click(screen.getByTestId("extension-api-key-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ADMIN_KEY));
  });

  it("does not throw when the clipboard write is blocked", async () => {
    const writeText = stubClipboard(() => Promise.reject(new Error("blocked")));
    stubFetch(() => jsonResponse({ key: ADMIN_KEY }));

    render(<ExtensionSetupPage />);
    await screen.findByTestId("extension-setup-page");

    const copyBtn = screen.getByTestId("extension-api-url-copy");
    fireEvent.click(copyBtn);
    // The rejection is swallowed — the button never flips to "Copiado".
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(copyBtn).not.toHaveTextContent("Copiado");
  });

  it("renders an error surface when the key endpoint fails", async () => {
    stubClipboard();
    stubFetch(() =>
      jsonResponse({ error: "admin_not_configured", message: "no key" }, false, 503),
    );

    render(<ExtensionSetupPage />);
    await screen.findByTestId("extension-setup-page");

    // The key section swaps in ErrorDisplay; the masked value field is gone.
    await waitFor(() => expect(screen.queryByTestId("extension-api-key")).toBeNull());
  });

  it("surfaces a thrown fetch (network) error too", async () => {
    stubClipboard();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );

    render(<ExtensionSetupPage />);
    await screen.findByTestId("extension-setup-page");

    await waitFor(() => expect(screen.queryByTestId("extension-api-key")).toBeNull());
  });
});
