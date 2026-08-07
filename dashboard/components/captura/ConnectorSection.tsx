"use client";

import { useMemo, useState } from "react";
import { CaptureTaskRow } from "@/components/captura/CaptureTaskRow";
import { lastDoneLabel, relativeAgo, type ConnectorView } from "@/lib/captura-tasks";
import type { CaptureTask } from "@/lib/captura-tasks";
import { withCaptureSignal } from "@/lib/extension-capture";

/**
 * One collapsible CONNECTOR (portal) under a profile on the redesigned Captura
 * page (issue #413).
 *
 * The server computes each connector's state + `defaultExpanded` (see
 * lib/captura-tasks `buildConnectorViews`): a connector is expanded by default
 * when it is DUE (nothing done this cycle) or A-MEDIAS (a batch started but not
 * finished — some tasks done, some pending); it is collapsed when everything is
 * "al día". The operator can always toggle manually — collapsing something due
 * or expanding something not-due to run it anyway.
 *
 * Collapsed = a single stats line (per-profile task counts + portal-global real
 * captures). Expanded = the same header plus every task row (the launch-capture
 * buttons). Executing a task records the run (POST) then opens its pre-filtered
 * URL tagged with the auto-start signal — identical to the old page's flow, just
 * scoped to this connector's profile.
 */

const STATE_LABEL: Record<ConnectorView["state"], string> = {
  due: "Toca ejecutar",
  "half-done": "A medias",
  "not-due": "Al día",
};

function stateColors(state: ConnectorView["state"]): { fg: string; bg: string } {
  switch (state) {
    case "due":
      return { fg: "var(--accent)", bg: "var(--bg-2)" };
    case "half-done":
      return { fg: "var(--warn)", bg: "var(--warn-bg)" };
    case "not-due":
      return { fg: "var(--up)", bg: "var(--bg-2)" };
  }
}

