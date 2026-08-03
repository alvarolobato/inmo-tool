import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockListProfileOverviews } = vi.hoisted(() => ({ mockListProfileOverviews: vi.fn() }));
vi.mock("@/lib/db/profile-overview", () => ({
  listProfileOverviews: mockListProfileOverviews,
}));

import { GET } from "../route";

beforeEach(() => {
  mockListProfileOverviews.mockReset();
});

describe("GET /api/profiles/overview (issue #192)", () => {
  it("returns the overview list as-is, ok:true and ok:false entries alike", async () => {
    const overviews = [
      { ok: true, profile: { id: 1, name: "A" }, metrics: { matched_count: 3 } },
      { ok: false, id: 2, name: "B roto", issues: ["scope.geography: Required"] },
    ];
    mockListProfileOverviews.mockResolvedValue(overviews);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(overviews);
  });

  it("returns 500 with a sanitized error when the query fails, rather than throwing out of the route", async () => {
    mockListProfileOverviews.mockRejectedValue(new Error("connection to postgres://user:secret@host lost"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET();
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.code).toBe("DB_QUERY");
    expect(json.details).not.toContain("secret");
    consoleErrorSpy.mockRestore();
  });
});
