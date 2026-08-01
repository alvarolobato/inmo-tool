// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ConversationRowActions } from "../ConversationRowActions";
import type { ConversationRow } from "@/app/conversations/types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE: ConversationRow = {
  id: "conv-abc123",
  title: "Test conversation",
  first_user_prompt: "¿Cuánto vendimos?",
  mode: "analyze",
  context_url: "/paneles/5",
  context_kind: "dashboard",
  context_ref: "5",
  last_interaction_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  archived_at: null,
  last_status: "ok",
  llm_provider: "openrouter",
  llm_driver: null,
  message_count: 4,
  tool_calls_count: 2,
  rounds_count: 1,
  duration_seconds: 90,
  last_message_preview: "Las ventas fueron 12.000€",
  token_total: 5000,
  last_read_at: null,
  is_unread: false,
};

function makeConv(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return { ...BASE, ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConversationRowActions", () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it("renders only Continuar and Abrir en contexto buttons", () => {
    render(
      <ConversationRowActions
        conversation={makeConv()}
      />
    );
    expect(screen.getByLabelText("Continuar")).toBeInTheDocument();
    expect(screen.getByLabelText("Abrir en contexto")).toBeInTheDocument();
    // Removed buttons must not be present
    expect(screen.queryByLabelText("Archivar")).toBeNull();
    expect(screen.queryByLabelText("Renombrar")).toBeNull();
    expect(screen.queryByLabelText("Copiar enlace")).toBeNull();
    expect(screen.queryByLabelText("Copiar enlace en contexto")).toBeNull();
  });

  it("clicking Continuar navigates to /c/<id>", () => {
    render(
      <ConversationRowActions
        conversation={makeConv({ id: "nav-id-001" })}
      />
    );
    fireEvent.click(screen.getByLabelText("Continuar"));
    expect(mockPush).toHaveBeenCalledWith("/c/nav-id-001");
  });

  it("clicking Abrir en contexto navigates to /k/<id> for non-global context", () => {
    render(
      <ConversationRowActions
        conversation={makeConv({ id: "ctx-id-002", context_kind: "dashboard" })}
      />
    );
    fireEvent.click(screen.getByLabelText("Abrir en contexto"));
    expect(mockPush).toHaveBeenCalledWith("/k/ctx-id-002");
  });

  it("renders disabled context button for global conversations", () => {
    render(
      <ConversationRowActions
        conversation={makeConv({ context_kind: "global" })}
      />
    );
    const btn = screen.getByLabelText("Abrir en contexto (no disponible)");
    expect(btn).toBeDisabled();
  });

  it.each([["Continuar"], ["Abrir en contexto"]])(
    "mouseenter/mouseleave on %s button does not throw",
    (label) => {
      render(
        <ConversationRowActions
          conversation={makeConv()}
          />
      );
      const btn = screen.getByLabelText(label);
      expect(() => {
        fireEvent.mouseEnter(btn);
        fireEvent.mouseLeave(btn);
      }).not.toThrow();
    }
  );

  it("clicks inside the actions container do not bubble to a parent click handler", () => {
    const parentClick = vi.fn();
    render(
      <div role="row" onClick={parentClick}>
        <ConversationRowActions
          conversation={makeConv()}
          />
      </div>
    );
    fireEvent.click(screen.getByLabelText("Continuar"));
    expect(parentClick).not.toHaveBeenCalled();
  });
});