export function ConnectorSection({
  profileId,
  connector,
}: {
  profileId: number;
  connector: ConnectorView;
}) {
  const [expanded, setExpanded] = useState(connector.defaultExpanded);
  // Optimistic per-task run overrides: task id → last-run ISO. Flips a row to
  // muted + "hecho …" the instant its button is pressed, before a reload.
  const [runOverrides, setRunOverrides] = useState<Record<string, string>>({});

  const colors = useMemo(() => stateColors(connector.state), [connector.state]);

  const collapsedLine = useMemo(() => {
    const parts = [
      `${connector.totalTasks} tarea${connector.totalTasks === 1 ? "" : "s"}`,
      connector.dueCount > 0
        ? `${connector.dueCount} por hacer`
        : "todo al día",
    ];
    if (connector.mutedCount > 0 && connector.dueCount > 0) {
      parts.push(`${connector.mutedCount} al día`);
    }
    // Per-profile captured is the headline figure (issue #430); the
    // portal-global count trails in parentheses as secondary context.
    if (connector.capturedProfile > 0 || connector.capturedReal > 0) {
      const perProfile = `${connector.capturedProfile} capturada${connector.capturedProfile === 1 ? "" : "s"} en este perfil`;
      const global =
        connector.capturedReal !== connector.capturedProfile
          ? ` (${connector.capturedReal} en el portal)`
          : "";
      parts.push(`${perProfile}${global} · última ${relativeAgo(connector.lastCapturedAt)}`);
    }
    return parts.join(" · ");
  }, [connector]);

  async function onExecute(task: CaptureTask): Promise<void> {
    const stamp = new Date().toISOString();
    try {
      const res = await fetch(`/api/profiles/${profileId}/capture-task-runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: task.id }),
      });
      if (res.ok) {
        const body = await res.json().catch(() => null);
        setRunOverrides((prev) => ({ ...prev, [task.id]: body?.lastRunAt ?? stamp }));
      }
    } catch {
      // Recording is best-effort — never block opening the search.
    } finally {
      // Open in the click's user gesture so popup blockers don't eat it; the
      // #inmo-capture signal auto-starts the extension batch (issue #297).
      if (typeof window !== "undefined") {
        window.open(withCaptureSignal(task.url), "_blank", "noopener,noreferrer");
      }
    }
  }

  return (
    <div
      data-testid={`captura-connector-${profileId}-${connector.portal}`}
      data-portal={connector.portal}
      data-state={connector.state}
      data-expanded={expanded ? "true" : "false"}
      style={{
        border: "1px solid var(--border)",
        borderRadius: 12,
        background: "var(--bg-1)",
        overflow: "hidden",
      }}
    >
      {/* Header — always shown; the toggle lives here (manual expand/collapse). */}
      <button
        data-testid={`captura-connector-toggle-${profileId}-${connector.portal}`}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "12px 14px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          color: "var(--fg)",
        }}
      >
        <span
          aria-hidden
          style={{
            fontSize: 12,
            color: "var(--fg-muted)",
            transform: expanded ? "rotate(90deg)" : "none",
            transition: "transform 0.15s",
          }}
        >
          ▶
        </span>
        <strong style={{ fontSize: 15 }}>{connector.label}</strong>
        <span
          data-testid={`captura-connector-badge-${profileId}-${connector.portal}`}
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: colors.fg,
            background: colors.bg,
            borderRadius: 999,
            padding: "1px 9px",
          }}
        >
          {STATE_LABEL[connector.state]}
        </span>
        {!expanded && (
          <span
            data-testid={`captura-connector-stats-${profileId}-${connector.portal}`}
            style={{ fontSize: 12, color: "var(--fg-muted)", marginLeft: "auto" }}
          >
            {collapsedLine}
          </span>
        )}
      </button>

      {/* Expanded body — secondary portal-global context + the task rows. */}
      {expanded && (
        <div style={{ padding: "0 14px 14px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 10,
              flexWrap: "wrap",
              marginBottom: 10,
            }}
          >
            {/* Per-profile captured is the headline figure (issue #430): DISTINCT
                properties captured on this connector that match THIS profile,
                via profile_listing_state. CAVEAT: captures aren't exclusive — a
                property matching several profiles counts under each, so profiles'
                counts can sum to more than the portal-global figure shown after
                it. The title spells this out on hover. */}
            <span
              data-testid={`captura-activity-${profileId}-${connector.portal}`}
              title="Capturas de propiedades que encajan con este perfil. Una propiedad que encaja con varios perfiles cuenta en cada uno (las capturas no son exclusivas)."
              style={{
                fontSize: 12,
                color: connector.capturedProfile > 0 ? "var(--up)" : "var(--fg-muted)",
                fontWeight: connector.capturedProfile > 0 ? 600 : 400,
              }}
            >
              {connector.capturedProfile > 0
                ? `${connector.capturedProfile} propiedad${connector.capturedProfile === 1 ? "" : "es"} de este perfil capturada${connector.capturedProfile === 1 ? "" : "s"}`
                : "sin capturas de este perfil todavía"}
            </span>
            <span
              data-testid={`captura-activity-portal-${profileId}-${connector.portal}`}
              style={{ fontSize: 12, color: "var(--fg-muted)" }}
            >
              {connector.capturedReal > 0
                ? `portal: ${connector.capturedReal} en total · última ${relativeAgo(connector.lastCapturedAt)}`
                : "portal: sin capturas"}
            </span>
            {connector.summary ? (
              <span
                data-testid={`captura-worklist-${profileId}-${connector.portal}`}
                style={{ fontSize: 12, color: "var(--fg-muted)" }}
              >
                lista: {connector.summary.captured}/{connector.summary.total} ·{" "}
                {connector.summary.pending} pendientes
              </span>
            ) : (
              <span
                data-testid={`captura-nolist-${profileId}-${connector.portal}`}
                style={{ fontSize: 12, color: "var(--fg-muted)" }}
              >
                sin lista de captura
              </span>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {connector.taskViews.map((tv) => {
              const override = runOverrides[tv.task.id];
              const muted = override ? true : tv.muted;
              const lastRunAt = override ?? tv.lastRunAt;
              const lastDone = override ? lastDoneLabel(override) : tv.lastDone;
              return (
                <CaptureTaskRow
                  key={tv.task.id}
                  task={tv.task}
                  muted={muted}
                  lastDone={lastDone}
                  lastRunAt={lastRunAt}
                  onExecute={onExecute}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
