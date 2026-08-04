// @vitest-environment node
/**
 * Unit tests for /api/etl/run — ad-hoc ETL execution (issue #244).
 *
 * Mocks the DB helper modules (@/lib/db/manual-trigger, @/lib/db/connectors)
 * so no real Postgres is needed here — the "does a real trigger actually get
 * claimed and run" half is covered by etl/tests/test_manual_trigger.py and the
 * e2e spec. This suite pins the HTTP contract: admin gating, connector
 * validation, the single-pending 409, and status reporting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/manual-trigger", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/manual-trigger")>(
    "@/lib/db/manual-trigger",
  );
  return {
    ...actual,
    createManualTrigger: vi.fn(),
    getManualTriggerStatus: vi.fn(),
    getPendingTrigger: vi.fn(),
  };
});
vi.mock("@/lib/db/connectors", () => ({
  getConnectorRegistryInfo: vi.fn(),
}));

import { POST, GET } from "../route";
import * as trigger from "@/lib/db/manual-trigger";
import * as connectors from "@/lib/db/connectors";

const mockCreate = vi.mocked(trigger.createManualTrigger);
const mockStatus = vi.mocked(trigger.getManualTriggerStatus);
const mockPending = vi.mocked(trigger.getPendingTrigger);
const mockRegistry = vi.mocked(connectors.getConnectorRegistryInfo);

const ADMIN_KEY = "test-admin-key";

function postReq(body?: unknown, opts: { adminKey?: string } = {}): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.adminKey) headers["x-admin-key"] = opts.adminKey;
  return new NextRequest("http://localhost:4000/api/etl/run", {
    method: "POST",
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function getReq(id?: string): NextRequest {
  const url = new URL("http://localhost:4000/api/etl/run");
  if (id !== undefined) url.searchParams.set("id", id);
  return new NextRequest(url, { method: "GET" });
}

function registryRow(overrides: Record<string, unknown> = {}) {
  return {
    name: "fotocasa",
    registered: true,
    supports_discovery: true,
    supported_filters: ["rooms"],
    ...overrides,
  };
}

describe("POST /api/etl/run", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_API_KEY", ADMIN_KEY);
    vi.clearAllMocks();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns 401 without a valid admin key", async () => {
    const res = await POST(postReq({}, {}));
    expect(res.status).toBe(401);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("queues a full sweep (no connector_name) and returns the trigger id", async () => {
    mockCreate.mockResolvedValue(7);
    const res = await POST(postReq(undefined, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ trigger_id: 7, status: "pending", connector_name: null });
    // Full sweep = NULL connector_name to the queue.
    expect(mockCreate).toHaveBeenCalledWith(null);
    // A full sweep never needs to consult the registry.
    expect(mockRegistry).not.toHaveBeenCalled();
  });

  it("queues a connector-scoped run for a registered connector", async () => {
    mockRegistry.mockResolvedValue(registryRow());
    mockCreate.mockResolvedValue(9);
    const res = await POST(postReq({ connector_name: "fotocasa" }, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ trigger_id: 9, connector_name: "fotocasa" });
    expect(mockCreate).toHaveBeenCalledWith("fotocasa");
  });

  it("returns 404 for an unknown connector name", async () => {
    mockRegistry.mockResolvedValue(null);
    const res = await POST(postReq({ connector_name: "nope" }, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(404);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns 409 for a connector that is no longer registered", async () => {
    mockRegistry.mockResolvedValue(registryRow({ registered: false }));
    const res = await POST(postReq({ connector_name: "gone" }, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(409);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-string connector_name", async () => {
    const res = await POST(postReq({ connector_name: 123 }, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns 409 with the existing pending id when one is already queued", async () => {
    const uniqueViolation = Object.assign(new Error("duplicate key"), {
      code: trigger.PG_UNIQUE_VIOLATION,
    });
    mockCreate.mockRejectedValue(uniqueViolation);
    mockPending.mockResolvedValue({
      id: 3,
      status: "pending",
      connector_name: null,
      connector_run_id: null,
      error_msg: null,
      triggered_by: "dashboard",
      requested_at: "2026-08-04T00:00:00Z",
      picked_up_at: null,
      finished_at: null,
    });
    const res = await POST(postReq(undefined, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.pending_trigger_id).toBe(3);
  });
});

describe("GET /api/etl/run", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 400 without a valid id", async () => {
    const res = await GET(getReq());
    expect(res.status).toBe(400);
  });

  it("returns 404 when the trigger does not exist", async () => {
    mockStatus.mockResolvedValue(null);
    const res = await GET(getReq("999"));
    expect(res.status).toBe(404);
  });

  it("returns the trigger status row", async () => {
    mockStatus.mockResolvedValue({
      id: 5,
      status: "done",
      connector_name: "fotocasa",
      connector_run_id: 42,
      error_msg: null,
      triggered_by: "dashboard",
      requested_at: "2026-08-04T00:00:00Z",
      picked_up_at: "2026-08-04T00:00:05Z",
      finished_at: "2026-08-04T00:01:00Z",
    });
    const res = await GET(getReq("5"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: 5, status: "done", connector_run_id: 42 });
  });
});
