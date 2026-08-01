// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MessageBubble } from "../MessageBubble";
import type { ChatMessage } from "../types";
import type { ApiErrorResponse } from "@/lib/errors";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const userMessage: ChatMessage = {
  role: "user",
  content: "Hola, ¿qué tabla tiene más ventas?",
  timestamp: new Date("2026-05-01T10:00:00Z"),
};

const assistantMessage: ChatMessage = {
  role: "assistant",
  content: "La tabla con más ventas es **ps_ventas**.",
  timestamp: new Date("2026-05-01T10:00:05Z"),
};

const errorMessage: ChatMessage = {
  role: "assistant",
  content: "Error al procesar la solicitud",
  timestamp: new Date("2026-05-01T10:00:10Z"),
  isError: true,
};

const errorMessageWithDetail: ChatMessage = {
  role: "assistant",
  content: "No se pudo conectar",
  timestamp: new Date("2026-05-01T10:00:15Z"),
  isError: true,
  errorDetail: {
    error: "No se pudo conectar",
    code: "UNKNOWN",
    details: "Connection refused",
    timestamp: "2026-05-01T10:00:15.000Z",
    requestId: "req_test_001",
  } satisfies ApiErrorResponse,
};

const assistantWithAppliedChip: ChatMessage = {
  role: "assistant",
  content: "Dashboard actualizado correctamente.",
  timestamp: new Date("2026-05-01T10:00:20Z"),
  appliedSummary: "Se añadió el widget de ventas",
  appliedChipLabel: "Cambios aplicados",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MessageBubble", () => {
  describe("user message", () => {
    it("renders user message content", () => {
      render(<MessageBubble msg={userMessage} />);
      expect(
        screen.getByText("Hola, ¿qué tabla tiene más ventas?"),
      ).toBeInTheDocument();
    });

    it("aligns user message to the right", () => {
      const { container } = render(<MessageBubble msg={userMessage} />);
      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper.style.alignItems).toBe("flex-end");
    });

    it("does not show log block for user messages", () => {
      const msgWithLogs: ChatMessage = {
        ...userMessage,
        logs: [{ kind: "tool", timestamp: "+0.1s", label: "list_ps_tables" }],
      };
      render(<MessageBubble msg={msgWithLogs} />);
      // Log block should not appear for user messages
      expect(screen.queryByTestId("logblock-collapsed")).not.toBeInTheDocument();
      expect(screen.queryByTestId("logblock-lines")).not.toBeInTheDocument();
      expect(screen.queryByTestId("logblock-streaming")).not.toBeInTheDocument();
    });
  });

  describe("assistant message", () => {
    it("renders assistant message content", () => {
      render(<MessageBubble msg={assistantMessage} />);
      // Markdown renders ** as bold so content might be split
      expect(screen.getByText(/ps_ventas/)).toBeInTheDocument();
    });

    it("aligns assistant message to the left", () => {
      const { container } = render(<MessageBubble msg={assistantMessage} />);
      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper.style.alignItems).toBe("flex-start");
    });

    it("renders plain text when isMarkdown is false", () => {
      const plainMsg: ChatMessage = {
        ...assistantMessage,
        content: "Texto plano sin formato",
      };
      render(<MessageBubble msg={plainMsg} isMarkdown={false} />);
      expect(screen.getByText("Texto plano sin formato")).toBeInTheDocument();
    });

    it("renders applied chip when appliedSummary is set", () => {
      render(<MessageBubble msg={assistantWithAppliedChip} />);
      const chip = screen.getByTestId("applied-chip");
      expect(chip).toBeInTheDocument();
      expect(chip).toHaveTextContent("Cambios aplicados");
    });

    it("does not render applied chip when appliedSummary is absent", () => {
      render(<MessageBubble msg={assistantMessage} />);
      expect(screen.queryByTestId("applied-chip")).not.toBeInTheDocument();
    });
  });

  describe("error state", () => {
    it("renders error message content", () => {
      render(<MessageBubble msg={errorMessage} />);
      expect(
        screen.getByText("Error al procesar la solicitud"),
      ).toBeInTheDocument();
    });

    it("renders error message in a visually distinct container", () => {
      const { container } = render(<MessageBubble msg={errorMessage} />);
      // The error content renders inside the ErrorBubble (red text class)
      const errorText = container.querySelector(".text-red-400");
      expect(errorText).toBeInTheDocument();
    });

    it("shows expand button when errorDetail is present", () => {
      render(<MessageBubble msg={errorMessageWithDetail} />);
      expect(
        screen.getByTestId("chat-toggle-details"),
      ).toBeInTheDocument();
    });

    it("does not show expand button when errorDetail is absent", () => {
      render(<MessageBubble msg={errorMessage} />);
      expect(
        screen.queryByTestId("chat-toggle-details"),
      ).not.toBeInTheDocument();
    });

    it("expands error details when toggle button is clicked", () => {
      render(<MessageBubble msg={errorMessageWithDetail} />);
      const toggle = screen.getByTestId("chat-toggle-details");
      expect(screen.queryByTestId("chat-error-details")).not.toBeInTheDocument();
      fireEvent.click(toggle);
      expect(screen.getByTestId("chat-error-details")).toBeInTheDocument();
    });

    it("does not render applied chip for error messages", () => {
      const errorWithSummary: ChatMessage = {
        ...errorMessage,
        appliedSummary: "This should not show",
      };
      render(<MessageBubble msg={errorWithSummary} />);
      expect(screen.queryByTestId("applied-chip")).not.toBeInTheDocument();
    });
  });

  describe("log block", () => {
    it("renders log block when assistant message has logs", () => {
      const msgWithLogs: ChatMessage = {
        ...assistantMessage,
        logs: [{ kind: "tool", timestamp: "+0.1s", label: "Tool: list_ps_tables" }],
      };
      const { container } = render(
        <MessageBubble
          msg={msgWithLogs}
          logExpanded={false}
          onLogToggle={vi.fn()}
        />,
      );
      // LogBlock renders within the bubble for non-user messages with logs
      expect(container.querySelector("[data-testid]")).toBeTruthy();
    });
  });
});
