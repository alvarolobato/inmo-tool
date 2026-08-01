// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { OpenRouterModelCombobox } from "../OpenRouterModelCombobox";

const SAMPLE = {
  models: [
    {
      row_key: "anthropic/claude-sonnet-4",
      config_value: "anthropic/claude-sonnet-4",
      model_id: "anthropic/claude-sonnet-4",
      provider_label: "OpenRouter (automático)",
      is_auto_row: true,
      name: "Anthropic: Claude Sonnet 4",
      description: "Strong reasoning model.",
      context_length: 200_000,
      prompt_price_per_1m: 3,
      completion_price_per_1m: 15,
      modality: "text+image->text",
      supports_tools: true,
      popular: true,
    },
    {
      row_key: "anthropic/claude-sonnet-4\t" + JSON.stringify({ only: ["acme/fp8"], allow_fallbacks: false }),
      config_value: "anthropic/claude-sonnet-4\t" + JSON.stringify({ only: ["acme/fp8"], allow_fallbacks: false }),
      model_id: "anthropic/claude-sonnet-4",
      provider_label: "Acme · fp8",
      is_auto_row: false,
      name: "Anthropic: Claude Sonnet 4",
      description: "Strong reasoning model.",
      context_length: 200_000,
      prompt_price_per_1m: 2,
      completion_price_per_1m: 10,
      modality: "text+image->text",
      supports_tools: true,
      popular: false,
    },
    {
      row_key: "openai/gpt-4o-mini",
      config_value: "openai/gpt-4o-mini",
      model_id: "openai/gpt-4o-mini",
      provider_label: "OpenRouter (automático)",
      is_auto_row: true,
      name: "OpenAI: GPT-4o mini",
      description: "Cheap and fast.",
      context_length: 128_000,
      prompt_price_per_1m: 0.15,
      completion_price_per_1m: 0.6,
      modality: "text+image->text",
      supports_tools: true,
      popular: true,
    },
    {
      row_key: "obscure/some-model",
      config_value: "obscure/some-model",
      model_id: "obscure/some-model",
      provider_label: "OpenRouter (automático)",
      is_auto_row: true,
      name: "Obscure model",
      description: "Not popular.",
      context_length: 8_000,
      prompt_price_per_1m: 0.1,
      completion_price_per_1m: 0.2,
      modality: "text->text",
      supports_tools: false,
      popular: false,
    },
  ],
  cached_at: "2026-05-03T00:00:00Z",
  source: "cache",
};

describe("OpenRouterModelCombobox", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(SAMPLE), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the current value when closed", () => {
    render(
      <OpenRouterModelCombobox value="anthropic/claude-sonnet-4" onChange={() => {}} />,
    );
    expect(screen.getByText("anthropic/claude-sonnet-4")).toBeInTheDocument();
  });

  it("opens the catalog and shows Populares section first", async () => {
    render(<OpenRouterModelCombobox value="" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByText("Populares (router automático)")).toBeInTheDocument();
    });
    // Same display name appears on the auto row and the pinned-provider row.
    expect(screen.getAllByText("Anthropic: Claude Sonnet 4").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("OpenAI: GPT-4o mini")).toBeInTheDocument();
    expect(screen.getByText("Todos los modelos y proveedores")).toBeInTheDocument();
    expect(screen.getByText("Obscure model")).toBeInTheDocument();
  });

  it("filters by query, matching id and name", async () => {
    render(<OpenRouterModelCombobox value="" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button"));

    const search = await screen.findByTestId("or-model-combobox-search");
    fireEvent.change(search, { target: { value: "obscure" } });

    await waitFor(() => {
      expect(screen.getByText("Obscure model")).toBeInTheDocument();
    });
    expect(screen.queryAllByText("Anthropic: Claude Sonnet 4")).toHaveLength(0);
  });

  it("filters by provider label", async () => {
    render(<OpenRouterModelCombobox value="" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button"));
    const search = await screen.findByTestId("or-model-combobox-search");
    fireEvent.change(search, { target: { value: "Acme" } });
    await waitFor(() => {
      expect(screen.getByText("Acme · fp8")).toBeInTheDocument();
    });
    expect(screen.queryByText("OpenAI: GPT-4o mini")).not.toBeInTheDocument();
  });

  it("calls onChange with the config value when a row is picked", async () => {
    const onChange = vi.fn();
    render(<OpenRouterModelCombobox value="" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button"));

    const row = await screen.findByTestId("or-model-row-anthropic/claude-sonnet-4");
    fireEvent.click(row);

    expect(onChange).toHaveBeenCalledWith("anthropic/claude-sonnet-4");
  });

  it("falls back to a plain text input when the catalog fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 502 })),
    );
    const onChange = vi.fn();
    render(<OpenRouterModelCombobox value="claude" onChange={onChange} />);

    const input = await screen.findByPlaceholderText("anthropic/claude-sonnet-4", { timeout: 5000 });
    expect(input).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe("claude");
  });
});
