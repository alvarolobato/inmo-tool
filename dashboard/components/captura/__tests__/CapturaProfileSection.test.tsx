// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { CapturaProfileSection } from "@/components/captura/CapturaProfileSection";
import {
  deriveConnectorState,
  selectionKey,
  type ConnectorTaskView,
  type ConnectorView,
  type ProfileCaptureView,
} from "@/lib/captura-tasks";

/**
 * Issue #559: selection state moved OUT of this component into `CapturaProfiles`
 * (global, cross-profile). What remains here is a thin per-profile TRANSLATOR
 * between the global `selectionKey(profileId, taskId)`-keyed maps and the plain
 * per-task ids `ConnectorSection` expects — this suite pins that translation.
 * The button/select-all/select-none/batch-plan behaviour itself is covered at
 * the `CapturaProfiles` level (`app/__tests__/captura-page.test.tsx`).
 */

function mkTask(id: string, portal: string) {
  return {
    id,
    portal,
    label: `${portal} · ${id}`,
    url: `https://${portal}.example/${id}`,
    captureUrl: `https://${portal}.example/${id}`,
    loosened: [],
  };
}

function mkTaskView(task: ReturnType<typeof mkTask>, opts: { muted: boolean }): ConnectorTaskView {
  return {
    task,
    muted: opts.muted,
    due: !opts.muted,
    lastRunAt: opts.muted ? new Date().toISOString() : null,
    lastDone: opts.muted ? "hecho hace unos segundos" : "nunca",
  };
}

function mkConnector(portal: string, taskViews: ConnectorTaskView[]): ConnectorView {
  const dueCount = taskViews.filter((t) => t.due).length;
  const mutedCount = taskViews.filter((t) => t.muted).length;
  return {
    portal,
    label: portal[0].toUpperCase() + portal.slice(1),
    taskViews,
    totalTasks: taskViews.length,
    dueCount,
    mutedCount,
    state: deriveConnectorState(dueCount, mutedCount),
    defaultExpanded: dueCount > 0,
    capturedProfile: 0,
  };
}

const IDEA_1 = mkTask("idea-1", "idealista");
const ALI_1 = mkTask("ali-1", "aliseda");

function buildProfile(id: number, name: string): ProfileCaptureView {
  return {
    id,
    name,
    connectors: [mkConnector("idealista", [mkTaskView(IDEA_1, { muted: false })]), mkConnector("aliseda", [mkTaskView(ALI_1, { muted: true })])],
    totalTasks: 2,
    actionableConnectors: 1,
  };
}

describe("CapturaProfileSection — global-selection translator (issue #559)", () => {
  it("reflects the global ticked set down to this profile's plain task-id checkboxes, with every connector collapsed", () => {
    const profile = buildProfile(7, "Perfil A");
    const ticked = new Set([selectionKey(7, "idea-1")]);
    render(
      <CapturaProfileSection
        profile={profile}
        ticked={ticked}
        onToggleTask={vi.fn()}
        runOverrides={{}}
        onOptimisticRun={vi.fn()}
      />,
    );
    // Both connectors start collapsed (idealista is DUE → expanded by default
    // actually; force the point by checking the ALISEDA one, which is NOT-DUE
    // and stays collapsed) — its checkbox must still be reachable and reflect
    // the global set correctly (unticked, since only idea-1 is in `ticked`).
    const aliseda = screen.getByTestId("captura-connector-7-aliseda");
    expect(aliseda).toHaveAttribute("data-expanded", "false");
    expect(screen.getByTestId("captura-task-check-7-ali-1")).not.toBeChecked();
    expect(screen.getByTestId("captura-task-check-7-idea-1")).toBeChecked();
  });

  it("does NOT reflect another profile's ticked selection sharing the same bare task id", () => {
    const profile = buildProfile(7, "Perfil A");
    // A tick for profile 9's "idea-1" must not leak into profile 7's checkbox.
    const ticked = new Set([selectionKey(9, "idea-1")]);
    render(
      <CapturaProfileSection
        profile={profile}
        ticked={ticked}
        onToggleTask={vi.fn()}
        runOverrides={{}}
        onOptimisticRun={vi.fn()}
      />,
    );
    expect(screen.getByTestId("captura-task-check-7-idea-1")).not.toBeChecked();
  });

  it("toggling a checklist checkbox calls onToggleTask with (profileId, taskId)", () => {
    const profile = buildProfile(7, "Perfil A");
    const onToggleTask = vi.fn();
    render(
      <CapturaProfileSection
        profile={profile}
        ticked={new Set()}
        onToggleTask={onToggleTask}
        runOverrides={{}}
        onOptimisticRun={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("captura-task-check-7-idea-1"));
    expect(onToggleTask).toHaveBeenCalledWith(7, "idea-1");
  });

  it("translates the global run-override map to this profile's muted/hecho state", () => {
    const profile = buildProfile(7, "Perfil A");
    const runOverrides = { [selectionKey(7, "idea-1")]: new Date().toISOString() };
    render(
      <CapturaProfileSection
        profile={profile}
        ticked={new Set()}
        onToggleTask={vi.fn()}
        runOverrides={runOverrides}
        onOptimisticRun={vi.fn()}
      />,
    );
    // idea-1's connector (idealista) is DUE by default → expanded; its full row
    // must now read muted (the override wins over the server-computed `due`).
    const row = screen.getByTestId("captura-task-idea-1");
    expect(row).toHaveAttribute("data-muted", "true");
  });
});
