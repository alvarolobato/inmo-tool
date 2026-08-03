// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { FeedbackControls } from "../candidates/FeedbackControls";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

  describe("#167: always-visible active state", () => {
    it("marks only the button matching the fetched current state as data-active, so it stays visible without hover (globals.css .feedback-toggle[data-active])", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ currentState: "star" }) }),
      );
      render(<FeedbackControls profileId={1} propertyId={2} />);

      await waitFor(() => expect(screen.getByTestId("feedback-star")).toHaveAttribute("data-active", "true"));
      expect(screen.getByTestId("feedback-accept")).toHaveAttribute("data-active", "false");
      expect(screen.getByTestId("feedback-reject")).toHaveAttribute("data-active", "false");
      // The note toggle isn't a state button — it never carries data-active,
      // so it can never accidentally read as "this property's status".
      expect(screen.getByTestId("feedback-note-toggle")).not.toHaveAttribute("data-active");
    });

    it("no button is data-active when the property has no recorded state yet", async () => {
      mockGetThenFetch(async () => ({ ok: true, json: async () => ({ currentState: null }) }));
      render(<FeedbackControls profileId={1} propertyId={2} />);

      await waitFor(() => expect(screen.getByTestId("feedback-accept")).toBeInTheDocument());
      expect(screen.getByTestId("feedback-accept")).toHaveAttribute("data-active", "false");
      expect(screen.getByTestId("feedback-reject")).toHaveAttribute("data-active", "false");
      expect(screen.getByTestId("feedback-star")).toHaveAttribute("data-active", "false");
    });

    it("moves data-active to the newly-clicked button once the server confirms the switch (accept -> star)", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce({ ok: true, json: async () => ({ currentState: "accept" }) })
          .mockResolvedValueOnce({ ok: true, json: async () => ({ currentState: "star" }) }),
      );
      render(<FeedbackControls profileId={1} propertyId={2} />);
      await waitFor(() => expect(screen.getByTestId("feedback-accept")).toHaveAttribute("data-active", "true"));

      fireEvent.click(screen.getByTestId("feedback-star"));

      await waitFor(() => expect(screen.getByTestId("feedback-star")).toHaveAttribute("data-active", "true"));
      // Same mutual-exclusivity getCurrentState (lib/db/feedback.ts) derives
      // server-side: starring replaces accepted, never adds to it.
      expect(screen.getByTestId("feedback-accept")).toHaveAttribute("data-active", "false");
    });

    it("every toggle carries the feedback-toggle class the CSS visibility rules key on", async () => {
      mockGetThenFetch(async () => ({ ok: true, json: async () => ({ currentState: null }) }));
      render(<FeedbackControls profileId={1} propertyId={2} />);
      await waitFor(() => expect(screen.getByTestId("feedback-accept")).toBeInTheDocument());

      for (const testId of ["feedback-accept", "feedback-reject", "feedback-star", "feedback-note-toggle"]) {
        expect(screen.getByTestId(testId)).toHaveClass("feedback-toggle");
      }
    });

    // #167 review "also fix": this test (and the e2e assertions it mirrors at
    // card-detail-ux.spec.ts:280/:449) only proves the component *selects*
    // the right CSS custom-property *name* for each state — it does NOT and
    // CANNOT prove that name resolves to a real, visible colour. jsdom
    // doesn't run a layout/cascade engine, so `.style.background` here is
    // just the literal string the component wrote; if `--up`/`--down`/
    // `--warn` were deleted from globals.css entirely, every assertion in
    // this file would still pass unchanged (a real browser would compute
    // `background-color` from an undefined var() as fully transparent, but
    // jsdom never gets that far). The companion test right below
    // ("the --up/--down/--warn tokens...") closes that specific gap the only
    // way jsdom can: by asserting the tokens are actually *defined* in the
    // stylesheet, as text — not by asserting a resolved colour, which is
    // what card-detail-ux.spec.ts's real-Chromium `getComputedStyle` checks
    // are for.
    it("gives the active button a distinct, semantically-coloured fill token — not the muted fill a visible-but-inactive button uses (touch has no opacity signal to fall back on)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ currentState: "accept" }) }),
      );
      render(<FeedbackControls profileId={1} propertyId={2} />);
      await waitFor(() => expect(screen.getByTestId("feedback-accept")).toHaveAttribute("data-active", "true"));

      const accept = screen.getByTestId("feedback-accept");
      const reject = screen.getByTestId("feedback-reject");
      // jsdom normalizes rgba() spacing on read-back, even though the
      // source style string has none.
      const INACTIVE_FILL = "rgba(0, 0, 0, 0.35)";

      expect(accept.style.background).not.toBe(INACTIVE_FILL);
      expect(accept.style.background).toBe("var(--up)");
      // The inactive sibling on the same row keeps the muted fill — this is
      // what "visually distinct" is measured against, on both touch (always
      // visible) and desktop (hover-revealed unset button).
      expect(reject.style.background).toBe(INACTIVE_FILL);
    });

    it("each state type gets its own colour token — accept/reject/star don't collapse to one generic 'active' colour", async () => {
      const colorFor = async (currentState: "accept" | "reject" | "star") => {
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ currentState }) }),
        );
        const { unmount } = render(<FeedbackControls profileId={1} propertyId={2} />);
        await waitFor(() =>
          expect(screen.getByTestId(`feedback-${currentState}`)).toHaveAttribute("data-active", "true"),
        );
        const color = screen.getByTestId(`feedback-${currentState}`).style.background;
        unmount();
        return color;
      };

      const accept = await colorFor("accept");
      const reject = await colorFor("reject");
      const star = await colorFor("star");

      expect(accept).toBe("var(--up)");
      expect(reject).toBe("var(--down)");
      expect(star).toBe("var(--warn)");
      expect(new Set([accept, reject, star]).size).toBe(3);
    });

    // Closes the gap the two tests above cannot: jsdom can't resolve var(),
    // so it can't prove --up/--down/--warn actually resolve to a real
    // colour. What it CAN prove, as plain text, is that those custom
    // properties are still defined in the stylesheet at all — a deleted
    // token would leave every assertion above passing (a literal
    // "var(--up)" string is still written, resolved or not) while silently
    // making every active button transparent in a real browser. The
    // resolved-colour check itself lives in card-detail-ux.spec.ts (real
    // Chromium, real getComputedStyle).
    it("the --up/--down/--warn tokens the fills above rely on are actually defined in globals.css, in both themes", () => {
      const css = readFileSync(path.join(__dirname, "../../app/globals.css"), "utf8");
      for (const token of ["--up", "--down", "--warn"]) {
        const matches = css.match(new RegExp(`${token}:\\s*#[0-9a-fA-F]{3,8}`, "g")) ?? [];
        // Defined at least twice: this project's light and dark theme blocks
        // each set their own value (globals.css's `:root`/dark-theme
        // selectors) — one definition alone would mean one theme silently
        // has no fill at all.
        expect(matches.length).toBeGreaterThanOrEqual(2);
      }
    });
  });
});
