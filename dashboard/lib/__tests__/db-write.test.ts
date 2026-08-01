import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock pg before importing anything that uses it
const mockQuery = vi.fn();
const mockRelease = vi.fn();
const mockClient = { query: mockQuery, release: mockRelease };
const mockConnect = vi.fn().mockResolvedValue(mockClient);
const mockEnd = vi.fn().mockResolvedValue(undefined);

vi.mock("pg", () => ({
  Pool: class {
    connect = mockConnect;
    end = mockEnd;
    query = vi.fn();
  },
}));

import { withTransaction, resetPool } from "../db-write";

describe("withTransaction", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    mockConnect.mockResolvedValue(mockClient);
    mockQuery.mockResolvedValue({ rows: [] });
    await resetPool();
  });

  it("commits on success and releases client", async () => {
    const fn = vi.fn(async () => "result");
    const result = await withTransaction(fn);

    expect(result).toBe("result");
    expect(mockConnect).toHaveBeenCalledOnce();
    expect(mockQuery).toHaveBeenCalledWith("BEGIN");
    expect(fn).toHaveBeenCalledWith(mockClient);
    expect(mockQuery).toHaveBeenCalledWith("COMMIT");
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it("rolls back and rethrows on error", async () => {
    const error = new Error("db failure");
    const fn = vi.fn(async () => {
      throw error;
    });

    await expect(withTransaction(fn)).rejects.toThrow("db failure");

    expect(mockQuery).toHaveBeenCalledWith("BEGIN");
    expect(mockQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(mockRelease).toHaveBeenCalledOnce();
    const calls = mockQuery.mock.calls.map((c) => c[0]);
    expect(calls).not.toContain("COMMIT");
  });

  it("releases client even when rollback itself throws", async () => {
    const error = new Error("fn error");

    const fn = vi.fn(async () => {
      throw error;
    });

    mockQuery.mockImplementation((sql: string) => {
      if (sql === "ROLLBACK") return Promise.reject(new Error("rollback failed"));
      return Promise.resolve({ rows: [] });
    });

    await expect(withTransaction(fn)).rejects.toThrow("fn error");
    expect(mockRelease).toHaveBeenCalledOnce();
  });
});
