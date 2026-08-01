// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { FilterCombobox, type FilterComboboxOption } from "../FilterCombobox";

// Headless UI Combobox uses ResizeObserver internally
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;

const OPTIONS: FilterComboboxOption[] = [
  { value: "CAMI", label: "Camisetas" },
  { value: "PAN", label: "Pantalones" },
  { value: "ZAP", label: "Zapatos" },
];

async function openAndType(labelText: string, typed?: string) {
  const input = screen.getByLabelText(labelText) as HTMLInputElement;
  await act(async () => {
    input.focus();
    fireEvent.focus(input);
    fireEvent.click(screen.getByLabelText(`Abrir opciones de ${labelText}`));
    if (typed !== undefined) fireEvent.change(input, { target: { value: typed } });
  });
  return input;
}

async function clickOption(text: string) {
  const opt = screen.getByText(text);
  // Headless UI's ComboboxOption uses pointer + click. Mousedown then click
  // matches the real browser flow better than click alone.
  await act(async () => {
    fireEvent.pointerDown(opt);
    fireEvent.mouseDown(opt);
    fireEvent.mouseUp(opt);
    fireEvent.click(opt);
  });
}

describe("FilterCombobox (multi)", () => {
  it("renders the search input with the filter label", () => {
    render(
      <FilterCombobox
        id="familia"
        label="Familia"
        multiple
        options={OPTIONS}
        value={[]}
        onChange={() => {}}
      />,
    );
    expect(screen.getByLabelText("Familia")).toBeInTheDocument();
  });

  it("filters options client-side when the user types", async () => {
    render(
      <FilterCombobox
        id="familia"
        label="Familia"
        multiple
        options={OPTIONS}
        value={[]}
        onChange={() => {}}
      />,
    );
    await openAndType("Familia", "cami");
    expect(screen.getByText("Camisetas")).toBeInTheDocument();
    expect(screen.queryByText("Pantalones")).not.toBeInTheDocument();
    expect(screen.queryByText("Zapatos")).not.toBeInTheDocument();
  });

  it("selecting an option emits an array with the new value", async () => {
    const onChange = vi.fn();
    render(
      <FilterCombobox
        id="familia"
        label="Familia"
        multiple
        options={OPTIONS}
        value={[]}
        onChange={onChange}
      />,
    );
    await openAndType("Familia");
    await clickOption("Camisetas");
    expect(onChange).toHaveBeenCalledWith(["CAMI"]);
  });

  it("selecting adds to an existing selection", async () => {
    const onChange = vi.fn();
    render(
      <FilterCombobox
        id="familia"
        label="Familia"
        multiple
        options={OPTIONS}
        value={["CAMI"]}
        onChange={onChange}
      />,
    );
    await openAndType("Familia");
    await clickOption("Pantalones");
    expect(onChange).toHaveBeenCalledWith(["CAMI", "PAN"]);
  });

  it("clicking the chip × button removes that value", () => {
    const onChange = vi.fn();
    render(
      <FilterCombobox
        id="familia"
        label="Familia"
        multiple
        options={OPTIONS}
        value={["CAMI", "PAN"]}
        onChange={onChange}
      />,
    );
    const chip = screen.getByTestId("filter-chip-familia-CAMI");
    fireEvent.click(within(chip).getByRole("button", { name: /Quitar Camisetas/ }));
    expect(onChange).toHaveBeenCalledWith(["PAN"]);
  });

  it("Limpiar clears all selections", () => {
    const onChange = vi.fn();
    render(
      <FilterCombobox
        id="familia"
        label="Familia"
        multiple
        options={OPTIONS}
        value={["CAMI", "PAN"]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Limpiar selección/ }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("pressing Escape resets the search query", async () => {
    render(
      <FilterCombobox
        id="familia"
        label="Familia"
        multiple
        options={OPTIONS}
        value={[]}
        onChange={() => {}}
      />,
    );
    const input = await openAndType("Familia", "cami");
    expect(input.value).toBe("cami");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
  });

  it("shows 'Sin resultados' when no option matches the query", async () => {
    render(
      <FilterCombobox
        id="familia"
        label="Familia"
        multiple
        options={OPTIONS}
        value={[]}
        onChange={() => {}}
      />,
    );
    await openAndType("Familia", "xxyyzz");
    expect(screen.getByText("Sin resultados")).toBeInTheDocument();
  });
});

describe("FilterCombobox (single)", () => {
  it("emits empty string when 'Todos' is picked", async () => {
    const onChange = vi.fn();
    render(
      <FilterCombobox
        id="tienda"
        label="Tienda"
        options={OPTIONS}
        value="CAMI"
        onChange={onChange}
      />,
    );
    await openAndType("Tienda");
    await clickOption("Todos");
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("emits the selected option's value", async () => {
    const onChange = vi.fn();
    render(
      <FilterCombobox
        id="tienda"
        label="Tienda"
        options={OPTIONS}
        value=""
        onChange={onChange}
      />,
    );
    await openAndType("Tienda");
    await clickOption("Pantalones");
    expect(onChange).toHaveBeenCalledWith("PAN");
  });
});
