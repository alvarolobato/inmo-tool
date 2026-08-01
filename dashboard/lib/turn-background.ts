/**
 * Server-side turn executor — runs the LLM call for a conversation turn.
 *
 * Called fire-and-forget from POST /api/conversations/:id/turns.
 * Writes turn_events rows as progress is made; transitions conversation_turns.status.
 * Never throws — errors are caught and stored in the turn row.
 */

import {
  updateTurnStatus,
  insertTurnEvent,
  setTurnContextFile,
  pruneStreamEvents,
  type TurnRow,
} from "@/lib/turn-events";
import { writeTurnContext } from "@/lib/conversation-context-store";
import {
  appendMessage,
  loadMessages,
  maybeGenerateTitle,
  touchConversation,
  type ConversationRow,
} from "@/lib/conversations";
import { publish } from "@/lib/sse-pubsub";
import { generateRequestId } from "@/lib/errors";
import { loadDashboardLlmConfig, getEffectiveDashboardModel } from "@/lib/llm-provider/config";
import {
  flattenStoredMessage,
  capHistory,
  HISTORY_MAX_MESSAGES,
} from "@/lib/llm-context/history";
import type { AgenticToolCallRecord } from "@/lib/llm-tools/types";
import type { AssistantMessageContent, ToolCallRecord } from "@/lib/conversation-types";

// Re-export for use in tests without importing from route
export type { ConversationRow };

// ── Tool-call persistence ──────────────────────────────────────────────────────

/** Best-effort parse of a raw JSON arguments string into an object for storage. */
function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : { _raw: raw };
  } catch {
    return { _raw: raw };
  }
}

/** Map runner-captured tool calls to the persisted conversation_messages shape. */
function toDbToolCalls(calls: AgenticToolCallRecord[] | undefined): ToolCallRecord[] {
  return (calls ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    arguments: parseToolArgs(c.arguments),
    result: c.result,
    success: c.ok,
    duration_ms: c.ms,
  }));
}

// ── Tool arg formatting ────────────────────────────────────────────────────────

