// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ForceResyncDialog } from "../ForceResyncDialog";

describe("ForceResyncDialog", () => {
  it("does not render when closed", () => {
    render(
      <ForceResyncDialog open={false} onClose={() => {}} onConfirm={() => {}} />,
    );
    expect(screen.queryByTestId("force-resync-dialog")).not.toBeInTheDocument();
  });

  it("renders defaults selected and confirms them", () => {
    const onConfirm = vi.fn();
    render(
      <ForceResyncDialog
        open={true}
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByTestId("force-resync-dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("force-confirm-button"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const call = onConfirm.mock.calls[0]![0]!;
    expect(call.forceFull).toBe(false);
    // defaults: stock, ventas, lineas_ventas
    expect(call.tables.sort()).toEqual(["lineas_ventas", "stock", "ventas"]);
  });

  it("force_full disables the per-table checkboxes and clears tables", () => {
    const onConfirm = vi.fn();
    render(
      <ForceResyncDialog
        open={true}
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByTestId("force-full-checkbox"));
    fireEvent.click(screen.getByTestId("force-confirm-button"));
    const call = onConfirm.mock.calls[0]![0]!;
    expect(call.forceFull).toBe(true);
    expect(call.tables).toEqual([]);
  });

  it("allows toggling individual tables", () => {
    const onConfirm = vi.fn();
    render(
      <ForceResyncDialog
        open={true}
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );

    // Deselect 'stock' and add 'gc_albaranes'
    fireEvent.click(screen.getByTestId("force-table-stock"));
    fireEvent.click(screen.getByTestId("force-table-gc_albaranes"));

    fireEvent.click(screen.getByTestId("force-confirm-button"));
    const call = onConfirm.mock.calls[0]![0]!;
    expect(call.forceFull).toBe(false);
    expect(call.tables.sort()).toEqual([
      "gc_albaranes",
      "lineas_ventas",
      "ventas",
    ]);
  });

  it("confirm button is disabled when no tables selected and force_full is off", () => {
    const onConfirm = vi.fn();
    render(
      <ForceResyncDialog
        open={true}
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );

    // Deselect all three defaults
    fireEvent.click(screen.getByTestId("force-table-stock"));
    fireEvent.click(screen.getByTestId("force-table-ventas"));
    fireEvent.click(screen.getByTestId("force-table-lineas_ventas"));

    const btn = screen.getByTestId(
      "force-confirm-button",
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("Escape calls onClose", () => {
    const onClose = vi.fn();
    render(
      <ForceResyncDialog open={true} onClose={onClose} onConfirm={() => {}} />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
