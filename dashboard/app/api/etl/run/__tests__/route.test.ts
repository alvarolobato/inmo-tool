// @vitest-environment node
import { describe, it, expect } from "vitest";

import { POST } from "../route";

describe("POST /api/etl/run (disabled — Phase 1 review, task 1.6/#14 follow-up)", () => {
  it("returns 501 not_implemented with a message pointing at the real trigger", async () => {
    const res = await POST();
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error).toBe("not_implemented");
    expect(body.detail).toMatch(/ps connector run/);
  });
});
