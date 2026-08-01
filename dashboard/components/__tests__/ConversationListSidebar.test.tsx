// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { ConversationListSidebar } from "../ConversationListSidebar";
import type { ConversationRow } from "@/app/conversations/types";

function makeRow(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: "conv-abc",
    title: "Test title",
    first_user_prompt: "Primera pregunta",
    mode: "chat",
    context_url: null,
    context_kind: "global",
    context_ref: null,
    last_interaction_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    archived_at: null,
    last_read_at: null,
    last_status: null,
    llm_provider: null,
    llm_driver: null,
    message_count: 0,
    tool_calls_count: 0,
    rounds_count: 0,
    duration_seconds: 0,
    last_message_preview: null,
    token_total: 0,
    is_unread: false,
    ...overrides,
  };
}

describe("ConversationListSidebar", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders loading spinner initially", () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    render(<ConversationListSidebar selectedId="conv-abc" />);
    // The spinner should be visible while loading
    const sidebar = screen.getByTestId("conversation-list-sidebar");
    expect(sidebar).toBeInTheDocument();
  });

  it("renders conversation rows after fetch", async () => {
    const rows = [
      makeRow({ id: "conv-1", title: "Primera conv" }),
      makeRow({ id: "conv-2", title: "Segunda conv" }),
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => rows,
    });

    render(<ConversationListSidebar selectedId="conv-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar-conv-conv-1")).toBeInTheDocument();
      expect(screen.getByTestId("sidebar-conv-conv-2")).toBeInTheDocument();
    });

    expect(screen.getByText("Primera conv")).toBeInTheDocument();
    expect(screen.getByText("Segunda conv")).toBeInTheDocument();
  });

  it("highlights the selected conversation", async () => {
    const rows = [makeRow({ id: "conv-1", title: "Mi conversación" })];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => rows,
    });

    render(<ConversationListSidebar selectedId="conv-1" />);

    await waitFor(() => {
      const link = screen.getByTestId("sidebar-conv-conv-1");
      // The selected row uses var(--bg-3) background
      expect(link).toHaveStyle({ background: "var(--bg-3)" });
    });
  });

  it("shows unread dot when is_unread is true", async () => {
    const rows = [makeRow({ id: "conv-1", title: "Sin leer", is_unread: true })];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => rows,
    });

    render(<ConversationListSidebar selectedId="other-id" />);

    await waitFor(() => {
      const indicator = screen.getByLabelText("No leído");
      expect(indicator).toBeInTheDocument();
      expect(indicator).toHaveStyle({ background: "var(--accent)" });
    });
  });

  it("shows 'Sin conversaciones' when list is empty", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    render(<ConversationListSidebar selectedId="conv-1" />);

    await waitFor(() => {
      expect(screen.getByText("Sin conversaciones")).toBeInTheDocument();
    });
  });

  it("links each row to /conversations/:id", async () => {
    const rows = [makeRow({ id: "conv-xyz", title: "Link test" })];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => rows,
    });

    render(<ConversationListSidebar selectedId="other" />);

    await waitFor(() => {
      const link = screen.getByTestId("sidebar-conv-conv-xyz");
      expect(link).toHaveAttribute("href", "/conversations/conv-xyz");
    });
  });

  it("fetches all conversations without mode/context_kind filter", async () => {
    // Regression: original spec hardcoded ?mode=chat&context_kind=global which
    // made the sidebar empty when viewing an analyze/modify/dashboard conversation.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    });
    render(<ConversationListSidebar selectedId="any" />);
    await waitFor(() => {
      const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
      expect(url).not.toContain("mode=");
      expect(url).not.toContain("context_kind=");
      expect(url).toContain("/api/conversations");
    });
  });

  it("shows dashboard analyze conversations alongside free-chat ones", async () => {
    // Regression: sidebar must show conversations of any context_kind/mode.
    const rows = [
      makeRow({ id: "free-chat-1", title: "Pregunta libre", mode: "chat", context_kind: "global" }),
      makeRow({ id: "analyze-1", title: "Analiza ventas", mode: "analyze", context_kind: "dashboard", context_ref: "42" }),
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => rows });
    render(<ConversationListSidebar selectedId="free-chat-1" />);
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-conv-free-chat-1")).toBeInTheDocument();
      expect(screen.getByTestId("sidebar-conv-analyze-1")).toBeInTheDocument();
    });
  });

  it("uses first_user_prompt when title is null", async () => {
    const rows = [makeRow({ id: "conv-1", title: null, first_user_prompt: "Pregunta sin título" })];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => rows,
    });

    render(<ConversationListSidebar selectedId="other" />);

    await waitFor(() => {
      expect(screen.getByText("Pregunta sin título")).toBeInTheDocument();
    });
  });
});
