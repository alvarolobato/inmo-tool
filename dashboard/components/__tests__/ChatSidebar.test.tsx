// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { DashboardSpec } from "@/lib/schema";

vi.mock("@/lib/useConfiguredModel", () => ({
  useConfiguredModel: () => null,
  displayModelName: (s: string) => s,
}));

import ChatSidebar from "../ChatSidebar";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStreamFetch(): Promise<Response> {
  const stream = new ReadableStream({ start(ctrl) { ctrl.close(); } });
  return Promise.resolve({ ok: true, body: stream } as unknown as Response);
}

const minimalSpec: DashboardSpec = {
  title: "Test Dashboard",
  widgets: [
    {
      id: "w1",
      type: "bar_chart",
      title: "Ventas",
      sql: "SELECT 1",
      x: "x",
      y: "y",
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChatSidebar", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("analyze mode opens with empty input", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const u = url as string;
        if (u.includes("/stream")) return makeStreamFetch();
        // Auto-load: return empty list
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        } as unknown as Response);
      }),
    );

    render(
      <ChatSidebar
        spec={minimalSpec}
        onSpecUpdate={vi.fn()}
        isOpen={true}
        onToggle={vi.fn()}
        dashboardId={1}
        initialMode="analizar"
      />,
    );

    // Switch to Analizar tab
    const analyzeTab = screen.getByRole("tab", { name: "Analizar" });
    expect(analyzeTab).toHaveAttribute("aria-selected", "true");

    // Textarea should have an empty value — no pre-filled seed prompt
    const textarea = screen.getByPlaceholderText(
      "Escribe un mensaje…",
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe("");
  });
});
