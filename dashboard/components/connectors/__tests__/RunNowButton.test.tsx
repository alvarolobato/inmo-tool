// @vitest-environment jsdom
/**
 * Unit tests for the "Ejecutar ahora" control (issue #244). Covers the POST
 * shape (full sweep vs. connector-scoped), the done/failed status transitions,
 * and that onFinished fires once at a terminal state. Polling resolves on the
 * first GET (status 'done'/'failed') so no timers are needed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { RunNowButton } from "../RunNowButton";

const originalFetch = globalThis.fetch;

function fetchStub(postJson: unknown, getJson: unknown, postOk = true, getOk = true) {
  return vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
    if (url === "/api/etl/run" && opts?.method === "POST") {
      return Promise.resolve({ ok: postOk, json: () => Promise.resolve(postJson) });
    }
    if (url.startsWith("/api/etl/run?")) {
      return Promise.resolve({ ok: getOk, json: () => Promise.resolve(getJson) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

describe("RunNowButton", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs a full sweep (empty body) when no connectorName is given", async () => {
    const fetchMock = fetchStub(
      { trigger_id: 1, status: "pending", connector_name: null },
      { id: 1, status: "done" },
    );
    globalThis.fetch = fetchMock;
    const onFinished = vi.fn();
    render(<RunNowButton testIdSuffix="all" label="Ejecutar todo ahora" onFinished={onFinished} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("run-now-all"));
    });

    const post = fetchMock.mock.calls.find(
      (c) => c[0] === "/api/etl/run" && (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({});

    await waitFor(() => {
      expect(screen.getByTestId("run-status-all")).toHaveTextContent("completada");
    });
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it("POSTs the connector_name when scoped to one connector", async () => {
    const fetchMock = fetchStub(
      { trigger_id: 2, status: "pending", connector_name: "fotocasa" },
      { id: 2, status: "done" },
    );
    globalThis.fetch = fetchMock;
    render(<RunNowButton testIdSuffix="fotocasa" connectorName="fotocasa" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("run-now-fotocasa"));
    });

    const post = fetchMock.mock.calls.find(
      (c) => c[0] === "/api/etl/run" && (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({
      connector_name: "fotocasa",
    });
  });

  it("surfaces a failed run with its error message", async () => {
    globalThis.fetch = fetchStub(
      { trigger_id: 3, status: "pending", connector_name: null },
      { id: 3, status: "failed", error_msg: "boom" },
    );
    render(<RunNowButton testIdSuffix="all" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("run-now-all"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("run-status-all")).toHaveTextContent("boom");
    });
  });

  it("surfaces a 409 (already pending) from the POST", async () => {
    globalThis.fetch = fetchStub(
      {
        error: "Ya hay una ejecución pendiente.",
        code: "CONFLICT",
        timestamp: "2026-08-04T00:00:00Z",
        requestId: "x",
      },
      {},
      false,
    );
    render(<RunNowButton testIdSuffix="all" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("run-now-all"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("run-status-all")).toHaveTextContent("pendiente");
    });
  });
});
