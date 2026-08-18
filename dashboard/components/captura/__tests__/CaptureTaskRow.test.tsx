// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { CaptureTaskRow } from "../CaptureTaskRow";
import type { CaptureTask } from "@/lib/captura-tasks";

function task(over: Partial<CaptureTask> = {}): CaptureTask {
  return {
    id: "t1",
    portal: "aliseda",
    label: "Aliseda",
    url: "https://www.alisedainmobiliaria.com/venta",
    captureUrl: "https://www.alisedainmobiliaria.com/venta",
    loosened: [],
    ...over,
  };
}

describe("CaptureTaskRow", () => {
  it("renders the label, last-done note and an active button when not muted", () => {
    render(
      <CaptureTaskRow
        task={task()}
        muted={false}
        lastDone="nunca"
        lastRunAt={null}
        onExecute={vi.fn()}
        checked={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText("Aliseda")).toBeInTheDocument();
    expect(screen.getByTestId("captura-task-lastdone-t1")).toHaveTextContent("nunca");
    expect(screen.getByTestId("captura-task-run-t1")).toHaveTextContent("Abrir búsqueda");
    expect(screen.getByTestId("captura-task-t1")).toHaveAttribute("data-muted", "false");
    // No "hecho" badge while active.
    expect(screen.queryByTestId("captura-task-done-badge-t1")).toBeNull();
  });

  it("shows the 'hecho' badge, a Repetir button and data-muted when muted", () => {
    render(
      <CaptureTaskRow
        task={task()}
        muted
        lastDone="hecho hace 2 días"
        lastRunAt="2026-08-03T00:00:00.000Z"
        onExecute={vi.fn()}
        checked={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByTestId("captura-task-t1")).toHaveAttribute("data-muted", "true");
    expect(screen.getByTestId("captura-task-done-badge-t1")).toBeInTheDocument();
    expect(screen.getByTestId("captura-task-run-t1")).toHaveTextContent("Repetir");
    // Muted rows are still clickable (graying is a cue, not a block).
    expect(screen.getByTestId("captura-task-run-t1")).toBeEnabled();
  });

  it("renders loosened flags inline", () => {
    render(
      <CaptureTaskRow
        task={task({ loosened: [{ constraint: "geography", reason: "radio ampliado a la ciudad" }] })}
        muted={false}
        lastDone="nunca"
        lastRunAt={null}
        onExecute={vi.fn()}
        checked={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByTestId("captura-task-loosened-t1")).toHaveTextContent("radio ampliado a la ciudad");
  });

  it("calls onExecute with the task on click", async () => {
    let resolve!: () => void;
    const onExecute = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(
      <CaptureTaskRow
        task={task()}
        muted={false}
        lastDone="nunca"
        lastRunAt={null}
        onExecute={onExecute}
        checked={false}
        onToggle={vi.fn()}
      />,
    );
    const btn = screen.getByTestId("captura-task-run-t1");
    fireEvent.click(btn);
    expect(onExecute).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }));
    // While the promise is pending the button shows a busy state and is disabled.
    await waitFor(() => expect(btn).toBeDisabled());
    expect(btn).toHaveTextContent("Abriendo…");
    resolve();
    await waitFor(() => expect(btn).toBeEnabled());
  });

  it("ignores a second click while busy", async () => {
    let resolve!: () => void;
    const onExecute = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(
      <CaptureTaskRow
        task={task()}
        muted={false}
        lastDone="nunca"
        lastRunAt={null}
        onExecute={onExecute}
        checked={false}
        onToggle={vi.fn()}
      />,
    );
    const btn = screen.getByTestId("captura-task-run-t1");
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onExecute).toHaveBeenCalledTimes(1);
    resolve();
    await waitFor(() => expect(btn).toBeEnabled());
  });

  it("reflects the checked prop and calls onToggle with the task id (issue #556)", () => {
    const onToggle = vi.fn();
    render(
      <CaptureTaskRow
        task={task()}
        muted={false}
        lastDone="nunca"
        lastRunAt={null}
        onExecute={vi.fn()}
        checked
        onToggle={onToggle}
      />,
    );
    const check = screen.getByTestId("captura-task-check-t1");
    expect(check).toBeChecked();
    fireEvent.click(check);
    expect(onToggle).toHaveBeenCalledWith("t1");
  });

  it("renders the checkbox unchecked when checked=false", () => {
    render(
      <CaptureTaskRow
        task={task()}
        muted={false}
        lastDone="nunca"
        lastRunAt={null}
        onExecute={vi.fn()}
        checked={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByTestId("captura-task-check-t1")).not.toBeChecked();
  });
});
