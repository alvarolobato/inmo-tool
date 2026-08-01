// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ConversationsTable } from "../ConversationsTable";
import { getModePillStyle } from "@/lib/conversation-mode-style";
import type { ConversationRow } from "@/app/conversations/types";


// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
  useParams: () => ({}),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_ROW: ConversationRow = {
  id: "abc123def456",
  title: "Test conversation",
  first_user_prompt: "Muéstrame las ventas de ayer",
  mode: "analyze",
  context_url: "/paneles/1",
  context_kind: "dashboard",
  context_ref: "1",
  last_interaction_at: new Date(Date.now() - 3600 * 1000).toISOString(),
  created_at: new Date(Date.now() - 7200 * 1000).toISOString(),
  archived_at: null,
  last_status: "ok",
  llm_provider: "openrouter",
  llm_driver: null,
  message_count: 6,
  tool_calls_count: 3,
  rounds_count: 2,
  duration_seconds: 3600,
  last_message_preview: "Las ventas de ayer fueron 38.420€",
  token_total: 12400,
  last_read_at: null,
  is_unread: false,
};

function makeRow(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return { ...BASE_ROW, ...overrides };
}

const MOCK_ROWS: ConversationRow[] = [
  makeRow({ id: "row1111111111", mode: "generate", title: "Nuevo dashboard" }),
  makeRow({ id: "row2222222222", mode: "modify", title: "Ajuste de ventas" }),
  makeRow({ id: "row3333333333", mode: "analyze", title: "Análisis mensual" }),
  makeRow({
    id: "row4444444444",
    mode: "suggest",
    title: "Sugerencia de widgets",
  }),
  makeRow({ id: "row5555555555", mode: "gap", title: "Hueco detectado" }),
  makeRow({ id: "row6666666666", mode: "summary", title: "Resumen semanal" }),
  makeRow({
    id: "row7777777777",
    mode: "title",
    title: "Auto-título generado",
  }),
  makeRow({
    id: "archived1111",
    mode: "analyze",
    title: "Conversación archivada",
    archived_at: new Date(Date.now() - 86400 * 1000).toISOString(),
  }),
  makeRow({
    id: "errored11111",
    mode: "modify",
    title: "Con error",
    last_status: "error",
  }),
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConversationsTable", () => {
  const noop = vi.fn();

  beforeEach(() => {
    noop.mockClear();
    mockPush.mockClear();
  });

  it("renders without crashing with empty list", () => {
    expect(() =>
      render(
        <ConversationsTable
          conversations={[]}
          onArchiveToggle={noop}
          onRename={noop}
        />
      )
    ).not.toThrow();
  });

  it("shows empty state when no conversations", () => {
    render(
      <ConversationsTable
        conversations={[]}
        onArchiveToggle={noop}
        onRename={noop}
      />
    );
    expect(screen.getByTestId("empty-state")).toBeInTheDocument();
    expect(screen.getByText(/No hay conversaciones/)).toBeInTheDocument();
  });

  it("renders expected column headers and NOT removed columns", () => {
    render(
      <ConversationsTable
        conversations={MOCK_ROWS}
        onArchiveToggle={noop}
        onRename={noop}
      />
    );
    const table = screen.getByTestId("conversations-table");
    const thead = table.querySelector("thead")!;
    const headerTexts = Array.from(thead.querySelectorAll("th")).map((th) =>
      th.textContent?.replace(/[↑↓]/, "").trim()
    );
    // Present columns
    expect(headerTexts).toContain("Título");
    expect(headerTexts).toContain("Tipo");
    expect(headerTexts).toContain("Contexto");
    expect(headerTexts).toContain("Última actividad");
    expect(headerTexts).toContain("Creada");
    expect(headerTexts).toContain("Duración");
    expect(headerTexts).toContain("Actividad");
    expect(headerTexts).toContain("Tokens");
    expect(headerTexts).toContain("Acciones");
    // Removed columns must not be present
    expect(headerTexts).not.toContain("Vista previa");
    expect(headerTexts).not.toContain("Estado");
  });

  it("has no delete button or affordance", () => {
    render(
      <ConversationsTable
        conversations={MOCK_ROWS}
        onArchiveToggle={noop}
        onRename={noop}
      />
    );
    const container = screen.getByTestId("conversations-table");
    expect(within(container).queryByText(/[Ee]liminar/)).toBeNull();
    expect(within(container).queryByText(/[Bb]orrar/)).toBeNull();
    expect(within(container).queryByText(/[Dd]elete/)).toBeNull();
  });

  describe("Mode pill snapshot — canonical palette", () => {
    const MODES_EXPECTED = [
      { mode: "generate", expectedBg: "bg-indigo-100", expectedFg: "text-indigo-800" },
      { mode: "modify", expectedBg: "bg-amber-100", expectedFg: "text-amber-800" },
      { mode: "analyze", expectedBg: "bg-violet-100", expectedFg: "text-violet-800" },
      { mode: "suggest", expectedBg: "bg-emerald-100", expectedFg: "text-emerald-800" },
      { mode: "gap", expectedBg: "bg-rose-100", expectedFg: "text-rose-800" },
      { mode: "summary", expectedBg: "bg-teal-100", expectedFg: "text-teal-800" },
      { mode: "title", expectedBg: "bg-slate-100", expectedFg: "text-slate-700" },
    ];

    it("getModePillStyle returns correct classes for all 7 modes", () => {
      MODES_EXPECTED.forEach(({ mode, expectedBg, expectedFg }) => {
        const style = getModePillStyle(mode);
        expect(style.bg).toBe(expectedBg);
        expect(style.fg).toBe(expectedFg);
      });
    });

    it("getModePillStyle returns fallback for unknown mode", () => {
      const style = getModePillStyle("unknown-mode");
      expect(style.bg).toBe("bg-slate-100");
      expect(style.fg).toBe("text-slate-600");
    });

    it("mode pills render with correct CSS classes from the canonical palette", () => {
      render(
        <ConversationsTable
          conversations={MOCK_ROWS}
          onArchiveToggle={noop}
          onRename={noop}
        />
      );

      MODES_EXPECTED.forEach(({ mode, expectedBg, expectedFg }) => {
        const pills = document.querySelectorAll(`[data-mode="${mode}"]`);
        expect(pills.length).toBeGreaterThan(0);
        pills.forEach((pill) => {
          expect(pill.className).toContain(expectedBg);
          expect(pill.className).toContain(expectedFg);
        });
      });
    });
  });

  it("renders title for rows that have one", () => {
    render(
      <ConversationsTable
        conversations={[makeRow({ id: "t1", title: "Mi conversación" })]}
        onArchiveToggle={noop}
        onRename={noop}
      />
    );
    expect(screen.getByText("Mi conversación")).toBeInTheDocument();
  });

  it("falls back to first_user_prompt when title is null", () => {
    render(
      <ConversationsTable
        conversations={[
          makeRow({
            id: "t2",
            title: null,
            first_user_prompt: "¿Cuánto vendimos ayer?",
          }),
        ]}
        onArchiveToggle={noop}
        onRename={noop}
      />
    );
    expect(screen.getByText("¿Cuánto vendimos ayer?")).toBeInTheDocument();
  });

  it("clicking title cell navigates to /conversations/<id>", () => {
    const row = makeRow({ id: "nav-title-1", title: "Navegar al hacer clic" });
    render(
      <ConversationsTable
        conversations={[row]}
        onArchiveToggle={noop}
        onRename={noop}
      />
    );
    fireEvent.click(screen.getByTestId(`title-cell-${row.id}`));
    expect(mockPush).toHaveBeenCalledWith(`/conversations/${row.id}`);
  });

  it("shows bulk action bar when rows are selected", () => {
    render(
      <ConversationsTable
        conversations={MOCK_ROWS.slice(0, 3)}
        onArchiveToggle={noop}
        onRename={noop}
      />
    );
    expect(screen.queryByTestId("bulk-action-bar")).toBeNull();

    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[1]); // index 0 is select-all
    expect(screen.getByTestId("bulk-action-bar")).toBeInTheDocument();
  });

  it("bulk archive calls onArchiveToggle for all selected active rows", () => {
    const onArchiveToggle = vi.fn();
    const rows = [
      makeRow({ id: "b1", archived_at: null }),
      makeRow({ id: "b2", archived_at: null }),
    ];
    render(
      <ConversationsTable
        conversations={rows}
        onArchiveToggle={onArchiveToggle}
        onRename={noop}
      />
    );

    fireEvent.click(screen.getByTestId("select-all-checkbox"));
    fireEvent.click(screen.getByTestId("bulk-archive-btn"));

    expect(onArchiveToggle).toHaveBeenCalledTimes(2);
    expect(onArchiveToggle).toHaveBeenCalledWith("b1", false);
    expect(onArchiveToggle).toHaveBeenCalledWith("b2", false);
  });

  it("sort by 'Última actividad' changes sort state", () => {
    render(
      <ConversationsTable
        conversations={MOCK_ROWS}
        onArchiveToggle={noop}
        onRename={noop}
      />
    );
    const sortBtn = screen.getByRole("button", { name: /Ordenar por Última actividad/ });
    fireEvent.click(sortBtn);
    fireEvent.click(sortBtn);
    expect(sortBtn).toBeInTheDocument();
  });

  it("inline rename: pencil button opens rename input", () => {
    const row = makeRow({ id: "rename1", title: "Título original" });
    render(
      <ConversationsTable
        conversations={[row]}
        onArchiveToggle={noop}
        onRename={noop}
      />
    );
    const pencilBtn = screen.getByTestId(`rename-btn-${row.id}`);
    fireEvent.click(pencilBtn);
    const input = screen.getByTestId(`rename-input-${row.id}`);
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue("Título original");
  });

  it("inline rename: pressing Enter commits rename", () => {
    const onRename = vi.fn();
    const row = makeRow({ id: "rename2", title: "Viejo título" });
    render(
      <ConversationsTable
        conversations={[row]}
        onArchiveToggle={noop}
        onRename={onRename}
      />
    );
    fireEvent.click(screen.getByTestId(`rename-btn-${row.id}`));
    const input = screen.getByTestId(`rename-input-${row.id}`);
    fireEvent.change(input, { target: { value: "Nuevo título" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("rename2", "Nuevo título");
  });

  it("inline rename: pressing Escape cancels rename without calling onRename", () => {
    const onRename = vi.fn();
    const row = makeRow({ id: "rename3", title: "Título escape" });
    render(
      <ConversationsTable
        conversations={[row]}
        onArchiveToggle={noop}
        onRename={onRename}
      />
    );
    fireEvent.click(screen.getByTestId(`rename-btn-${row.id}`));
    const input = screen.getByTestId(`rename-input-${row.id}`);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByTestId(`title-cell-${row.id}`)).toBeInTheDocument();
  });

  it("inline rename: blur with empty value does not call onRename", () => {
    const onRename = vi.fn();
    const row = makeRow({ id: "rename4", title: "Título blur" });
    render(
      <ConversationsTable
        conversations={[row]}
        onArchiveToggle={noop}
        onRename={onRename}
      />
    );
    fireEvent.click(screen.getByTestId(`rename-btn-${row.id}`));
    const input = screen.getByTestId(`rename-input-${row.id}`);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onRename).not.toHaveBeenCalled();
  });

  it("bulk unarchive calls onArchiveToggle for all selected archived rows", () => {
    const onArchiveToggle = vi.fn();
    const archivedAt = new Date().toISOString();
    const rows = [
      makeRow({ id: "u1", archived_at: archivedAt }),
      makeRow({ id: "u2", archived_at: archivedAt }),
    ];
    render(
      <ConversationsTable
        conversations={rows}
        onArchiveToggle={onArchiveToggle}
        onRename={noop}
      />
    );
    fireEvent.click(screen.getByTestId("select-all-checkbox"));
    fireEvent.click(screen.getByTestId("bulk-unarchive-btn"));

    expect(onArchiveToggle).toHaveBeenCalledTimes(2);
    expect(onArchiveToggle).toHaveBeenCalledWith("u1", true);
    expect(onArchiveToggle).toHaveBeenCalledWith("u2", true);
  });

  it("deselecting a row via its checkbox removes it from selection", () => {
    render(
      <ConversationsTable
        conversations={MOCK_ROWS.slice(0, 2)}
        onArchiveToggle={noop}
        onRename={noop}
      />
    );
    const rowCheckboxes = screen.getAllByRole("checkbox");
    fireEvent.click(rowCheckboxes[1]);
    expect(screen.getByTestId("bulk-action-bar")).toBeInTheDocument();
    fireEvent.click(rowCheckboxes[1]);
    expect(screen.queryByTestId("bulk-action-bar")).toBeNull();
  });

  it("bulk cancel button clears selection", () => {
    render(
      <ConversationsTable
        conversations={MOCK_ROWS.slice(0, 2)}
        onArchiveToggle={noop}
        onRename={noop}
      />
    );
    fireEvent.click(screen.getByTestId("select-all-checkbox"));
    expect(screen.getByTestId("bulk-action-bar")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Cancelar"));
    expect(screen.queryByTestId("bulk-action-bar")).toBeNull();
  });

  it("sort by Creada column toggles direction", () => {
    render(
      <ConversationsTable
        conversations={MOCK_ROWS}
        onArchiveToggle={noop}
        onRename={noop}
      />
    );
    const sortBtn = screen.getByRole("button", { name: /Ordenar por Creada/ });
    fireEvent.click(sortBtn);
    fireEvent.click(sortBtn);
    expect(sortBtn).toBeInTheDocument();
  });

  describe("Contexto column", () => {
    it("renders a link for dashboard context with a known name", () => {
      const row = makeRow({
        id: "ctx-dash-named",
        context_kind: "dashboard",
        context_ref: "42",
        context_dashboard_name: "Ventas",
      });
      render(
        <ConversationsTable
          conversations={[row]}
          onArchiveToggle={noop}
          onRename={noop}
        />
      );
      const link = screen.getByTestId("context-link-ctx-dash-named");
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute("href", "/dashboard/42");
      expect(link).toHaveTextContent("Ventas");
    });

    it("renders 'Dashboard #N (eliminado)' without a link when context_dashboard_name is null", () => {
      const row = makeRow({
        id: "ctx-dash-deleted",
        context_kind: "dashboard",
        context_ref: "42",
        context_dashboard_name: null,
      });
      render(
        <ConversationsTable
          conversations={[row]}
          onArchiveToggle={noop}
          onRename={noop}
        />
      );
      const cell = screen.getByTestId("context-cell-ctx-dash-deleted");
      expect(cell).toHaveTextContent("Dashboard #42 (eliminado)");
      expect(within(cell).queryByRole("link")).toBeNull();
    });

    it("renders 'Libre' for global context_kind", () => {
      const row = makeRow({
        id: "ctx-global",
        context_kind: "global",
        context_ref: null,
      });
      render(
        <ConversationsTable
          conversations={[row]}
          onArchiveToggle={noop}
          onRename={noop}
        />
      );
      const cell = screen.getByTestId("context-cell-ctx-global");
      expect(cell).toHaveTextContent("Libre");
      expect(within(cell).queryByRole("link")).toBeNull();
    });

    it("renders 'Libre' when context_kind is null", () => {
      const row = makeRow({
        id: "ctx-null",
        context_kind: null,
        context_ref: null,
      });
      render(
        <ConversationsTable
          conversations={[row]}
          onArchiveToggle={noop}
          onRename={noop}
        />
      );
      const cell = screen.getByTestId("context-cell-ctx-null");
      expect(cell).toHaveTextContent("Libre");
    });

    it("renders 'Inicio' for home context_kind", () => {
      const row = makeRow({
        id: "ctx-home",
        context_kind: "home",
        context_ref: null,
      });
      render(
        <ConversationsTable
          conversations={[row]}
          onArchiveToggle={noop}
          onRename={noop}
        />
      );
      const cell = screen.getByTestId("context-cell-ctx-home");
      expect(cell).toHaveTextContent("Inicio");
    });

    it("renders 'Admin' for admin context_kind", () => {
      const row = makeRow({
        id: "ctx-admin",
        context_kind: "admin",
        context_ref: null,
      });
      render(
        <ConversationsTable
          conversations={[row]}
          onArchiveToggle={noop}
          onRename={noop}
        />
      );
      const cell = screen.getByTestId("context-cell-ctx-admin");
      expect(cell).toHaveTextContent("Admin");
    });
  });

  describe("Rename prefill uses getConversationDisplayTitle", () => {
    it("prefills with first_user_prompt when title is null", () => {
      const row = makeRow({
        id: "prefill-null-title",
        title: null,
        first_user_prompt: "¿Cuánto vendimos?",
      });
      render(
        <ConversationsTable
          conversations={[row]}
          onArchiveToggle={noop}
          onRename={noop}
        />
      );
      fireEvent.click(screen.getByTestId("rename-btn-prefill-null-title"));
      const input = screen.getByTestId("rename-input-prefill-null-title");
      expect(input).toHaveValue("¿Cuánto vendimos?");
    });

    it("prefills with title when title is set", () => {
      const row = makeRow({
        id: "prefill-with-title",
        title: "Mi panel",
        first_user_prompt: "¿Cuánto vendimos?",
      });
      render(
        <ConversationsTable
          conversations={[row]}
          onArchiveToggle={noop}
          onRename={noop}
        />
      );
      fireEvent.click(screen.getByTestId("rename-btn-prefill-with-title"));
      const input = screen.getByTestId("rename-input-prefill-with-title");
      expect(input).toHaveValue("Mi panel");
    });

    it("prefills with truncated first_user_prompt (60 chars) when title is null and prompt is long", () => {
      const longPrompt = "A".repeat(70);
      const row = makeRow({
        id: "prefill-long-prompt",
        title: null,
        first_user_prompt: longPrompt,
      });
      render(
        <ConversationsTable
          conversations={[row]}
          onArchiveToggle={noop}
          onRename={noop}
        />
      );
      fireEvent.click(screen.getByTestId("rename-btn-prefill-long-prompt"));
      const input = screen.getByTestId("rename-input-prefill-long-prompt");
      expect(input).toHaveValue("A".repeat(60));
    });
  });

  it("select-all deselects all rows when all are already selected", () => {
    const rows = MOCK_ROWS.slice(0, 2);
    render(
      <ConversationsTable
        conversations={rows}
        onArchiveToggle={noop}
        onRename={noop}
      />
    );
    fireEvent.click(screen.getByTestId("select-all-checkbox"));
    expect(screen.getByTestId("bulk-action-bar")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("select-all-checkbox"));
    expect(screen.queryByTestId("bulk-action-bar")).toBeNull();
  });
});
