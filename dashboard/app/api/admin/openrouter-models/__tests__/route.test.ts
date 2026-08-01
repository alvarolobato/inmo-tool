// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { GET } from "../route";
import { resetCatalogCache } from "../catalog";

// The route requires admin auth; stub it so tests don't fail on cookie checks.
vi.mock("@/lib/admin-api-auth", () => ({
  adminApiKeyValid: () => true,
  adminUnauthorized: () => new Response("unauthorized", { status: 401 }),
}));

const SAMPLE_CATALOG = {
  data: [
    {
      id: "anthropic/claude-sonnet-4",
      name: "Anthropic: Claude Sonnet 4",
      description: "Strong reasoning model.",
      context_length: 200_000,
      pricing: { prompt: "0.000003", completion: "0.000015" },
      architecture: { modality: "text+image->text" },
      supported_parameters: ["tools", "tool_choice", "temperature"],
      links: { details: "/api/v1/models/anthropic/claude-sonnet-4/endpoints" },
    },
    {
      id: "obscure/some-model",
      name: "Obscure model",
      description: "x".repeat(400),
      context_length: 8_000,
      pricing: { prompt: "0.0000001", completion: "0.0000002" },
      architecture: { modality: "text->text" },
      supported_parameters: ["temperature"],
      links: { details: "/api/v1/models/obscure/some-model/endpoints" },
    },
  ],
};

const fakeRequest = () => new Request("http://test/api/admin/openrouter-models");

describe("GET /api/admin/openrouter-models", () => {
  beforeEach(() => {
    resetCatalogCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/endpoints")) {
          return new Response(JSON.stringify({ data: { endpoints: [] } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify(SAMPLE_CATALOG), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalises pricing to USD per million tokens", async () => {
    const res = await GET(fakeRequest() as never);
    const body = await res.json();
    const sonnet = body.models.find(
      (m: { model_id: string; is_auto_row: boolean }) =>
        m.model_id === "anthropic/claude-sonnet-4" && m.is_auto_row,
    );
    expect(sonnet.prompt_price_per_1m).toBeCloseTo(3, 5);
    expect(sonnet.completion_price_per_1m).toBeCloseTo(15, 5);
  });

  it("flags curated popular models", async () => {
    const res = await GET(fakeRequest() as never);
    const body = await res.json();
    const sonnet = body.models.find(
      (m: { model_id: string; is_auto_row: boolean }) =>
        m.model_id === "anthropic/claude-sonnet-4" && m.is_auto_row,
    );
    const obscure = body.models.find(
      (m: { model_id: string; is_auto_row: boolean }) =>
        m.model_id === "obscure/some-model" && m.is_auto_row,
    );
    expect(sonnet.popular).toBe(true);
    expect(obscure.popular).toBe(false);
  });

  it("derives supports_tools from supported_parameters", async () => {
    const res = await GET(fakeRequest() as never);
    const body = await res.json();
    const sonnet = body.models.find(
      (m: { model_id: string; is_auto_row: boolean }) =>
        m.model_id === "anthropic/claude-sonnet-4" && m.is_auto_row,
    );
    const obscure = body.models.find(
      (m: { model_id: string; is_auto_row: boolean }) =>
        m.model_id === "obscure/some-model" && m.is_auto_row,
    );
    expect(sonnet.supports_tools).toBe(true);
    expect(obscure.supports_tools).toBe(false);
  });

  it("trims long descriptions", async () => {
    const res = await GET(fakeRequest() as never);
    const body = await res.json();
    const obscure = body.models.find(
      (m: { model_id: string; is_auto_row: boolean }) =>
        m.model_id === "obscure/some-model" && m.is_auto_row,
    );
    expect(obscure.description.length).toBeLessThanOrEqual(220);
    expect(obscure.description.endsWith("…")).toBe(true);
  });

  it("uses the in-process cache on subsequent requests", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await GET(fakeRequest() as never);
    await GET(fakeRequest() as never);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const res = await GET(fakeRequest() as never);
    const body = await res.json();
    expect(body.source).toBe("cache");
  });

  it("falls back to stale cache when OpenRouter is unreachable", async () => {
    await GET(fakeRequest() as never);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream down", { status: 502 })),
    );
    resetCatalogCache();
    // Re-warm so we have a stale cache on the next failure.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/endpoints")) {
          return new Response(JSON.stringify({ data: { endpoints: [] } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify(SAMPLE_CATALOG), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    await GET(fakeRequest() as never);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const res = await GET(fakeRequest() as never);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.source).toBe("cache");
    expect(Array.isArray(body.models)).toBe(true);
  });
});
