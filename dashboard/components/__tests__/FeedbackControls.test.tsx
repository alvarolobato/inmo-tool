// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { FeedbackControls } from "../candidates/FeedbackControls";

/**
 * Unit coverage for FeedbackControls (#152 review, "also fix" list):
 *   - the error state must render a real, visible message — not the bare
 *     "!" glyph that only exposed the text via `title` (unreachable by
 *     touch).
 *   - the component only ever renders the compact/icon-only layout now
 *     that the dead non-compact branch (and its broken star-button
 *     ternary) has been deleted; there is exactly one call site
 *     (CandidateCard) and it always wanted this layout.
 */
describe("FeedbackControls", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockGetThenFetch(postImpl: () => Promise<unknown>) {
    const fetchMock = vi
      .fn()
      // GET on mount
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ currentState: null }),
      })
      // POST from the submit under test
      .mockImplementationOnce(postImpl);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("renders icon-only accept/reject/star/note buttons (no inline-label variant exists anymore)", async () => {
    mockGetThenFetch(async () => ({ ok: true, json: async () => ({ currentState: null }) }));
    render(<FeedbackControls profileId={1} propertyId={2} />);

    await waitFor(() => expect(screen.getByTestId("feedback-accept")).toBeInTheDocument());
    expect(screen.getByTestId("feedback-accept")).toHaveTextContent("✓");
    expect(screen.getByTestId("feedback-reject")).toHaveTextContent("✗");
    expect(screen.getByTestId("feedback-star")).toHaveTextContent("★");
    expect(screen.getByTestId("feedback-note-toggle")).toHaveTextContent("✎");
    // The deleted non-compact variant used to render "✓ Aceptar" etc.
    expect(screen.queryByText("✓ Aceptar")).not.toBeInTheDocument();
  });

  it("reflects the fetched current state via aria-pressed on mount", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ currentState: "reject" }) }),
    );
    render(<FeedbackControls profileId={1} propertyId={2} />);

    await waitFor(() =>
      expect(screen.getByTestId("feedback-reject")).toHaveAttribute("aria-pressed", "true"),
    );
    expect(screen.getByTestId("feedback-accept")).toHaveAttribute("aria-pressed", "false");
  });

  it("clicking a toggle POSTs the feedback type and updates aria-pressed from the server response", async () => {
    mockGetThenFetch(async () => ({
      ok: true,
      json: async () => ({ currentState: "accept" }),
    }));
    render(<FeedbackControls profileId={1} propertyId={2} />);
    await waitFor(() => expect(screen.getByTestId("feedback-accept")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("feedback-accept"));

    await waitFor(() =>
      expect(screen.getByTestId("feedback-accept")).toHaveAttribute("aria-pressed", "true"),
    );
  });

  it("#152 review: a failed submit shows the real, visible error message — not a bare '!' only reachable via title", async () => {
    mockGetThenFetch(async () => ({ ok: false }));
    render(<FeedbackControls profileId={1} propertyId={2} />);
    await waitFor(() => expect(screen.getByTestId("feedback-accept")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("feedback-accept"));

    const alert = await screen.findByRole("alert");
    // The old bug: the element's own text content was just "!" and the
    // actual message lived only in `title`, which a touch user has no way
    // to trigger. The fix puts the real sentence in the visible content.
    expect(alert).toHaveTextContent("No se pudo guardar el feedback.");
    expect(alert.textContent).not.toBe("!");
  });

  it("reverts the optimistic toggle when the submit fails", async () => {
    mockGetThenFetch(async () => ({ ok: false }));
    render(<FeedbackControls profileId={1} propertyId={2} />);
    await waitFor(() => expect(screen.getByTestId("feedback-accept")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("feedback-accept"));

    await screen.findByRole("alert");
    expect(screen.getByTestId("feedback-accept")).toHaveAttribute("aria-pressed", "false");
  });
});
