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

  it("renders icon-only seguir/descartar/note buttons — the star button is gone (#422)", async () => {
    mockGetThenFetch(async () => ({ ok: true, json: async () => ({ currentState: null }) }));
    render(<FeedbackControls profileId={1} propertyId={2} />);

    await waitFor(() => expect(screen.getByTestId("feedback-accept")).toBeInTheDocument());
    expect(screen.getByTestId("feedback-accept")).toHaveTextContent("✓");
    expect(screen.getByTestId("feedback-reject")).toHaveTextContent("✗");
    expect(screen.getByTestId("feedback-note-toggle")).toHaveTextContent("✎");
    // #422: the star ("destacar") toggle was removed — accept IS the follow
    // action now, so there is no third state button.
    expect(screen.queryByTestId("feedback-star")).not.toBeInTheDocument();
    // Accept is relabelled to the follow/track semantics.
    expect(screen.getByTestId("feedback-accept")).toHaveAccessibleName("Seguir");
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

  it("#379: trusts initialState and skips the mount GET (the list already provided the verdict)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<FeedbackControls profileId={1} propertyId={2} initialState="reject" />);

    // No GET on mount — the button reflects the passed-in state immediately.
    expect(screen.getByTestId("feedback-reject")).toHaveAttribute("aria-pressed", "true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("#379: clicking the already-active reject un-marks it (POSTs a 'clear') and reports the neutral state up", async () => {
    const onStateChange = vi.fn();
    const fetchMock = vi
      .fn()
      // POST the clear; server derives the neutral state.
      .mockResolvedValueOnce({ ok: true, json: async () => ({ currentState: null }) });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedbackControls
        profileId={1}
        propertyId={2}
        initialState="reject"
        onStateChange={onStateChange}
      />,
    );

    fireEvent.click(screen.getByTestId("feedback-reject"));

    // The POST body carries the 'clear' feedback type — the un-reject wire.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({ feedbackType: "clear" });

    await waitFor(() =>
      expect(screen.getByTestId("feedback-reject")).toHaveAttribute("aria-pressed", "false"),
    );
    // Parent is told the property is now neutral so it can drop the
    // "Descartada" treatment.
    expect(onStateChange).toHaveBeenLastCalledWith(null);
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
        vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ currentState: "accept" }) }),
      );
      render(<FeedbackControls profileId={1} propertyId={2} />);

      await waitFor(() => expect(screen.getByTestId("feedback-accept")).toHaveAttribute("data-active", "true"));
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
    });

    it("moves data-active to the newly-clicked button once the server confirms the switch (accept -> reject)", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce({ ok: true, json: async () => ({ currentState: "accept" }) })
          .mockResolvedValueOnce({ ok: true, json: async () => ({ currentState: "reject" }) }),
      );
      render(<FeedbackControls profileId={1} propertyId={2} />);
      await waitFor(() => expect(screen.getByTestId("feedback-accept")).toHaveAttribute("data-active", "true"));

      fireEvent.click(screen.getByTestId("feedback-reject"));

      await waitFor(() => expect(screen.getByTestId("feedback-reject")).toHaveAttribute("data-active", "true"));
      // Same mutual-exclusivity getCurrentState (lib/db/feedback.ts) derives
      // server-side: rejecting replaces the accept, never adds to it.
      expect(screen.getByTestId("feedback-accept")).toHaveAttribute("data-active", "false");
    });

    it("every toggle carries the feedback-toggle class the CSS visibility rules key on", async () => {
      mockGetThenFetch(async () => ({ ok: true, json: async () => ({ currentState: null }) }));
      render(<FeedbackControls profileId={1} propertyId={2} />);
      await waitFor(() => expect(screen.getByTestId("feedback-accept")).toBeInTheDocument());

      for (const testId of ["feedback-accept", "feedback-reject", "feedback-note-toggle"]) {
        expect(screen.getByTestId(testId)).toHaveClass("feedback-toggle");
      }
    });

    // #167 review "also fix": this test (and the e2e assertions it mirrors at
    // card-detail-ux.spec.ts:280/:449) only proves the component *selects*
    // the right CSS custom-property *name* for each state — it does NOT and
    // CANNOT prove that name resolves to a real, visible colour. jsdom
    // doesn't run a layout/cascade engine, so `.style.background` here is
    // just the literal string the component wrote; if `--up`/`--down` were deleted from globals.css entirely, every assertion in
    // this file would still pass unchanged (a real browser would compute
    // `background-color` from an undefined var() as fully transparent, but
    // jsdom never gets that far). The companion test right below
    // ("the --up/--down tokens...") closes that specific gap the only
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

    it("each state type gets its own colour token — accept/reject don't collapse to one generic 'active' colour", async () => {
      const colorFor = async (currentState: "accept" | "reject") => {
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

      expect(accept).toBe("var(--up)");
      expect(reject).toBe("var(--down)");
      expect(new Set([accept, reject]).size).toBe(2);
    });

    // Closes the gap the two tests above cannot: jsdom can't resolve var(),
    // so it can't prove --up/--down actually resolve to a real
    // colour. What it CAN prove, as plain text, is that those custom
    // properties are still defined in the stylesheet at all — a deleted
    // token would leave every assertion above passing (a literal
    // "var(--up)" string is still written, resolved or not) while silently
    // making every active button transparent in a real browser. The
    // resolved-colour check itself lives in card-detail-ux.spec.ts (real
    // Chromium, real getComputedStyle).
    it("the --up/--down tokens the fills above rely on are actually defined in globals.css, in both themes", () => {
      const css = readFileSync(path.join(__dirname, "../../app/globals.css"), "utf8");
      for (const token of ["--up", "--down"]) {
        const matches = css.match(new RegExp(`${token}:\\s*#[0-9a-fA-F]{3,8}`, "g")) ?? [];
        // Defined at least twice: this project's light and dark theme blocks
        // each set their own value (globals.css's `:root`/dark-theme
        // selectors) — one definition alone would mean one theme silently
        // has no fill at all.
        expect(matches.length).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe("#585: onVoted — the triage bar's advance-on-confirm signal", () => {
    it("fires onVoted with the target state only after the server confirms an accept", async () => {
      const onVoted = vi.fn();
      mockGetThenFetch(async () => ({ ok: true, json: async () => ({ currentState: "accept" }) }));
      render(<FeedbackControls profileId={1} propertyId={2} onVoted={onVoted} />);
      await waitFor(() => expect(screen.getByTestId("feedback-accept")).toBeInTheDocument());

      // Not called on the optimistic write — only after the awaited POST
      // resolves. Assert it hasn't fired synchronously on click, then that it
      // has once the response settles.
      fireEvent.click(screen.getByTestId("feedback-accept"));
      expect(onVoted).not.toHaveBeenCalled();

      await waitFor(() => expect(onVoted).toHaveBeenCalledTimes(1));
      expect(onVoted).toHaveBeenCalledWith("accept");
    });

    it("fires onVoted with 'reject' after a confirmed reject", async () => {
      const onVoted = vi.fn();
      mockGetThenFetch(async () => ({ ok: true, json: async () => ({ currentState: "reject" }) }));
      render(<FeedbackControls profileId={1} propertyId={2} onVoted={onVoted} />);
      await waitFor(() => expect(screen.getByTestId("feedback-reject")).toBeInTheDocument());

      fireEvent.click(screen.getByTestId("feedback-reject"));

      await waitFor(() => expect(onVoted).toHaveBeenCalledTimes(1));
      expect(onVoted).toHaveBeenCalledWith("reject");
    });

    it("never fires onVoted for a clear (re-tapping the already-active toggle)", async () => {
      const onVoted = vi.fn();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ currentState: null }) });
      vi.stubGlobal("fetch", fetchMock);

      render(
        <FeedbackControls profileId={1} propertyId={2} initialState="reject" onVoted={onVoted} />,
      );

      fireEvent.click(screen.getByTestId("feedback-reject"));

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const [, init] = fetchMock.mock.calls[0];
      expect(JSON.parse(init.body as string)).toEqual({ feedbackType: "clear" });
      await waitFor(() =>
        expect(screen.getByTestId("feedback-reject")).toHaveAttribute("aria-pressed", "false"),
      );

      expect(onVoted).not.toHaveBeenCalled();
    });

    it("never fires onVoted for a note submit", async () => {
      const onVoted = vi.fn();
      const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) });
      vi.stubGlobal("fetch", fetchMock);

      render(<FeedbackControls profileId={1} propertyId={2} initialState={null} onVoted={onVoted} />);

      fireEvent.click(screen.getByTestId("feedback-note-toggle"));
      fireEvent.change(screen.getByTestId("feedback-note-input"), { target: { value: "ojo con esto" } });
      fireEvent.click(screen.getByTestId("feedback-note-submit"));

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(onVoted).not.toHaveBeenCalled();
    });

    it("does NOT fire onVoted when the POST fails — a lost verdict must never advance the triage loop", async () => {
      const onVoted = vi.fn();
      mockGetThenFetch(async () => ({ ok: false }));
      render(<FeedbackControls profileId={1} propertyId={2} onVoted={onVoted} />);
      await waitFor(() => expect(screen.getByTestId("feedback-accept")).toBeInTheDocument());

      fireEvent.click(screen.getByTestId("feedback-accept"));

      await screen.findByRole("alert");
      expect(onVoted).not.toHaveBeenCalled();
    });

    it("switching from one active state to the other still counts as a vote (target is non-null)", async () => {
      const onVoted = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ currentState: "reject" }) }),
      );
      render(
        <FeedbackControls profileId={1} propertyId={2} initialState="accept" onVoted={onVoted} />,
      );

      fireEvent.click(screen.getByTestId("feedback-reject"));

      await waitFor(() => expect(onVoted).toHaveBeenCalledTimes(1));
      expect(onVoted).toHaveBeenCalledWith("reject");
    });
  });

  describe("#585: size prop — compact (feed) vs detail (triage bar) tap targets", () => {
    it("defaults to the compact class (feed-card 26px context) when size is omitted", async () => {
      mockGetThenFetch(async () => ({ ok: true, json: async () => ({ currentState: null }) }));
      render(<FeedbackControls profileId={1} propertyId={2} />);
      await waitFor(() => expect(screen.getByTestId("feedback-accept")).toBeInTheDocument());

      for (const testId of ["feedback-accept", "feedback-reject", "feedback-note-toggle"]) {
        expect(screen.getByTestId(testId)).toHaveClass("feedback-toggle");
        expect(screen.getByTestId(testId)).not.toHaveClass("feedback-toggle--detail");
      }
    });

    it('adds the "detail" modifier class (44px triage-bar context) to every toggle when size="detail"', async () => {
      mockGetThenFetch(async () => ({ ok: true, json: async () => ({ currentState: null }) }));
      render(<FeedbackControls profileId={1} propertyId={2} size="detail" />);
      await waitFor(() => expect(screen.getByTestId("feedback-accept")).toBeInTheDocument());

      for (const testId of ["feedback-accept", "feedback-reject", "feedback-note-toggle"]) {
        expect(screen.getByTestId(testId)).toHaveClass("feedback-toggle");
        expect(screen.getByTestId(testId)).toHaveClass("feedback-toggle--detail");
      }
    });
  });
});