function formatToolArgs(toolName: string, argsPreview?: string): string {
  if (!argsPreview) return "";
  // argsPreview may be TRUNCATED JSON (the runner limits preview length),
  // so JSON.parse often throws. Use regex extraction as the primary approach.

  // Helper: extract a named string field from potentially truncated JSON
  function extractField(json: string, key: string): string | null {
    // Matches "key":"value" — value can contain escaped chars
    const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`);
    const m = json.match(re);
    if (!m) return null;
    // Unescape JSON string escapes in the extracted value
    return m[1].replace(/\\"/g, '"').replace(/\\n/g, " ").replace(/\\\\/g, "\\");
  }

  if (toolName === "execute_query" || toolName === "execute_write_query") {
    const sql = extractField(argsPreview, "sql");
    if (sql) return sql.replace(/\s+/g, " ").slice(0, 160);
  }
  if (toolName === "describe_table") {
    const name = extractField(argsPreview, "table_name") ?? extractField(argsPreview, "name");
    if (name) return name;
  }
  // Generic: try first string field
  const firstStr = argsPreview.match(/"[^"]+"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (firstStr) {
    return firstStr[1].replace(/\\"/g, '"').replace(/\\n/g, " ").slice(0, 160);
  }
  return "";
}

// ── Shared agentic progress handler ───────────────────────────────────────────

/** Progress emitter handle: the callback plus turn-final accessors. */
interface ProgressEmitter {
  handler: (event: import("@/lib/llm-tools/types").AgenticProgressEvent) => void;
  /** Resolves once every queued event insert has settled (issue #834 ordering). */
  flush: () => Promise<void>;
  /** Latest cumulative extended-thinking text seen this turn ("" if none). */
  thinkingText: () => string;
}

/**
 * Creates an onAgenticProgress callback that emits SSE events for streaming
 * tokens, extended thinking, and tool progress. Used by both runFreeChatTurn
 * and runDashboardTurn so behaviour is identical across conversation modes.
 *
 * Event inserts are serialised through a per-turn promise chain so turn_events
 * BIGSERIAL ids match the allocated seq order (fire-and-forget inserts could
 * previously complete out of order — issue #834). The chain never rejects:
 * each link swallows its own error so one failed insert doesn't drop the rest.
 *
 * The latest cumulative thinking text is captured so the caller can persist it
 * durably on the assistant message before the transient thinking events are
 * pruned (issues #825/#834).
 */
function makeProgressHandler(
  conversationId: string,
  turnId: string,
  seq: () => number,
  /** When true, token streaming is suppressed (analyze/modify use tool calls for output). */
  suppressTokens = false,
): ProgressEmitter {
  let inToolRound = false;
  let latestThinking = "";
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (eventType: string, payload: Record<string, unknown>) => {
    // Allocate the seq synchronously so ordering is fixed at enqueue time.
    const eventSeq = seq();
    chain = chain.then(() =>
      emitTurnEvent(conversationId, turnId, eventSeq, eventType, payload).catch(
        () => {},
      ),
    );
  };

  const handler = (event: import("@/lib/llm-tools/types").AgenticProgressEvent) => {
    if (event.type === "round") {
      inToolRound = false;
    } else if (event.type === "assistant_tools") {
      inToolRound = true;
      // Clear streaming tokens that appeared before we knew this was a tool round.
      // Thinking text is preserved — it remains visible while tools execute.
      if (!suppressTokens) {
        enqueue("token", { text: "" });
      }
      return;
    } else if (event.type === "model_thinking_delta" && event.text) {
      if (!inToolRound) {
        latestThinking = event.text;
        enqueue("thinking", { text: event.text });
      }
      return;
    } else if (event.type === "model_text_delta" && event.text) {
      // model_text_delta.text is CUMULATIVE — replace, never append.
      // For dashboard modes (analyze/modify), ALL text deltas are tool-call JSON —
      // suppress them so users don't see raw JSON streaming.
      if (!inToolRound && !suppressTokens) {
        enqueue("token", { text: event.text });
      }
      return;
    }

    // Tool progress log lines.
    let logText: string | null = null;
    if (event.type === "tool_start") {
      const args = formatToolArgs(event.name, event.argsPreview);
      logText = `▶ ${event.name}${args ? `: ${args}` : ""}`;
    } else if (event.type === "tool_done") {
      logText = `${event.ok ? "✓" : "✗"} ${event.name} (${event.ms}ms)`;
    }
    if (logText) {
      enqueue("log", {
        kind: "tool",
        text: logText,
        ts: new Date().toISOString(),
      });
    }
  };

  return {
    handler,
    flush: () => chain,
    thinkingText: () => latestThinking,
  };
}

// ── Context-log capture handler ────────────────────────────────────────────────

/**
 * Creates an `onSystemPromptReady` callback that writes the EXACT payload sent to
 * the LLM (system prompt, tool catalog, full prior history, user message) to this
 * turn's context-log file on the data volume, records the pointer on the turn, and
 * emits a lightweight "context_ref" turn event so the UI can show a collapsed
 * "Contexto original" entry and lazy-load the file when expanded.
 *
 * assembleRequest() invokes this once it has assembled the request (before the
 * first LLM call). The heavy payload never touches Postgres — only the pointer
 * does. Best-effort: a write/DB failure must not break the turn.
 *
 * Wired for every conversation mode (free-chat, analyze/modify, generic).
 */
/** Mutable holder so the caller can await the (async) context-log write. */
interface ContextWriteHandle {
  done: Promise<void>;
}

function makeSystemPromptReadyHandler(
  conversation: ConversationRow,
  mode: string,
  userMessage: string,
  priorMessages: Array<{ role: string; content: string }>,
  requestId: string,
  conversationId: string,
  turnId: string,
  seq: () => number,
  handle: ContextWriteHandle,
): (
  systemPrompt: string,
  tools?: Array<{ name: string; schema: Record<string, unknown> }>,
) => void {
  return (systemPrompt, tools) => {
    // Allocate the seq synchronously so event ordering stays deterministic even
    // though the file write + DB update + emit happen asynchronously below.
    const eventSeq = seq();
    // Kick off the write now (so live viewers get the context_ref early via the
    // SSE publish) and record the promise so the turn awaits it before completing.
    handle.done = (async () => {
      // The context log: an exact copy of what was sent to the LLM this turn.
      // Full, untruncated history — it lives in a file, not the DB.
      const context = {
        model: resolveModelName(),
        provider: conversation.llm_provider ?? "unknown",
        driver: conversation.llm_driver ?? null,
        flow: mode,
        seed_prompt: userMessage,
        prior_messages: priorMessages.length,
        prior_messages_history: priorMessages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        system_prompt_stable: systemPrompt,
        ...(tools && tools.length > 0 && { tools }),
      };
      const file = await writeTurnContext(conversationId, turnId, context);
      if (!file) return; // best-effort — skip the pointer/ref on write failure
      try {
        await setTurnContextFile(turnId, file);
      } catch (err) {
        console.warn(`[turn-background] setTurnContextFile failed for ${turnId}:`, err);
      }
      await emitTurnEvent(conversationId, turnId, eventSeq, "context_ref", {
        turnId,
        file,
        model: context.model,
        provider: context.provider,
        driver: context.driver,
        flow: mode,
        prior_messages: priorMessages.length,
        requestId,
      }).catch(() => {});
    })();
  };
}

// ── Sequential event counter per turn ─────────────────────────────────────────

function makeSeq(): () => number {
  let n = 0;
  return () => n++;
}

// ── Insert + publish helper ────────────────────────────────────────────────────

async function emitTurnEvent(
  conversationId: string,
  turnId: string,
  seq: number,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const dbEventId = await insertTurnEvent(turnId, seq, eventType, payload);
  publish(conversationId, { dbEventId, turnId, seq, eventType, payload });
}

// ── Dispatcher ─────────────────────────────────────────────────────────────────

export async function runTurnBackground(
  turnId: string,
  conversation: ConversationRow,
  userMessage: string,
): Promise<void> {
  const requestId = generateRequestId();
  const seq = makeSeq();
  const conversationId = conversation.id;
  const mode = conversation.mode;
  const isFreeChatConv = conversation.context_kind === "global" || mode === "chat";
  // One progress emitter per turn: serialised event inserts + final thinking
  // capture. Token streaming is suppressed for dashboard modes (analyze/modify
  // always end with a tool call, never prose — text deltas are tool-call JSON).
  // Declared OUTSIDE the try so the catch block can flush the insert chain
  // before pruning — otherwise queued token/thinking inserts could land after
  // pruneStreamEvents and resurrect the rows it just deleted.
  const progress = makeProgressHandler(
    conversationId,
    turnId,
    seq,
    mode === "analyze" || mode === "modify",
  );

  try {
    await updateTurnStatus(turnId, "streaming");

    // Load prior messages first so the context snapshot includes the message count.
    // Must be loaded before appending the current user message.
    const prior = await loadMessages(conversationId);
    // Flatten to history lines — assistant turns carry their tool calls folded in
    // as a compact block so tool results stay in context across turns.
    const flattened = prior
      .map((m) => flattenStoredMessage(m))
      .filter((m): m is { role: "user" | "assistant"; content: string } => m !== null);
    // Cap the history BEFORE the context log is written so "Contexto original"
    // shows exactly what the LLM receives. Older messages beyond the cap are
    // summarised into one synthetic assistant message (see capHistory); the
    // conversation mode doubles as the flow for per-flow model routing.
    const priorMessages = await capHistory(
      flattened,
      HISTORY_MAX_MESSAGES,
      conversation.mode ?? "chat",
    );

    // The context log (exact payload sent to the LLM) is written to this turn's
    // file and announced via a lightweight "context_ref" event from
    // makeSystemPromptReadyHandler once assembleRequest() assembles the request —
    // it is NOT stored in Postgres.

    // Persist user message so future turns can reconstruct full history.
    await appendMessage(conversationId, "user", { text: userMessage });

    // Dispatch to the appropriate LLM path based on conversation mode.
    let assistantText: string;
    // Tool calls the model made this turn — persisted on the assistant message so
    // later turns retain the tool context (which query ran, with what result).
    let assistantToolCalls: AgenticToolCallRecord[] = [];

    await emitTurnEvent(conversationId, turnId, seq(), "log", {
      kind: "meta",
      text: "Procesando…",
      ts: new Date().toISOString(),
    });

    // E2E stub: return a canned response instantly without calling any LLM.
    // Activated by DASHBOARD_LLM_PROVIDER=e2e-stub — used in CI Playwright tests
    // to avoid API costs and external dependencies.
    if (process.env.DASHBOARD_LLM_PROVIDER === "e2e-stub") {
      await emitTurnEvent(conversationId, turnId, seq(), "log", {
        kind: "meta",
        text: "[e2e-stub] respuesta generada sin LLM real",
        ts: new Date().toISOString(),
      });
      // Exercise the real context-log path (write file + emit context_ref) so the
      // UI still shows "Contexto original" without a real LLM call.
      const stubHandle: ContextWriteHandle = { done: Promise.resolve() };
      makeSystemPromptReadyHandler(
        conversation,
        mode,
        userMessage,
        priorMessages,
        requestId,
        conversationId,
        turnId,
        seq,
        stubHandle,
      )("[e2e-stub] system prompt", []);
      await stubHandle.done;
      assistantText = `[e2e-stub] Respuesta a: "${userMessage.slice(0, 80)}"`;
    } else if (isFreeChatConv) {
      const res = await runFreeChatTurn(
        conversation,
        userMessage,
        priorMessages,
        requestId,
        conversationId,
        turnId,
        seq,
        progress,
      );
      assistantText = res.text;
      assistantToolCalls = res.toolCalls;
    } else if (mode === "analyze" || mode === "modify") {
      const dashResult = await runDashboardTurn(
        mode,
        conversation,
        userMessage,
        priorMessages,
        requestId,
        conversationId,
        turnId,
        seq,
        progress,
      );
      assistantText = dashResult.text;
      assistantToolCalls = dashResult.toolCalls;
      // Notify SSE clients when a modify turn produced a new dashboard spec.
      if (dashResult.spec) {
        await emitTurnEvent(conversationId, turnId, seq(), "spec_update", {
          spec: dashResult.spec,
          summary: dashResult.summary ?? "",
          prompt: userMessage,
        });
      }
    } else {
      // Fallback: generic single-shot chat completion.
      const res = await runGenericTurn(
        conversation,
        userMessage,
        priorMessages,
        requestId,
        conversationId,
        turnId,
        seq,
      );
      assistantText = res.text;
      assistantToolCalls = res.toolCalls;
    }

    // All streamed events are inserted before the assistant message/complete
    // event so replay ordering is deterministic (issue #834).
    await progress.flush();

    // Persist final assistant message to conversation_messages — including the
    // tool calls made this turn so later turns retain the tool context, and the
    // final thinking text so it survives reloads (the transient thinking events
    // are pruned below — issues #825/#834).
    const assistantContent: AssistantMessageContent = { text: assistantText };
    const dbToolCalls = toDbToolCalls(assistantToolCalls);
    if (dbToolCalls.length > 0) assistantContent.tool_calls = dbToolCalls;
    const finalThinking = progress.thinkingText();
    if (finalThinking) assistantContent.thinking = finalThinking;
    const assistantMsg = await appendMessage(
      conversationId,
      "assistant",
      assistantContent,
    );
    await touchConversation(conversationId, "ok");

    // Emit the complete event with the assistant message for SSE clients.
    await emitTurnEvent(conversationId, turnId, seq(), "complete", {
      messageId: assistantMsg.id,
    });

    await updateTurnStatus(turnId, "complete");

    // Drop the turn's transient token/thinking snapshots now that the durable
    // copy lives on the assistant message (issue #834). Best-effort.
    await pruneStreamEvents(turnId).catch(() => {});

    // Best-effort title generation — failure must not affect turn status.
    void maybeGenerateTitle(conversationId, [
      ...priorMessages,
      { role: "user" as const, content: userMessage },
      { role: "assistant" as const, content: assistantText },
    ]).catch(() => {});
  } catch (err) {
    const errText = err instanceof Error ? err.message : String(err);
    console.error(`[${requestId}] runTurnBackground error for turn ${turnId}:`, err);
    // Settle any queued streaming inserts BEFORE the error event and prune:
    // without this, late token/thinking inserts could publish after the error
    // frame and re-create rows pruneStreamEvents just deleted.
    await progress.flush().catch(() => {});
    // Persist the error as an assistant message so the failed turn remains
    // visible after a reload — without it, an errored turn shows only the user
    // bubble with no indication anything went wrong (issue #824). The client
    // renders is_error content with the error styling it already supports.
    let errorMessageId: string | null = null;
    try {
      const errorMsg = await appendMessage(conversationId, "assistant", {
        text: errText,
        is_error: true,
      });
      errorMessageId = errorMsg.id;
    } catch (persistErr) {
      console.error(
        `[${requestId}] could not persist error message for turn ${turnId}:`,
        persistErr,
      );
    }
    await emitTurnEvent(conversationId, turnId, seq(), "error", {
      message: errText,
      ts: new Date().toISOString(),
      // Lets the client attach the turn's logs/context panel to the persisted
      // error message, same as complete does via messageId.
      ...(errorMessageId ? { messageId: errorMessageId } : {}),
    }).catch(() => {});
    await updateTurnStatus(turnId, "error", errText).catch(() => {});
    await pruneStreamEvents(turnId).catch(() => {});
    await touchConversation(conversationId, "error").catch(() => {});
  }
}

// ── LLM dispatch helpers ───────────────────────────────────────────────────────

/** Text reply plus any tool calls the model made, for persistence. */
interface TurnReply {
  text: string;
  toolCalls: AgenticToolCallRecord[];
}

async function runFreeChatTurn(
  conversation: ConversationRow,
  userMessage: string,
  priorMessages: Array<{ role: "user" | "assistant"; content: string }>,
  requestId: string,
  conversationId: string,
  turnId: string,
  seq: () => number,
  progress: ProgressEmitter,
): Promise<TurnReply> {
  const { assembleRequest } = await import("@/lib/llm-context");
  const { AgenticRunnerError } = await import("@/lib/llm-tools/runner");

  const ctxWrite: ContextWriteHandle = { done: Promise.resolve() };
  const agenticCtx: import("@/lib/llm-tools/types").LlmAgenticContext = {
    requestId,
    endpoint: "freeChat" as const,
    conversationId,
    onAgenticProgress: progress.handler,
    // Write the exact payload sent to the LLM to this turn's context-log file.
    onSystemPromptReady: makeSystemPromptReadyHandler(
      conversation,
      "chat",
      userMessage,
      priorMessages,
      requestId,
      conversationId,
      turnId,
      seq,
      ctxWrite,
    ),
  };

  try {
    const result = await assembleRequest(
      "chat",
      {},
      null,
      userMessage,
      {
        ctx: agenticCtx,
        priorMessages,
        requestId,
        endpoint: "freeChat",
        temperature: 0.3,
        maxOutputTokens: 4096,
      },
    );
    await ctxWrite.done; // ensure the context-log file + pointer are persisted
    return { text: result.text, toolCalls: agenticCtx.toolCalls ?? [] };
  } catch (err) {
    if (err instanceof AgenticRunnerError) {
      await emitTurnEvent(conversationId, turnId, seq(), "log", {
        kind: "error",
        text: err.message,
        ts: new Date().toISOString(),
      }).catch(() => {});
    }
    throw err;
  }
}

interface DashboardTurnResult {
  text: string;
  /** Tool calls the model made this turn (execute_query, describe_table, …). */
  toolCalls: AgenticToolCallRecord[];
  /** Set when apply_dashboard_modification tool staged a new spec. */
  spec?: import("@/lib/schema").DashboardSpec;
  summary?: string;
}

async function runDashboardTurn(
  mode: string,
  conversation: ConversationRow,
  userMessage: string,
  priorMessages: Array<{ role: "user" | "assistant"; content: string }>,
  requestId: string,
  conversationId: string,
  turnId: string,
  seq: () => number,
  progress: ProgressEmitter,
): Promise<DashboardTurnResult> {
  const { sql } = await import("@/lib/db-write");
  const ctxWrite: ContextWriteHandle = { done: Promise.resolve() };
  // agenticCtx is mutated in-place by tool handlers (modifyResult, analyzeResult).
  const agenticCtx: import("@/lib/llm-tools/types").LlmAgenticContext = {
    requestId,
    endpoint: (mode === "analyze" ? "analyzeDashboard" : "modifyDashboard") as
      | "analyzeDashboard"
      | "modifyDashboard",
    conversationId: conversation.id,
    // Wire agentic progress events to SSE. The emitter was created with token
    // streaming suppressed for dashboard modes — analyze/modify always end with
    // a tool call (submit_dashboard_analysis or apply_dashboard_modification),
    // never prose, so model_text_delta is JSON.
    onAgenticProgress: progress.handler,
    // Write the exact payload sent to the LLM to this turn's context-log file.
    onSystemPromptReady: makeSystemPromptReadyHandler(
      conversation,
      mode,
      userMessage,
      priorMessages,
      requestId,
      conversation.id,
      turnId,
      seq,
      ctxWrite,
    ),
  };

  let currentSpec = "";
  let dashId: number | undefined;
  if (conversation.context_ref) {
    dashId = Number(conversation.context_ref);
    if (Number.isFinite(dashId)) {
      const specRows = await sql<{ spec: unknown }>(
        `SELECT spec FROM dashboards WHERE id = $1`,
        [dashId],
      ).catch(() => [] as { spec: unknown }[]);
      currentSpec = specRows[0]?.spec ? JSON.stringify(specRows[0].spec) : "";
    }
  }

  if (mode === "analyze") {
    const { analyzeDashboard } = await import("@/lib/llm");
    const text = await analyzeDashboard(
      currentSpec,
      userMessage,
      undefined,
      agenticCtx,
      priorMessages,
    );
    await ctxWrite.done; // ensure the context-log file + pointer are persisted
    return { text, toolCalls: agenticCtx.toolCalls ?? [] };
  } else {
    const { modifyDashboard } = await import("@/lib/llm");
    const text = await modifyDashboard(currentSpec, userMessage, agenticCtx, priorMessages);
    await ctxWrite.done; // ensure the context-log file + pointer are persisted
    const toolCalls = agenticCtx.toolCalls ?? [];

    // If the agentic runner called apply_dashboard_modification, persist the new
    // spec through the single versioned writer: previous spec is snapshotted
    // into dashboard_versions and updated_at is bumped, exactly like a manual
    // save via PUT /api/dashboard/:id. The server is the ONLY writer for
    // chat-driven modifications — the frontend only updates local state on
    // the spec_update event (no second PUT).
    if (agenticCtx.modifyResult && dashId !== undefined && Number.isFinite(dashId)) {
      const { spec, summary } = agenticCtx.modifyResult;
      try {
        const { updateDashboardSpecWithVersion } = await import("@/lib/db-write");
        const persisted = await updateDashboardSpecWithVersion(dashId, spec, userMessage);
        if (persisted !== null) {
          return { text, toolCalls, spec, summary };
        }
        console.error(`[turn-background] spec persist skipped: dashboard ${dashId} not found`);
      } catch (err) {
        console.error(`[turn-background] spec persist failed for dashboard ${dashId}:`, err);
      }
    }

    return { text, toolCalls };
  }
}

async function runGenericTurn(
  conversation: ConversationRow,
  userMessage: string,
  priorMessages: Array<{ role: "user" | "assistant"; content: string }>,
  requestId: string,
  conversationId: string,
  turnId: string,
  seq: () => number,
): Promise<TurnReply> {
  const { assembleRequest } = await import("@/lib/llm-context");
  const flowRaw = conversation.mode ?? "chat";
  const ctxWrite: ContextWriteHandle = { done: Promise.resolve() };
  // agenticCtx is captured so we can read back any tool calls after the run.
  const agenticCtx: import("@/lib/llm-tools/types").LlmAgenticContext = {
    requestId,
    endpoint: flowRaw,
    conversationId,
    // Write the exact payload sent to the LLM to this turn's context-log file.
    onSystemPromptReady: makeSystemPromptReadyHandler(
      conversation,
      flowRaw,
      userMessage,
      priorMessages,
      requestId,
      conversationId,
      turnId,
      seq,
      ctxWrite,
    ),
  };
  const result = await assembleRequest(
    flowRaw,
    {},
    null,
    userMessage,
    {
      priorMessages,
      requestId,
      endpoint: flowRaw,
      ctx: agenticCtx,
    },
  );
  await ctxWrite.done; // ensure the context-log file + pointer are persisted
  return { text: result.text, toolCalls: agenticCtx.toolCalls ?? [] };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function resolveModelName(): string {
  try {
    const cfg = loadDashboardLlmConfig();
    return getEffectiveDashboardModel(cfg);
  } catch {
    return "unknown";
  }
}
