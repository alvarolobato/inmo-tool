// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { InitialContextPanel } from "../InitialContextPanel";
import type { InitialContext } from "@/lib/conversation-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<InitialContext> = {}): InitialContext {
  return {
    model: "claude-sonnet-4-6",
    provider: "cli",
    ...overrides,
  };
}

function openPanel() {
  const toggle = screen.getByTestId("initial-context-toggle");
  fireEvent.click(toggle);
}

// ---------------------------------------------------------------------------
// EC-4 — PromptBlock unescapes JSON
// ---------------------------------------------------------------------------

describe("InitialContextPanel", () => {
  it("PromptBlock unescapes JSON (EC-4)", () => {
    // String.raw preserves the literal backslashes so the runtime value is
    // {\"widget\":\"foo\",\"value\":42} — invalid JSON until backslashes are stripped.
    const escaped = String.raw`{\"widget\":\"foo\",\"value\":42}`;
    const ctx = makeContext({ system_prompt_stable: escaped });
    render(<InitialContextPanel context={ctx} />);
    openPanel();

    // The pre element should show unescaped, pretty-printed JSON
    const pre = screen.getByText((content) => content.includes('"widget"'));
    expect(pre).toBeInTheDocument();
    expect(pre.textContent).toContain('"widget"');
    expect(pre.textContent).not.toContain('\\"widget\\"');
  });

  it("PromptBlock renders plain text unchanged (EC-4 guard)", () => {
    const plain = "You are an assistant. Help the user.";
    const ctx = makeContext({ system_prompt_stable: plain });
    render(<InitialContextPanel context={ctx} />);
    openPanel();
    expect(screen.getByText(plain)).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // EC-5 — Model name displayed correctly
  // ---------------------------------------------------------------------------

  it("context panel displays resolved model name (EC-5)", () => {
    const ctx = makeContext({ model: "claude-sonnet-4-6", provider: "cli" });
    render(<InitialContextPanel context={ctx} />);
    openPanel();
    expect(screen.getByText(/claude-sonnet-4-6/)).toBeInTheDocument();
  });

  it("shows CLI provider label when provider is cli (EC-5)", () => {
    const ctx = makeContext({ model: "claude-sonnet-4-6", provider: "cli", driver: "claude_code" });
    render(<InitialContextPanel context={ctx} />);
    openPanel();
    expect(screen.getByText(/Claude CLI/)).toBeInTheDocument();
  });

  it("shows OpenRouter label when provider is openrouter (EC-5)", () => {
    const ctx = makeContext({ model: "anthropic/claude-sonnet-4", provider: "openrouter" });
    render(<InitialContextPanel context={ctx} />);
    openPanel();
    expect(screen.getByText(/OpenRouter/)).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // EC-6 — ToolEntry renders full schema when expanded
  // ---------------------------------------------------------------------------

  it("ToolEntry renders full schema when expanded (EC-6)", () => {
    const ctx = makeContext({
      tools: [
        {
          name: "execute_query",
          schema: {
            name: "execute_query",
            description: "Run a read-only SQL query",
            parameters: {
              type: "object",
              properties: { sql: { type: "string" } },
            },
          },
        },
      ],
    });
    render(<InitialContextPanel context={ctx} />);
    openPanel();

    // The tool name should be visible
    expect(screen.getByText("execute_query")).toBeInTheDocument();

    // Expand the tool entry
    const toolBtn = screen.getByRole("button", { name: /execute_query/ });
    fireEvent.click(toolBtn);

    // Schema JSON should be visible
    expect(screen.getByText(/Run a read-only SQL query/)).toBeInTheDocument();
  });

  it("shows tool count in header (EC-6)", () => {
    const ctx = makeContext({
      tools: [
        { name: "tool_a", schema: { name: "tool_a" } },
        { name: "tool_b", schema: { name: "tool_b" } },
      ],
    });
    render(<InitialContextPanel context={ctx} />);
    openPanel();
    expect(screen.getByText(/2/)).toBeInTheDocument();
    expect(screen.getByText(/Herramientas disponibles/)).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // EC-7 — prior_messages_history rendered as collapsible history
  // ---------------------------------------------------------------------------

  it("renders prior_messages_history as collapsible history (EC-7)", () => {
    const ctx = makeContext({
      prior_messages: 3,
      prior_messages_history: [
        { role: "user", content: "Hola, muéstrame ventas" },
        { role: "assistant", content: "Aquí tienes las ventas del mes" },
        { role: "user", content: "¿Y del año anterior?" },
      ],
    });
    render(<InitialContextPanel context={ctx} />);
    openPanel();

    // Collapsible button shows count
    expect(screen.getByText(/Historial de la conversación \(3 mensajes\)/)).toBeInTheDocument();

    // Expand the history section
    const histBtn = screen.getByText(/Historial de la conversación \(3 mensajes\)/);
    fireEvent.click(histBtn);

    // History preview items should be visible
    expect(screen.getByTestId("history-preview")).toBeInTheDocument();
    expect(screen.getByText(/Hola, muéstrame ventas/)).toBeInTheDocument();
    expect(screen.getByText(/Aquí tienes las ventas del mes/)).toBeInTheDocument();
  });

  it("does not render history section when prior_messages_history is absent (EC-7)", () => {
    const ctx = makeContext({ prior_messages: 5 });
    render(<InitialContextPanel context={ctx} />);
    openPanel();
    expect(screen.queryByTestId("history-preview")).not.toBeInTheDocument();
    expect(screen.queryByText(/Historial de la conversación/)).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // EC-8 — context panel renders all LLM-relevant fields
  // ---------------------------------------------------------------------------

  it("context panel renders all LLM fields when provided (EC-8)", () => {
    const ctx = makeContext({
      model: "claude-sonnet-4-6",
      provider: "cli",
      driver: "claude_code",
      prior_messages: 2,
      prior_messages_history: [
        { role: "user", content: "prev message" },
        { role: "assistant", content: "prev response" },
      ],
      system_prompt_stable: "You are a helpful assistant.",
      system_prompt_volatile: "Today is Monday.",
      tools: [
        { name: "execute_query", schema: { name: "execute_query", description: "run sql" } },
      ],
      config: { flow: "chat", tool_rounds_max: 5 },
    });
    render(<InitialContextPanel context={ctx} />);
    openPanel();

    // Model / provider
    expect(screen.getByText(/claude-sonnet-4-6/)).toBeInTheDocument();

    // Prior message count (may appear in both FieldRow and history header)
    const msgCountEls = screen.getAllByText(/2 mensajes/);
    expect(msgCountEls.length).toBeGreaterThanOrEqual(1);

    // System prompts visible
    expect(screen.getByText("You are a helpful assistant.")).toBeInTheDocument();
    expect(screen.getByText("Today is Monday.")).toBeInTheDocument();

    // Tools section
    expect(screen.getByText(/Herramientas disponibles/)).toBeInTheDocument();
    expect(screen.getByText("execute_query")).toBeInTheDocument();

    // Config
    expect(screen.getByText(/tool_rounds_max/)).toBeInTheDocument();
  });
});
