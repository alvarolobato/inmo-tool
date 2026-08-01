// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { RunList } from "../RunList";
import type { EtlSyncRun } from "../RunList";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeRun(overrides: Partial<EtlSyncRun> = {}): EtlSyncRun {
  return {
    id: 1,
    started_at: "2026-04-10T02:00:00Z",
    finished_at: "2026-04-10T03:00:00Z",
    duration_ms: 3600000,
    status: "success",
    total_tables: 22,
    tables_ok: 22,
    tables_failed: 0,
    total_rows_synced: 45000,
    trigger: "scheduled",
    kind: "full",
    ...overrides,
  };
}

const RUNS: EtlSyncRun[] = [
  makeRun({ id: 1, status: "success" }),
  makeRun({ id: 2, status: "partial", tables_failed: 2, tables_ok: 20 }),
  makeRun({ id: 3, status: "failed", duration_ms: null, total_rows_synced: null }),
  makeRun({ id: 4, status: "running", finished_at: null, duration_ms: null }),
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("RunList", () => {
  it("shows loading skeleton when loading=true", () => {
    render(
      <RunList runs={[]} total={0} page={1} perPage={20} loading={true} onPageChange={() => {}} />
    );
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("shows empty state when runs is empty and not loading", () => {
    render(
      <RunList runs={[]} total={0} page={1} perPage={20} loading={false} onPageChange={() => {}} />
    );
    expect(screen.getByTestId("run-list-empty")).toBeInTheDocument();
  });

  it("renders run rows", () => {
    render(
      <RunList runs={RUNS} total={4} page={1} perPage={20} loading={false} onPageChange={() => {}} />
    );
    expect(screen.getByTestId("run-list")).toBeInTheDocument();
    expect(screen.getByTestId("run-row-1")).toBeInTheDocument();
    expect(screen.getByTestId("run-row-2")).toBeInTheDocument();
    expect(screen.getByTestId("run-row-3")).toBeInTheDocument();
    expect(screen.getByTestId("run-row-4")).toBeInTheDocument();
  });

  it("shows correct status badges", () => {
    render(
      <RunList runs={RUNS} total={4} page={1} perPage={20} loading={false} onPageChange={() => {}} />
    );
    expect(screen.getByText("Completado")).toBeInTheDocument();
    expect(screen.getByText("Parcial")).toBeInTheDocument();
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText("En curso")).toBeInTheDocument();
  });

  it("renders pagination controls", () => {
    render(
      <RunList runs={RUNS} total={50} page={2} perPage={20} loading={false} onPageChange={() => {}} />
    );
    expect(screen.getByTestId("pagination")).toBeInTheDocument();
    expect(screen.getByTestId("prev-page")).toBeInTheDocument();
    expect(screen.getByTestId("next-page")).toBeInTheDocument();
  });

  it("calls onPageChange when Next is clicked", () => {
    const onPageChange = vi.fn();
    render(
      <RunList runs={RUNS} total={50} page={1} perPage={20} loading={false} onPageChange={onPageChange} />
    );
    fireEvent.click(screen.getByTestId("next-page"));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("calls onPageChange when Previous is clicked", () => {
    const onPageChange = vi.fn();
    render(
      <RunList runs={RUNS} total={50} page={3} perPage={20} loading={false} onPageChange={onPageChange} />
    );
    fireEvent.click(screen.getByTestId("prev-page"));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("disables Previous on page 1", () => {
    render(
      <RunList runs={RUNS} total={50} page={1} perPage={20} loading={false} onPageChange={() => {}} />
    );
    expect(screen.getByTestId("prev-page")).toBeDisabled();
  });

  it("disables Next on last page", () => {
    render(
      <RunList runs={RUNS} total={4} page={1} perPage={20} loading={false} onPageChange={() => {}} />
    );
    expect(screen.getByTestId("next-page")).toBeDisabled();
  });

  it("shows — when duration_ms is null", () => {
    render(
      <RunList
        runs={[makeRun({ id: 5, duration_ms: null })]}
        total={1} page={1} perPage={20} loading={false} onPageChange={() => {}}
      />
    );
    // The "—" char should appear for duration
    const row = screen.getByTestId("run-row-5");
    expect(row.textContent).toContain("—");
  });

  it("shows tables ratio", () => {
    render(
      <RunList
        runs={[makeRun({ id: 6, tables_ok: 20, tables_failed: 2 })]}
        total={1} page={1} perPage={20} loading={false} onPageChange={() => {}}
      />
    );
    const row = screen.getByTestId("run-row-6");
    expect(row.textContent).toContain("20 / 2");
  });

  it("each row contains a link to /etl/[id]", () => {
    render(
      <RunList runs={RUNS} total={4} page={1} perPage={20} loading={false} onPageChange={() => {}} />
    );
    const links = screen.getAllByRole("link");
    const etlLinks = links.filter((l) => l.getAttribute("href")?.startsWith("/etl/"));
    expect(etlLinks.length).toBeGreaterThan(0);
  });
});
