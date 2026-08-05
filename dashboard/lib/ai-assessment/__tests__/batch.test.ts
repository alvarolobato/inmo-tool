/**
 * #308 — assessment batch trigger, unit tests.
 *
 * These use `runAssessmentBatch`'s injectable seams (`selectPropertyIds`,
 * `isCurrent`, `flows`) so the whole trigger is exercised with NO database and
 * NO real LLM — the three exit criteria this task must prove in isolation:
 *
 *   EC-2  a property already at the current prompt version is SKIPPED, never
 *         re-billed.
 *   EC-3  a BudgetExceededError / CircuitBreakerOpenError mid-batch stops the
 *         pass CLEANLY (a summary, not a crash) and processes nothing further.
 *   + the batch calls the flows for a genuinely unassessed property, and one
 *     bad property (NoListingsError / unexpected error) never sinks the rest.
 */
import { describe, it, expect, vi } from "vitest";
import { BudgetExceededError, CircuitBreakerOpenError } from "@/lib/llm";
import { NoListingsError } from "../shared";
import {
  runAssessmentBatch,
  type BatchFlow,
} from "../batch";

/** Two fake flows so we can assert per-flow behaviour without the real LLM. */
function makeFlows(): { flows: BatchFlow[]; a: ReturnType<typeof vi.fn>; b: ReturnType<typeof vi.fn> } {
  const a = vi.fn(async () => undefined);
  const b = vi.fn(async () => undefined);
  const flows: BatchFlow[] = [
    { type: "occupancy", promptVersion: "occupancy/v2", assess: a },
    { type: "condition", promptVersion: "condition/v1", assess: b },
  ];
  return { flows, a, b };
}

describe("runAssessmentBatch", () => {
  it("runs every flow for an unassessed property", async () => {
    const { flows, a, b } = makeFlows();
    const result = await runAssessmentBatch({
      flows,
      selectPropertyIds: async () => [42],
      isCurrent: async () => false, // nothing cached → run everything
    });

    expect(a).toHaveBeenCalledWith(42, { requestId: null });
    expect(b).toHaveBeenCalledWith(42, { requestId: null });
    expect(result).toMatchObject({
      properties: 1,
      assessed: 2,
      skipped: 0,
      stopped: null,
    });
  });

  it("EC-2: skips a flow whose verdict already matches the current prompt version", async () => {
    const { flows, a, b } = makeFlows();
    // occupancy is current (stale:false), condition is not.
    const isCurrent = vi.fn(async (_id: number, flow: BatchFlow) => flow.type === "occupancy");

    const result = await runAssessmentBatch({
      flows,
      selectPropertyIds: async () => [7],
      isCurrent,
    });

    expect(a).not.toHaveBeenCalled(); // already current → no spend
    expect(b).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ properties: 1, assessed: 1, skipped: 1, stopped: null });
  });

  it("EC-3: a BudgetExceededError stops the batch cleanly, processing nothing further", async () => {
    const { flows, a, b } = makeFlows();
    a.mockRejectedValueOnce(new BudgetExceededError());

    const result = await runAssessmentBatch({
      flows,
      selectPropertyIds: async () => [1, 2, 3],
      isCurrent: async () => false,
    });

    // Stopped on the very first flow of the first property.
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled(); // never reached the second flow
    expect(result.stopped).toBe("budget");
    expect(result.properties).toBe(1); // properties 2 and 3 never examined
    expect(result.assessed).toBe(0);
  });

  it("EC-3: a CircuitBreakerOpenError also stops cleanly", async () => {
    const { flows, a } = makeFlows();
    a.mockRejectedValueOnce(new CircuitBreakerOpenError());

    const result = await runAssessmentBatch({
      flows,
      selectPropertyIds: async () => [1, 2],
      isCurrent: async () => false,
    });

    expect(result.stopped).toBe("circuit");
    expect(result.properties).toBe(1);
  });

  it("skips a property with no readable listings and carries on", async () => {
    const { flows, a, b } = makeFlows();
    a.mockRejectedValueOnce(new NoListingsError(9)); // occupancy on property 9 has nothing to read

    const result = await runAssessmentBatch({
      flows,
      selectPropertyIds: async () => [9, 10],
      isCurrent: async () => false,
    });

    // property 9: occupancy → NoListings (skip), condition → runs.
    // property 10: both flows run.
    expect(result.stopped).toBeNull();
    expect(result.noListings).toBe(1);
    expect(result.properties).toBe(2);
    expect(b).toHaveBeenCalledTimes(2); // condition ran on both properties
    expect(result.assessed).toBe(3); // 9:condition + 10:occupancy + 10:condition
  });

  it("logs and counts an unexpected per-flow error without stopping the batch", async () => {
    const { flows, a, b } = makeFlows();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    a.mockRejectedValueOnce(new Error("malformed model output"));

    const result = await runAssessmentBatch({
      flows,
      selectPropertyIds: async () => [5],
      isCurrent: async () => false,
    });

    expect(result.stopped).toBeNull();
    expect(result.errors).toBe(1);
    expect(b).toHaveBeenCalledTimes(1); // the next flow still ran
    expect(result.assessed).toBe(1);
    spy.mockRestore();
  });

  it("does nothing on an empty selection", async () => {
    const { flows, a, b } = makeFlows();
    const result = await runAssessmentBatch({
      flows,
      selectPropertyIds: async () => [],
      isCurrent: async () => false,
    });
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    expect(result).toMatchObject({ properties: 0, assessed: 0, skipped: 0, stopped: null });
  });

  it("threads the requestId into the flows", async () => {
    const { flows, a } = makeFlows();
    await runAssessmentBatch({
      flows,
      selectPropertyIds: async () => [3],
      isCurrent: async () => false,
      requestId: "req-abc",
    });
    expect(a).toHaveBeenCalledWith(3, { requestId: "req-abc" });
  });
});
