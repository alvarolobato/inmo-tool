// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ConversationPane } from "../ConversationPane";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStreamFetch(): Promise<Response> {
  // An immediately-closed stream so the SSE reader exits cleanly.
  const stream = new ReadableStream({ start(ctrl) { ctrl.close(); } });
  return Promise.resolve({ ok: true, body: stream } as unknown as Response);
}

function makeConvFetch(id: string, messages: unknown[] = []): Promise<Response> {
  const conv = { id, mode: "chat", title: null, messages };
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(conv),
  } as unknown as Response);
}

function stubFetch(convId: string, messages: unknown[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      const u = url as string;
      if (u.includes("/stream")) return makeStreamFetch();
      if (u.includes("/api/conversations") && !opts?.method) {
        return makeConvFetch(convId, messages);
      }
      return Promise.resolve({ ok: false, body: null } as unknown as Response);
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConversationPane", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the conversation-pane container", () => {
    render(<ConversationPane conversationId={null} mode="standalone" />);
    expect(screen.getByTestId("conversation-pane")).toBeInTheDocument();
  });

  it("shows empty-state prompt when no conversationId", () => {
    render(<ConversationPane conversationId={null} mode="standalone" />);
    expect(screen.getByText("Escribe tu primer mensaje.")).toBeInTheDocument();
  });

  it("renders the message textarea with placeholder", () => {
    render(<ConversationPane conversationId={null} mode="standalone" />);
    expect(screen.getByPlaceholderText("Escribe un mensaje…")).toBeInTheDocument();
  });

  it("renders in panel mode without crashing", () => {
    render(<ConversationPane conversationId={null} mode="panel" />);
    expect(screen.getByTestId("conversation-pane")).toBeInTheDocument();
  });

  it("shows continue-prompt after loading an empty conversation", async () => {
    stubFetch("conv-1");
    render(<ConversationPane conversationId="conv-1" mode="standalone" />);
    await waitFor(() =>
      expect(
        screen.getByText("Escribe un mensaje para continuar."),
      ).toBeInTheDocument(),
    );
  });

  it("renders user bubble from loaded messages", async () => {
    stubFetch("conv-1", [
      {
        id: "m1",
        conversation_id: "conv-1",
        role: "user",
        content: "Hola",
        created_at: new Date().toISOString(),
      },
    ]);
    render(<ConversationPane conversationId="conv-1" mode="standalone" />);
    await waitFor(() => {
      expect(screen.getByTestId("user-bubble")).toBeInTheDocument();
      expect(screen.getByText("Hola")).toBeInTheDocument();
    });
  });

  it("renders assistant bubble from loaded messages", async () => {
    stubFetch("conv-1", [
      {
        id: "m1",
        conversation_id: "conv-1",
        role: "assistant",
        content: { text: "¡Claro que sí!" },
        created_at: new Date().toISOString(),
      },
    ]);
    render(<ConversationPane conversationId="conv-1" mode="standalone" />);
    await waitFor(() => {
      expect(screen.getByTestId("assistant-bubble")).toBeInTheDocument();
      expect(screen.getByText("¡Claro que sí!")).toBeInTheDocument();
    });
  });

  it("renders pre-turn conversations (no turn_events) from conversation_messages", async () => {
    // Verifies the graceful fallback for conversations created before the turn tables.
    // The SSE stream is empty (no turn data), so messages render without context panels.
    stubFetch("conv-preturn", [
      {
        id: "pre-u1",
        conversation_id: "conv-preturn",
        role: "user",
        content: { text: "Pregunta antigua" },
        created_at: new Date().toISOString(),
      },
      {
        id: "pre-a1",
        conversation_id: "conv-preturn",
        role: "assistant",
        content: { text: "Respuesta antigua" },
        created_at: new Date().toISOString(),
      },
    ]);
    render(<ConversationPane conversationId="conv-preturn" mode="standalone" />);
    await waitFor(() => {
      expect(screen.getByText("Pregunta antigua")).toBeInTheDocument();
      expect(screen.getByText("Respuesta antigua")).toBeInTheDocument();
      // No context panel since there are no turns
      expect(screen.queryByTestId("context-panel")).not.toBeInTheDocument();
    });
  });

  it("skips tool-role messages in rendered output", async () => {
    stubFetch("conv-1", [
      {
        id: "t1",
        conversation_id: "conv-1",
        role: "tool",
        content: { tool_call_id: "tc1", tool_name: "search", content: "hidden" },
        created_at: new Date().toISOString(),
      },
      {
        id: "m2",
        conversation_id: "conv-1",
        role: "user",
        content: "Visible",
        created_at: new Date().toISOString(),
      },
    ]);
    render(<ConversationPane conversationId="conv-1" mode="standalone" />);
    await waitFor(() => {
      expect(screen.getByText("Visible")).toBeInTheDocument();
      expect(screen.queryByText("hidden")).not.toBeInTheDocument();
    });
  });

  it("prefills textarea from prefillText prop", () => {
    render(
      <ConversationPane
        conversationId={null}
        mode="standalone"
        prefillText="Hola mundo"
        prefillId={1}
      />,
    );
    const textarea = screen.getByPlaceholderText(
      "Escribe un mensaje…",
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe("Hola mundo");
  });

  it("calls onConversationCreated when a new conversation is created", async () => {
    const onCreated = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        const u = url as string;
        if (u.includes("/stream")) return makeStreamFetch();
        if (opts?.method === "POST" && u === "/api/conversations") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ id: "new-conv" }),
          } as unknown as Response);
        }
        if (opts?.method === "POST" && u.includes("/turns")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ turnId: "turn-1" }),
          } as unknown as Response);
        }
        return makeConvFetch("new-conv");
      }),
    );

    render(
      <ConversationPane
        conversationId={null}
        mode="standalone"
        newConversationConfig={{ conversationMode: "chat", contextKind: "global" }}
        onConversationCreated={onCreated}
      />,
    );

    const textarea = screen.getByPlaceholderText("Escribe un mensaje…");
    fireEvent.change(textarea, { target: { value: "Hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith("new-conv");
    });
  });

  it("shows send error message when turn POST fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        const u = url as string;
        if (u.includes("/stream")) return makeStreamFetch();
        if (opts?.method === "POST" && u.includes("/turns")) {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ error: "Error de red" }),
          } as unknown as Response);
        }
        return makeConvFetch("conv-x");
      }),
    );

    render(<ConversationPane conversationId="conv-x" mode="standalone" />);
    await waitFor(() =>
      expect(
        screen.getByText("Escribe un mensaje para continuar."),
      ).toBeInTheDocument(),
    );

    const textarea = screen.getByPlaceholderText("Escribe un mensaje…");
    fireEvent.change(textarea, { target: { value: "Test" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByText("Error de red")).toBeInTheDocument();
    });
  });

  it("shows network error when fetch throws during send", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        const u = url as string;
        if (u.includes("/stream")) return makeStreamFetch();
        if (opts?.method === "POST" && u.includes("/turns")) {
          return Promise.reject(new Error("network failure"));
        }
        return makeConvFetch("conv-x");
      }),
    );

    render(<ConversationPane conversationId="conv-x" mode="standalone" />);
    await waitFor(() =>
      expect(
        screen.getByText("Escribe un mensaje para continuar."),
      ).toBeInTheDocument(),
    );

    const textarea = screen.getByPlaceholderText("Escribe un mensaje…");
    fireEvent.change(textarea, { target: { value: "Test" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(
        screen.getByText("No se pudo conectar con el servidor."),
      ).toBeInTheDocument();
    });
  });

  it("shows no-active-conversation error when sending without newConversationConfig", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if ((url as string).includes("/stream")) return makeStreamFetch();
        return makeConvFetch("conv-x");
      }),
    );

    render(
      <ConversationPane
        conversationId={null}
        mode="standalone"
        // No newConversationConfig — send should surface an error
      />,
    );

    const textarea = screen.getByPlaceholderText("Escribe un mensaje…");
    fireEvent.change(textarea, { target: { value: "Test" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(
        screen.getByText("No se puede enviar sin una conversación activa."),
      ).toBeInTheDocument();
    });
  });

  it("calls onProcessingChange(true) when a turn starts", async () => {
    const onProcessingChange = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        const u = url as string;
        if (u.includes("/stream")) return makeStreamFetch();
        if (opts?.method === "POST" && u.includes("/turns")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ turnId: "turn-1" }),
          } as unknown as Response);
        }
        return makeConvFetch("conv-y");
      }),
    );

    render(
      <ConversationPane
        conversationId="conv-y"
        mode="standalone"
        onProcessingChange={onProcessingChange}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByText("Escribe un mensaje para continuar."),
      ).toBeInTheDocument(),
    );

    const textarea = screen.getByPlaceholderText("Escribe un mensaje…");
    fireEvent.change(textarea, { target: { value: "Hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(onProcessingChange).toHaveBeenCalledWith(true);
    });
  });

  it("thinking block persists after turn completes", async () => {
    const encoder = new TextEncoder();
    const convId = "conv-thinking";
    const turnId = "turn-1";
    const thinkingContent = "some extended thought";

    const conv = {
      id: convId,
      mode: "chat",
      title: null,
      active_turn_id: turnId,
      messages: [
        {
          id: "m1",
          conversation_id: convId,
          role: "assistant",
          content: { text: "Mi respuesta" },
          created_at: new Date().toISOString(),
        },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const u = url as string;
        if (u.includes("/stream")) {
          // Stream emits a thinking event immediately, then a complete event after a
          // macrotask delay — giving React time to flush the thinkingTextRef sync effect
          // between the two events (this is the condition the bug fix must satisfy).
          let ctrl!: ReadableStreamDefaultController<Uint8Array>;
          const stream = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
          ctrl.enqueue(encoder.encode(
            `id: 1\ndata: ${JSON.stringify({ turnId, eventType: "thinking", payload: { text: thinkingContent } })}\n\n`,
          ));
          setTimeout(() => {
            ctrl.enqueue(encoder.encode(
              `id: 2\ndata: ${JSON.stringify({ turnId, eventType: "complete", payload: { messageId: "m1" } })}\n\n`,
            ));
            ctrl.close();
          }, 20);
          return Promise.resolve({ ok: true, body: stream } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(conv),
        } as unknown as Response);
      }),
    );

    render(<ConversationPane conversationId={convId} mode="standalone" />);

    await waitFor(
      () => expect(screen.getByTestId("thinking-block")).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it("ThinkingBlock auto-scrolls to bottom on content change", async () => {
    const encoder = new TextEncoder();
    const convId = "conv-autoscroll";
    const turnId = "turn-scroll";
    // active_turn_id causes the component to set pendingTurnId, enabling SSE event processing
    const conv = { id: convId, mode: "chat", title: null, active_turn_id: turnId, messages: [] };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const u = url as string;
        if (u.includes("/stream")) {
          let ctrl!: ReadableStreamDefaultController<Uint8Array>;
          const stream = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
          ctrl.enqueue(encoder.encode(
            `id: 1\ndata: ${JSON.stringify({ turnId, eventType: "thinking", payload: { text: "first thought" } })}\n\n`,
          ));
          setTimeout(() => {
            ctrl.enqueue(encoder.encode(
              `id: 2\ndata: ${JSON.stringify({ turnId, eventType: "thinking", payload: { text: "first thought\nsecond thought\nthird thought" } })}\n\n`,
            ));
            ctrl.close();
          }, 10);
          return Promise.resolve({ ok: true, body: stream } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(conv),
        } as unknown as Response);
      }),
    );

    render(<ConversationPane conversationId={convId} mode="standalone" />);

    // thinking-scroll renders inside ThinkingBlock when open=true (set by streaming=true)
    await waitFor(
      () => expect(screen.getByTestId("thinking-scroll")).toBeInTheDocument(),
      { timeout: 4000 },
    );

    // Spy on the scrollTop setter to verify the useEffect sets it to scrollHeight.
    // The second SSE event fires after 10 ms (setTimeout in mock above) so there
    // is a window between the first event (which makes the element appear) and the
    // second event (which triggers the text-change useEffect we want to assert on).
    const scrollEl = screen.getByTestId("thinking-scroll");
    const STUB_SCROLL_HEIGHT = 500;
    Object.defineProperty(scrollEl, "scrollHeight", { value: STUB_SCROLL_HEIGHT, configurable: true });
    let capturedScrollTop = -1;
    Object.defineProperty(scrollEl, "scrollTop", {
      get() { return capturedScrollTop; },
      set(v: number) { capturedScrollTop = v; },
      configurable: true,
    });

    await waitFor(
      () => expect(capturedScrollTop).toBe(STUB_SCROLL_HEIGHT),
      { timeout: 4000 },
    );
  });

  it("thinking text persists through tool calls (no token-clear wipe)", async () => {
    const encoder = new TextEncoder();
    const convId = "conv-tool-thinking";
    const turnId = "turn-tool";
    const thinkingContent = "important reasoning";
    const conv = { id: convId, mode: "chat", title: null, active_turn_id: turnId, messages: [] };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const u = url as string;
        if (u.includes("/stream")) {
          let ctrl!: ReadableStreamDefaultController<Uint8Array>;
          const stream = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
          // thinking arrives
          ctrl.enqueue(encoder.encode(
            `id: 1\ndata: ${JSON.stringify({ turnId, eventType: "thinking", payload: { text: thinkingContent } })}\n\n`,
          ));
          setTimeout(() => {
            // tool round: token clear (text:"") — must NOT clear thinking
            ctrl.enqueue(encoder.encode(
              `id: 2\ndata: ${JSON.stringify({ turnId, eventType: "token", payload: { text: "" } })}\n\n`,
            ));
          }, 10);
          setTimeout(() => {
            ctrl.close();
          }, 50);
          return Promise.resolve({ ok: true, body: stream } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(conv),
        } as unknown as Response);
      }),
    );

    render(<ConversationPane conversationId={convId} mode="standalone" />);

    // thinking block must appear
    await waitFor(
      () => expect(screen.getByTestId("thinking-block")).toBeInTheDocument(),
      { timeout: 4000 },
    );
    // and persist even after the token clear arrives
    await waitFor(
      () => expect(screen.getByText(thinkingContent)).toBeInTheDocument(),
      { timeout: 4000 },
    );
  });

  it("autosends prompt from sessionStorage on mount", async () => {
    const storedPrompt = "¿Cuántas ventas hubo ayer?";
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn().mockImplementation((key: string) =>
        key === "conv-autosend-conv-autosend-id" ? storedPrompt : null,
      ),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    });

    const fetchMock = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      const u = url as string;
      if (u.includes("/stream")) return makeStreamFetch();
      if (opts?.method === "POST" && u.includes("/turns")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ turnId: "turn-auto" }),
        } as unknown as Response);
      }
      return makeConvFetch("conv-autosend-id");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ConversationPane conversationId="conv-autosend-id" mode="standalone" />,
    );

    await waitFor(() => {
      const turnCall = fetchMock.mock.calls.find(
        ([url, opts]) =>
          typeof url === "string" &&
          url.includes("/turns") &&
          opts?.method === "POST",
      );
      expect(turnCall).toBeDefined();
      const body = JSON.parse(turnCall![1].body as string) as { content: string };
      expect(body.content).toBe(storedPrompt);
    });
  });

  it("clicking suggestion pill sends immediately", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      const u = url as string;
      if (u.includes("/stream")) return makeStreamFetch();
      if (opts?.method === "POST" && u === "/api/conversations") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: "new-analyze-conv" }),
        } as unknown as Response);
      }
      if (opts?.method === "POST" && u.includes("/turns")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ turnId: "turn-pill" }),
        } as unknown as Response);
      }
      return makeConvFetch("new-analyze-conv");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ConversationPane
        conversationId={null}
        mode="panel"
        newConversationConfig={{
          conversationMode: "analyze",
          contextKind: "dashboard",
          contextRef: "1",
        }}
        onConversationCreated={vi.fn()}
      />,
    );

    const pills = await screen.findAllByTestId("suggestion-pill");
    expect(pills.length).toBeGreaterThan(0);

    fireEvent.click(pills[0]);

    await waitFor(() => {
      const turnCall = fetchMock.mock.calls.find(
        ([url, opts]) =>
          typeof url === "string" &&
          url.includes("/turns") &&
          opts?.method === "POST",
      );
      expect(turnCall).toBeDefined();
    });
  });

  it("suggestion pills hidden after message sent", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      const u = url as string;
      if (u.includes("/stream")) return makeStreamFetch();
      if (opts?.method === "POST" && u === "/api/conversations") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: "new-modify-conv" }),
        } as unknown as Response);
      }
      if (opts?.method === "POST" && u.includes("/turns")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ turnId: "turn-hide" }),
        } as unknown as Response);
      }
      return makeConvFetch("new-modify-conv");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ConversationPane
        conversationId={null}
        mode="panel"
        newConversationConfig={{
          conversationMode: "modify",
          contextKind: "dashboard",
          contextRef: "1",
        }}
        onConversationCreated={vi.fn()}
      />,
    );

    // Pills should be visible in modify mode with no messages
    const pills = await screen.findAllByTestId("suggestion-pill");
    expect(pills.length).toBeGreaterThan(0);

    // Click a pill to trigger send
    fireEvent.click(pills[0]);

    // After send, pendingTurnId is set → pills disappear
    await waitFor(() => {
      expect(screen.queryByTestId("suggestion-pills")).not.toBeInTheDocument();
    });
  });

  it("AssistantBubble renders markdown as HTML", async () => {
    stubFetch("conv-md", [
      {
        id: "m1",
        conversation_id: "conv-md",
        role: "assistant",
        content: { text: "**bold text** and a list:\n- item one\n- item two" },
        created_at: new Date().toISOString(),
      },
    ]);
    render(<ConversationPane conversationId="conv-md" mode="standalone" />);
    await waitFor(() => {
      const bubble = screen.getByTestId("assistant-bubble");
      // ReactMarkdown renders **bold text** as <strong>
      const strong = bubble.querySelector("strong");
      expect(strong).toBeInTheDocument();
      expect(strong?.textContent).toBe("bold text");
      // And list items as <li>
      const items = bubble.querySelectorAll("li");
      expect(items.length).toBeGreaterThanOrEqual(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Stream-state reliability (#825 / #836 / #811 / #808)
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

function sseFrame(
  id: number,
  turnId: string,
  eventType: string,
  payload: Record<string, unknown>,
  replay = false,
): Uint8Array {
  const data: Record<string, unknown> = { turnId, eventType, payload };
  if (replay) data.replay = true;
  return enc.encode(`id: ${id}\ndata: ${JSON.stringify(data)}\n\n`);
}

describe("ConversationPane — stream-state reliability", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("#836: mid-turn resume renders replayed thinking/text even when the conversation fetch is slow", async () => {
    const convId = "conv-resume";
    const turnId = "turn-live";
    // Conversation fetch resolves AFTER the SSE replay frames have been
    // handled — the exact ordering that used to drop the replayed stream.
    const conv = { id: convId, mode: "chat", title: null, active_turn_id: turnId, messages: [] };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const u = url as string;
        if (u.includes("/stream")) {
          const stream = new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(sseFrame(1, turnId, "thinking", { text: "razonando sobre ventas" }, true));
              ctrl.enqueue(sseFrame(2, turnId, "token", { text: "Las ventas suben" }, true));
              // Stream stays open (turn still in flight) — no more frames.
            },
          });
          return Promise.resolve({ ok: true, body: stream } as unknown as Response);
        }
        return new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                ok: true,
                json: () => Promise.resolve(conv),
              } as unknown as Response),
            60,
          ),
        );
      }),
    );

    render(<ConversationPane conversationId={convId} mode="standalone" />);

    await waitFor(
      () => {
        expect(screen.getByTestId("thinking-block")).toBeInTheDocument();
        expect(screen.getByText("Las ventas suben")).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
  });

  it("replayed complete events do not trigger per-turn refetches", async () => {
    const convId = "conv-replay";
    const messages = [
      { id: "m1", conversation_id: convId, role: "user", content: { text: "hola" }, created_at: "2026-01-01" },
      { id: "m2", conversation_id: convId, role: "assistant", content: { text: "respuesta" }, created_at: "2026-01-01" },
    ];
    const conv = { id: convId, mode: "chat", title: null, active_turn_id: null, messages };

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const u = url as string;
      if (u.includes("/stream")) {
        const stream = new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(sseFrame(1, "turn-old", "complete", { messageId: "m2" }, true));
            // keep open
          },
        });
        return Promise.resolve({ ok: true, body: stream } as unknown as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(conv) } as unknown as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ConversationPane conversationId={convId} mode="standalone" />);
    await waitFor(() => expect(screen.getByText("respuesta")).toBeInTheDocument());

    // Only the initial loadConversation fetch — the replayed complete must not refetch.
    const convFetches = fetchMock.mock.calls.filter(
      ([u]) => (u as string).includes(`/api/conversations/${convId}`) && !(u as string).includes("/stream"),
    );
    expect(convFetches).toHaveLength(1);
  });

  it("#825: a passive window adopts a live turn and shows its stream", async () => {
    const convId = "conv-passive";
    const turnId = "turn-other-window";
    const conv = { id: convId, mode: "chat", title: null, active_turn_id: null, messages: [] };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const u = url as string;
        if (u.includes("/stream")) {
          const stream = new ReadableStream<Uint8Array>({
            start(ctrl) {
              // LIVE frames (no replay flag): another client started this turn.
              setTimeout(() => {
                ctrl.enqueue(sseFrame(1, turnId, "log", { kind: "meta", text: "Procesando…", ts: "2026-01-01T00:00:00Z" }));
                ctrl.enqueue(sseFrame(2, turnId, "token", { text: "Hola desde otra ventana" }));
              }, 10);
            },
          });
          return Promise.resolve({ ok: true, body: stream } as unknown as Response);
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(conv) } as unknown as Response);
      }),
    );

    render(<ConversationPane conversationId={convId} mode="standalone" />);

    await waitFor(
      () => expect(screen.getByText("Hola desde otra ventana")).toBeInTheDocument(),
      { timeout: 4000 },
    );
  });

  it("#811: synthesises the assistant message locally when the post-complete refetch fails", async () => {
    const convId = "conv-refetch-fail";
    const turnId = "turn-x";
    const conv = { id: convId, mode: "chat", title: null, active_turn_id: turnId, messages: [] };
    let convFetches = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const u = url as string;
        if (u.includes("/stream")) {
          const stream = new ReadableStream<Uint8Array>({
            start(ctrl) {
              setTimeout(() => {
                ctrl.enqueue(sseFrame(1, turnId, "token", { text: "Respuesta completa del modelo" }));
                ctrl.enqueue(sseFrame(2, turnId, "complete", { messageId: "m-new" }));
              }, 10);
            },
          });
          return Promise.resolve({ ok: true, body: stream } as unknown as Response);
        }
        convFetches++;
        if (convFetches === 1) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(conv) } as unknown as Response);
        }
        // Post-complete refresh fails.
        return Promise.resolve({ ok: false, status: 500 } as unknown as Response);
      }),
    );

    render(<ConversationPane conversationId={convId} mode="standalone" />);

    // The streamed text must survive as a synthetic message — not vanish.
    await waitFor(
      () => expect(screen.getByText("Respuesta completa del modelo")).toBeInTheDocument(),
      { timeout: 4000 },
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Escribe un mensaje…")).toBeEnabled(),
    );
  });

  it("#808: restores the typed message into the input when the send fails", async () => {
    const convId = "conv-send-fail";
    const conv = { id: convId, mode: "chat", title: null, active_turn_id: null, messages: [] };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        const u = url as string;
        if (u.includes("/stream")) return makeStreamFetch();
        if (u.includes("/turns") && opts?.method === "POST") {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ error: "Error al crear el turno." }),
          } as unknown as Response);
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(conv) } as unknown as Response);
      }),
    );

    render(<ConversationPane conversationId={convId} mode="standalone" />);
    const input = screen.getByPlaceholderText("Escribe un mensaje…");
    fireEvent.change(input, { target: { value: "mensaje importante" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(screen.getByText("Error al crear el turno.")).toBeInTheDocument(),
    );
    // The typed text is back in the input — not lost (issue #808).
    expect(input).toHaveValue("mensaje importante");
  });
});

