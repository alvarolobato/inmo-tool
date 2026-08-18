"use client";

import { useMemo } from "react";
import { ConnectorSection } from "@/components/captura/ConnectorSection";
import { allProfileTasks, selectionKey, type ProfileCaptureView } from "@/lib/captura-tasks";

/**
 * One profile's stacked connectors on `/captura` (issue #413).
 *
 * The "Capturar todo" selection + batch button (issue #556) used to be owned
 * HERE, per profile. The owner rejected that shape (issue #559): he asked for
 * ONE global button and ONE global select-all/none across every profile
 * shown, not one pair per profile. That state now lives one level up, in
 * `CapturaProfiles`, keyed by the cross-profile `selectionKey(profileId,
 * taskId)` (see `lib/captura-tasks.ts` — a bare `CaptureTask.id` is only
 * unique WITHIN one profile's filter scope, so two different profiles can
 * legitimately share a task id).
 *
 * This component is now a thin per-profile TRANSLATOR: it maps the global,
 * cross-profile selection/override maps down to the plain per-task ids
 * `ConnectorSection` (and `CaptureTaskRow` beneath it) already work with — so
 * neither of those two components needed any change to their own selection
 * API. It renders no controls of its own; the connectors are the whole body.
 */
export function CapturaProfileSection({
  profile,
  ticked,
  onToggleTask,
  runOverrides,
  onOptimisticRun,
}: {
  profile: ProfileCaptureView;
  /** Global ticked set, keyed by `selectionKey(profileId, taskId)` — owned by `CapturaProfiles`. */
  ticked: ReadonlySet<string>;
  /** Toggle one of THIS profile's tasks in the global selection. */
  onToggleTask: (profileId: number, taskId: string) => void;
  /** Global optimistic run overrides, keyed the same way as `ticked`. */
  runOverrides: Readonly<Record<string, string>>;
  /** Record an optimistic run for one of THIS profile's tasks. */
  onOptimisticRun: (profileId: number, taskId: string, lastRunAt: string) => void;
}) {
  const localChecked = useMemo(() => {
    const s = new Set<string>();
    for (const t of allProfileTasks(profile.connectors)) {
      if (ticked.has(selectionKey(profile.id, t.id))) s.add(t.id);
    }
    return s;
  }, [profile, ticked]);

  const localOverrides = useMemo(() => {
    const o: Record<string, string> = {};
    for (const t of allProfileTasks(profile.connectors)) {
      const v = runOverrides[selectionKey(profile.id, t.id)];
      if (v) o[t.id] = v;
    }
    return o;
  }, [profile, runOverrides]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {profile.connectors.map((connector) => (
        <ConnectorSection
          key={connector.portal}
          profileId={profile.id}
          connector={connector}
          checkedTaskIds={localChecked}
          onToggleTask={(taskId) => onToggleTask(profile.id, taskId)}
          runOverrides={localOverrides}
          onOptimisticRun={(taskId, lastRunAt) => onOptimisticRun(profile.id, taskId, lastRunAt)}
        />
      ))}
    </div>
  );
}
