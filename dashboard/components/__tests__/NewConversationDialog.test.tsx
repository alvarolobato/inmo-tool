// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

import { NewConversationDialog } from "../NewConversationDialog";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderDialog(open = true, onClose = vi.fn()) {
  return render(<NewConversationDialog open={open} onClose={onClose} />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NewConversationDialog", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockPush.mockReset();
    vi.resetAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ── Rendering ──────────────────────────────────────────────────────────────

  it("renders nothing when closed", () => {
    renderDialog(false);
    expect(screen.queryByTestId("new-conversation-dialog")).not.toBeInTheDocument();
  });

  it("renders dialog with textarea and buttons when open", () => {
    renderDialog();
    expect(screen.getByTestId("new-conversation-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("new-conversation-prompt")).toBeInTheDocument();
    expect(screen.getByTestId("new-conversation-submit")).toBeInTheDocument();
    expect(screen.getByTestId("new-conversation-cancel")).toBeInTheDocument();
  });

  it("calls onClose when cancel button is clicked", () => {
    const onClose = vi.fn();
    renderDialog(true, onClose);
    fireEvent.click(screen.getByTestId("new-conversation-cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when backdrop is clicked", () => {
    const onClose = vi.fn();
    renderDialog(true, onClose);
    fireEvent.click(screen.getByTestId("new-conversation-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── Submit with prompt ─────────────────────────────────────────────────────

  it("with prompt: calls POST /api/conversations, stores prompt in sessionStorage, then navigates to /conversations/:id (no ?q=)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "abc123def456", c_url: "/c/abc123def456" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    sessionStorage.clear();

    renderDialog();
    fireEvent.change(screen.getByTestId("new-conversation-prompt"), {
      target: { value: "¿Cuánto vendimos ayer?" },
    });
    fireEvent.click(screen.getByTestId("new-conversation-submit"));

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith("/conversations/abc123def456"),
    );

    // Prompt stored in sessionStorage for ConversationViewer to consume
    expect(sessionStorage.getItem("conv-autosend-abc123def456")).toBe("¿Cuánto vendimos ayer?");

    // Only one fetch call (no messages POST)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.mode).toBe("chat");
    expect(body.context_kind).toBe("global");
    expect(body.first_user_prompt).toBe("¿Cuánto vendimos ayer?");
  });

  // ── Submit without prompt ──────────────────────────────────────────────────

  it("without prompt: calls POST /api/conversations and navigates to /conversations/:id (no ?q=)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "abc123def456", c_url: "/c/abc123def456" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();
    // Leave textarea empty
    fireEvent.click(screen.getByTestId("new-conversation-submit"));

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith("/conversations/abc123def456"),
    );

    // Only one fetch call (no messages POST)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.first_user_prompt).toBeUndefined();
  });

  it("whitespace-only prompt is treated as empty (navigates without ?q=)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "abc123def456", c_url: "/c/abc123def456" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();
    fireEvent.change(screen.getByTestId("new-conversation-prompt"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByTestId("new-conversation-submit"));

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith("/conversations/abc123def456"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  it("shows inline error when POST /api/conversations fails; does not navigate", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "DB_ERROR" }),
    }));

    renderDialog();
    fireEvent.change(screen.getByTestId("new-conversation-prompt"), {
      target: { value: "Pregunta" },
    });
    fireEvent.click(screen.getByTestId("new-conversation-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("new-conversation-error")).toBeInTheDocument()
    );
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("disables buttons while loading", async () => {
    let resolveCreate!: (v: unknown) => void;
    const pendingPromise = new Promise((res) => { resolveCreate = res; });
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(pendingPromise));

    renderDialog();
    fireEvent.click(screen.getByTestId("new-conversation-submit"));

    // While pending, both buttons are disabled
    expect(screen.getByTestId("new-conversation-submit")).toBeDisabled();
    expect(screen.getByTestId("new-conversation-cancel")).toBeDisabled();

    // Resolve to avoid hanging
    resolveCreate({
      ok: true,
      json: async () => ({ id: "abc123def456", c_url: "/c/abc123def456" }),
    });
  });
});
