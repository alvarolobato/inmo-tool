// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import PreviousConversations from "../PreviousConversations";
import type { ConversationSummary } from "../PreviousConversations";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeConv = (overrides: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: "abc123def456",
  title: "Análisis de ventas",
  first_user_prompt: "¿Cuánto vendimos?",
  last_interaction_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1 hour ago
  created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  message_count: 4,
  archived_at: null,
  last_status: "ok",
  ...overrides,
});

const archivedConv = makeConv({
  id: "archived000001",
  title: "Conversación archivada",
  archived_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  last_status: null,
});

function mockFetchConversations(convs: ConversationSummary[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ conversations: convs }),
  });
}

function mockFetchError(status = 404) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({ error: "Not found" }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PreviousConversations", () => {
  const originalFetch = globalThis.fetch;
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    onClose.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // -----------------------------------------------------------------------
  // Loading state
  // -----------------------------------------------------------------------

  it("shows loading indicator while fetching", () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves

    render(
      <PreviousConversations
        dashboardId={42}
        mode="modify"
        onClose={onClose}
      />,
    );

    expect(screen.getByText(/Cargando/i)).toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // Empty state
  // -----------------------------------------------------------------------

  it("shows empty state when no conversations exist", async () => {
    globalThis.fetch = mockFetchConversations([]);

    render(
      <PreviousConversations
        dashboardId={42}
        mode="modify"
        onClose={onClose}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/No hay conversaciones anteriores/i)).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // Conversation list rendering
  // -----------------------------------------------------------------------

  it("renders active conversations with title and message count", async () => {
    const conv = makeConv({ title: "Mi análisis", message_count: 6 });
    globalThis.fetch = mockFetchConversations([conv]);

    render(
      <PreviousConversations
        dashboardId={42}
        mode="modify"
        onClose={onClose}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Mi análisis")).toBeInTheDocument();
      expect(screen.getByText(/6 mens\./i)).toBeInTheDocument();
    });
  });

  it("falls back to first_user_prompt when title is null", async () => {
    const conv = makeConv({ title: null, first_user_prompt: "Prompt sin título" });
    globalThis.fetch = mockFetchConversations([conv]);

    render(
      <PreviousConversations
        dashboardId={42}
        mode="modify"
        onClose={onClose}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Prompt sin título")).toBeInTheDocument();
    });
  });

  it("truncates long title to ~55 chars", async () => {
    const longTitle = "A".repeat(60);
    const conv = makeConv({ title: longTitle });
    globalThis.fetch = mockFetchConversations([conv]);

    render(
      <PreviousConversations
        dashboardId={42}
        mode="modify"
        onClose={onClose}
      />,
    );

    await waitFor(() => {
      const row = screen.getByTestId(`conversation-row-${conv.id}`);
      expect(row.textContent).toContain("…");
    });
  });

  // -----------------------------------------------------------------------
  // Archived conversations
  // -----------------------------------------------------------------------

  it("hides archived conversations by default", async () => {
    globalThis.fetch = mockFetchConversations([makeConv(), archivedConv]);

    render(
      <PreviousConversations
        dashboardId={42}
        mode="modify"
        onClose={onClose}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Análisis de ventas")).toBeInTheDocument();
    });

    // Archived conv should not be visible
    expect(screen.queryByText("Conversación archivada")).not.toBeInTheDocument();
  });

  it("shows archived conversations with badge when 'Mostrar archivadas' is toggled", async () => {
    // Single fetch always returns all conversations (include_archived=true); toggle filters client-side
    globalThis.fetch = mockFetchConversations([makeConv(), archivedConv]);

    render(
      <PreviousConversations
        dashboardId={42}
        mode="modify"
        onClose={onClose}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Análisis de ventas")).toBeInTheDocument();
    });

    // Archived conv hidden initially (client-side filter)
    expect(screen.queryByText("Conversación archivada")).not.toBeInTheDocument();

    // Toggle "Mostrar archivadas" — no new fetch, just client-side reveal
    const toggle = screen.getByTestId("show-archived-toggle");
    fireEvent.click(toggle);

    expect(screen.getByText("Conversación archivada")).toBeInTheDocument();

    // Archived badge should appear
    expect(
      screen.getByTestId(`archived-badge-${archivedConv.id}`),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`archived-badge-${archivedConv.id}`),
    ).toHaveTextContent("Archivada");
  });

  // -----------------------------------------------------------------------
  // Navigation stub
  // -----------------------------------------------------------------------

  it("navigates to /k/<id> when a conversation row is clicked", async () => {
    const conv = makeConv({ id: "testid000001" });
    globalThis.fetch = mockFetchConversations([conv]);

    // Capture window.location.href assignment and restore afterwards to avoid leaking state
    let navigatedTo = "";
    const originalHref = window.location.href;
    const originalDescriptor = Object.getOwnPropertyDescriptor(window, "location");
    Object.defineProperty(window, "location", {
      value: {
        ...window.location,
        set href(val: string) {
          navigatedTo = val;
        },
        get href() {
          return originalHref;
        },
      },
      configurable: true,
      writable: true,
    });

    try {
      render(
        <PreviousConversations
          dashboardId={42}
          mode="modify"
          onClose={onClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId(`conversation-row-${conv.id}`)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId(`conversation-row-${conv.id}`));

      expect(navigatedTo).toBe(`/k/${conv.id}`);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(window, "location", originalDescriptor);
      }
    }
  });

  // -----------------------------------------------------------------------
  // Error state
  // -----------------------------------------------------------------------

  it("shows error state and retry button when API fails", async () => {
    globalThis.fetch = mockFetchError(500);

    render(
      <PreviousConversations
        dashboardId={42}
        mode="modify"
        onClose={onClose}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/No se pudo cargar/i)).toBeInTheDocument();
      expect(screen.getByText(/Reintentar/i)).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // Close behavior
  // -----------------------------------------------------------------------

  it("calls onClose when close button is clicked", async () => {
    globalThis.fetch = mockFetchConversations([]);

    render(
      <PreviousConversations
        dashboardId={42}
        mode="modify"
        onClose={onClose}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText(/Cargando/i)).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Cerrar panel de conversaciones"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape key is pressed", async () => {
    globalThis.fetch = mockFetchConversations([]);

    render(
      <PreviousConversations
        dashboardId={42}
        mode="modify"
        onClose={onClose}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText(/Cargando/i)).not.toBeInTheDocument();
    });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Mode mapping
  // -----------------------------------------------------------------------

  it("passes mode=modify as mode=modify in the API query", async () => {
    globalThis.fetch = mockFetchConversations([]);

    render(
      <PreviousConversations
        dashboardId={42}
        mode="modify"
        onClose={onClose}
      />,
    );

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("mode=modify"),
        expect.objectContaining({ signal: expect.anything() }),
      );
    });
  });

  it("passes mode=analyze for analyze mode", async () => {
    globalThis.fetch = mockFetchConversations([]);

    render(
      <PreviousConversations
        dashboardId={42}
        mode="analyze"
        onClose={onClose}
      />,
    );

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("mode=analyze"),
        expect.objectContaining({ signal: expect.anything() }),
      );
    });
  });
});
