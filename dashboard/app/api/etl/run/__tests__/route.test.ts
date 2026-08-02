// @vitest-environment node
import { describe, it, expect } from "vitest";

import { POST } from "../route";

function makeRequest(body?: unknown): Request {
  const init: RequestInit = { method: "POST" };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request("http://localhost/api/etl/run", init);
}

describe("POST /api/etl/run (disabled — Phase 1 review, task 1.6/#14 follow-up)", () => {
  it("returns 501 not_implemented regardless of body", async () => {
    const res = await POST();
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error).toBe("not_implemented");
  });

  it("returns 501 even with a force_full/tables body (route ignores its input entirely)", async () => {
    // The route takes no Request argument at all now — this test just
    // documents that calling it the old way still can't accidentally
    // trigger the old behavior; makeRequest() is unused by POST() itself.
    void makeRequest({ force_full: true, tables: ["stock"] });
    const res = await POST();
    expect(res.status).toBe(501);
  });
});
