import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSql } = vi.hoisted(() => ({
  mockSql: vi.fn(),
}));

vi.mock("@/lib/db-write", () => ({
  sql: mockSql,
}));

import {
  logLlmError,
  logLlmToolCall,
  fetchToolCallAggregates,
} from "@/lib/llm-tools/logging";

describe("logLlmToolCall", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockSql.mockResolvedValue([]);
  });

  it("inserts a row with all primary columns and provided fields", async () => {
    await logLlmToolCall({
      toolName: "validate_query",
      endpoint: "generateDashboard",
      requestId: "req_a",
      status: "ok",
      latencyMs: 42,
      payloadInBytes: 100,
      payloadOutBytes: 250,
      llmProvider: "openrouter",
    });

    expect(mockSql).toHaveBeenCalledOnce();
    const [query, params] = mockSql.mock.calls[0];
    expect(query).toContain("INSERT INTO llm_tool_calls");
    expect(params[0]).toBe("validate_query");
    expect(params[1]).toBe("generateDashboard");
    expect(params[2]).toBe("req_a");
    expect(params[3]).toBe("ok");
    expect(params[4]).toBe(42);
    expect(params[5]).toBe(100);
    expect(params[6]).toBe(250);
    expect(params[7]).toBe(null); // errorCode default
    expect(params[8]).toBe("openrouter");
    expect(params[9]).toBe(null); // llmDriver default
  });

  it("defaults llmProvider to 'openrouter' when omitted", async () => {
    await logLlmToolCall({
      toolName: "execute_query",
      endpoint: "modifyDashboard",
      requestId: null,
      status: "error",
      latencyMs: 7,
      payloadInBytes: 0,
      payloadOutBytes: 0,
      errorCode: "TIMEOUT",
    });

    const [, params] = mockSql.mock.calls[0];
    expect(params[7]).toBe("TIMEOUT");
    expect(params[8]).toBe("openrouter");
  });

  it("passes through cli driver label when provided", async () => {
    await logLlmToolCall({
      toolName: "list_dashboards",
      endpoint: "analyze",
      requestId: "req_z",
      status: "ok",
      latencyMs: 1,
      payloadInBytes: 0,
      payloadOutBytes: 10,
      llmProvider: "cli",
      llmDriver: "claude_code",
    });

    const [, params] = mockSql.mock.calls[0];
    expect(params[8]).toBe("cli");
    expect(params[9]).toBe("claude_code");
  });

  it("swallows DB errors silently (does not propagate)", async () => {
    mockSql.mockRejectedValueOnce(new Error("connection refused"));
    await expect(
      logLlmToolCall({
        toolName: "x",
        endpoint: "y",
        requestId: "z",
        status: "ok",
        latencyMs: 0,
        payloadInBytes: 0,
        payloadOutBytes: 0,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("logLlmError", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockSql.mockResolvedValue([]);
  });

  it("inserts a row with all required fields and JSON-stringified limits", async () => {
    await logLlmError({
      requestId: "req_err",
      endpoint: "generateDashboard",
      code: "AGENTIC_RUNNER",
      provider: "openrouter",
      limits: { maxRounds: 4, maxToolCalls: 12 },
    });

    expect(mockSql).toHaveBeenCalledOnce();
    const [query, params] = mockSql.mock.calls[0];
    expect(query).toContain("INSERT INTO llm_errors");
    expect(params[0]).toBe("req_err");
    expect(params[1]).toBe("generateDashboard");
    expect(params[2]).toBe("AGENTIC_RUNNER");
    expect(params[4]).toBe("openrouter");
    // Last parameter is JSON-stringified limits.
    const lastIdx = params.length - 1;
    expect(JSON.parse(params[lastIdx])).toEqual({ maxRounds: 4, maxToolCalls: 12 });
  });

  it("nullifies optional fields and stringifies cliInnerCode", async () => {
    await logLlmError({
      requestId: "req_err2",
      endpoint: "modify",
      code: "LLM_CLI_API_ERROR",
      provider: "cli",
      cliInnerCode: 401,
    });

    const [, params] = mockSql.mock.calls[0];
    // sub_error, driver, model, phase, durations, etc. all null
    expect(params[3]).toBe(null);
    expect(params[5]).toBe(null);
    expect(params[6]).toBe(null);
    // cliInnerCode is at index 14 (after cli_exit_code at 13).
    expect(params[14]).toBe("401");
  });

  it("swallows DB errors silently", async () => {
    mockSql.mockRejectedValueOnce(new Error("table missing"));
    await expect(
      logLlmError({
        requestId: "req_e",
        endpoint: "x",
        code: "FOO",
        provider: "openrouter",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("fetchToolCallAggregates", () => {
  beforeEach(() => {
    mockSql.mockReset();
  });

  it("returns the rows from the aggregate query", async () => {
    const fakeRows = [
      {
        endpoint: "generateDashboard",
        tool_name: "execute_query",
        status: "ok",
        calls: 5,
        avg_latency_ms: 100,
        total_payload_in: 1000,
        total_payload_out: 2000,
      },
    ];
    mockSql.mockResolvedValueOnce(fakeRows);

    const out = await fetchToolCallAggregates();
    expect(out).toEqual(fakeRows);
    const [query] = mockSql.mock.calls[0];
    expect(query).toMatch(/FROM llm_tool_calls/i);
    expect(query).toMatch(/30 days/);
  });

  it("returns an empty array when the query throws", async () => {
    mockSql.mockRejectedValueOnce(new Error("bad sql"));
    const out = await fetchToolCallAggregates();
    expect(out).toEqual([]);
  });
});
