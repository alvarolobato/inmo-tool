import { describe, it, expect } from "vitest";
import { getLlmEndpointMetaEs } from "@/lib/llm-endpoint-meta";

describe("getLlmEndpointMetaEs", () => {
  it("returns Spanish copy for known endpoints", () => {
    const g = getLlmEndpointMetaEs("generateDashboard");
    expect(g.label.length).toBeGreaterThan(3);
    expect(g.detail.toLowerCase()).toContain("cuadro");
  });

  it("falls back for unknown keys and mentions the technical name", () => {
    const u = getLlmEndpointMetaEs("futureEndpoint");
    expect(u.detail).toContain("futureEndpoint");
  });
});