describe("ConversationPane — SSE liveness fallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("settles a pending turn via polling when SSE delivers no events at all", async () => {
    const convId = "conv-stalled";
    const turnId = "turn-stalled";
    // First conversation fetch: turn still active. Later fetches: finished,
    // with the assistant message persisted. SSE delivers NOTHING (the stall).
    let calls = 0;
    const running = { id: convId, mode: "chat", title: null, active_turn_id: turnId, messages: [] };
    const finished = {
      id: convId,
      mode: "chat",
      title: null,
      active_turn_id: null,
      messages: [
        { id: "mu", conversation_id: convId, role: "user", content: { text: "hola" }, created_at: "2026-01-01" },
        { id: "ma", conversation_id: convId, role: "assistant", content: { text: "[e2e-stub] Respuesta a: \"hola\"" }, created_at: "2026-01-01" },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const u = url as string;
        if (u.includes("/stream")) {
          // Open stream that never produces a frame — the stall.
          const stream = new ReadableStream<Uint8Array>({ start() {} });
          return Promise.resolve({ ok: true, body: stream } as unknown as Response);
        }
        if (u.includes(`/turns/${turnId}`)) {
          // The per-turn status poll: the turn finished server-side.
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ turn: { status: "complete" } }),
          } as unknown as Response);
        }
        calls++;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(calls === 1 ? running : finished),
        } as unknown as Response);
      }),
    );

    render(<ConversationPane conversationId={convId} mode="standalone" />);

    // The poll (2.5s cadence) must surface the persisted reply and re-enable input.
    await waitFor(
      () => expect(screen.getByText('[e2e-stub] Respuesta a: "hola"')).toBeInTheDocument(),
      { timeout: 9000 },
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Escribe un mensaje…")).toBeEnabled(),
    );
  }, 15_000);
});
