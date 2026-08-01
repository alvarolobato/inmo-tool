// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

import WeeklySummaryButton from "../WeeklySummaryButton";

beforeEach(() => {
  mockPush.mockReset();
  vi.resetAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WeeklySummaryButton", () => {
  it("renders a button with 'Resumen semanal' text", () => {
    render(<WeeklySummaryButton />);
    const btn = screen.getByTestId("weekly-summary-btn");
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent("Resumen semanal");
  });

  it("button is enabled by default", () => {
    render(<WeeklySummaryButton />);
    expect(screen.getByTestId("weekly-summary-btn")).not.toBeDisabled();
  });

  it("navigates to c_url after successful conversation creation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ c_url: "/c/conv-abc", k_url: "/k/conv-abc" }),
    }));

    render(<WeeklySummaryButton />);
    fireEvent.click(screen.getByTestId("weekly-summary-btn"));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/c/conv-abc");
    });
  });

  it("posts to /api/conversations with correct body", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ c_url: "/c/conv-abc", k_url: "/k/conv-abc" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    render(<WeeklySummaryButton />);
    fireEvent.click(screen.getByTestId("weekly-summary-btn"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/conversations",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.mode).toBe("summary");
    expect(body.context_kind).toBe("home");
    expect(body.context_url).toBe("/inicio");
    expect(body.first_user_prompt).toBeTruthy();
    expect(body.seed_prompt).toBeUndefined();
  });

  it("logs error and does not navigate when conversation creation fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }));

    render(<WeeklySummaryButton />);
    fireEvent.click(screen.getByTestId("weekly-summary-btn"));

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalled();
    });
    expect(mockPush).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("logs error and does not navigate when fetch throws", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    render(<WeeklySummaryButton />);
    fireEvent.click(screen.getByTestId("weekly-summary-btn"));

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalled();
    });
    expect(mockPush).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("applies custom style via style prop", () => {
    const customStyle = { fontSize: "14px", fontWeight: "bold" };
    render(<WeeklySummaryButton style={customStyle} />);
    const btn = screen.getByTestId("weekly-summary-btn");
    expect(btn).toHaveStyle({ fontSize: "14px" });
  });

  it("disables button and shows loading indicator while fetching, ignores second click", async () => {
    let resolveFetch!: (value: unknown) => void;
    const pendingFetch = new Promise((resolve) => { resolveFetch = resolve; });
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(pendingFetch));

    render(<WeeklySummaryButton />);
    const btn = screen.getByTestId("weekly-summary-btn");

    fireEvent.click(btn);

    await waitFor(() => {
      expect(btn).toBeDisabled();
      expect(btn).toHaveTextContent("…");
    });

    // Second click while loading must not trigger a second POST
    fireEvent.click(btn);
    expect(vi.mocked(globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);

    // Resolve the fetch inside act so state updates are flushed
    await act(async () => {
      resolveFetch({ ok: false, status: 500 });
    });
  });

  it("shows 'Error — reintentar' text when request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    render(<WeeklySummaryButton />);
    fireEvent.click(screen.getByTestId("weekly-summary-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("weekly-summary-btn")).toHaveTextContent("Error — reintentar");
    });
    expect(mockPush).not.toHaveBeenCalled();
  });
});
