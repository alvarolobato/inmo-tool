// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import {
  EnumSelect,
  PROVIDER_OPTIONS,
  CLAUDE_CLI_MODEL_OPTIONS,
} from "../EnumSelect";

describe("EnumSelect", () => {
  it("renders each option label", () => {
    render(
      <EnumSelect value="cli" onChange={() => {}} options={PROVIDER_OPTIONS} />,
    );
    expect(screen.getByText(/Claude Code CLI/)).toBeInTheDocument();
    expect(screen.getByText(/OpenRouter/)).toBeInTheDocument();
  });

  it("calls onChange with the selected value", () => {
    const onChange = vi.fn();
    render(
      <EnumSelect value="cli" onChange={onChange} options={PROVIDER_OPTIONS} />,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "openrouter" } });
    expect(onChange).toHaveBeenCalledWith("openrouter");
  });

  it("CLAUDE_CLI_MODEL_OPTIONS exposes Sonnet, Opus, and Haiku tiers", () => {
    const labels = CLAUDE_CLI_MODEL_OPTIONS.map((o) => o.label).join(" | ");
    expect(labels).toMatch(/Opus/);
    expect(labels).toMatch(/Sonnet/);
    expect(labels).toMatch(/Haiku/);
    // Ids should be native Claude format (no slash like the OpenRouter ones).
    for (const o of CLAUDE_CLI_MODEL_OPTIONS) {
      expect(o.value).not.toContain("/");
    }
  });
});
