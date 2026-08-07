"use client";

import { useMemo, useState } from "react";
import { ConnectorSection } from "@/components/captura/ConnectorSection";
import type { ProfileCaptureView } from "@/lib/captura-tasks";

/**
 * Stacked per-profile Captura view (issue #413).
 *
 * Renders ALL active profiles one after another — no more "one profile at a
 * time" dropdown. Under each profile its connectors render as collapsible
 * sections ({@link ConnectorSection}); connectors that are DUE or A-MEDIAS start
 * expanded, the rest collapsed to a one-line summary.
 *
 * The old profile dropdown is kept only as an OPTIONAL filter (default "Todos" =
 * every profile visible), so the owner can focus on one profile when the list
 * grows without losing the at-a-glance stacked overview.
 *
 * Pure presentation over the server-computed view-model: the server did all the
 * DB reads and the due/collapse math; this component just lays it out and owns
 * the interactive bits (the connector toggles + launch buttons live in
 * ConnectorSection).
 */
export function CapturaProfiles({ profiles }: { profiles: ProfileCaptureView[] }) {
  // "" = Todos (default). Otherwise the selected profile id as a string.
  const [filter, setFilter] = useState<string>("");

  const visible = useMemo(
    () => (filter === "" ? profiles : profiles.filter((p) => String(p.id) === filter)),
    [profiles, filter],
  );

  return (
    <div data-testid="captura-profiles">
      {/* Optional profile filter — default shows every profile stacked. */}
      {profiles.length > 1 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <label htmlFor="captura-profile-filter" style={{ fontSize: 13, color: "var(--fg-muted)" }}>
            Filtrar perfil
          </label>
          <select
            id="captura-profile-filter"
            data-testid="captura-profile-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{
              fontSize: 13,
              padding: "7px 10px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--bg-1)",
              color: "var(--fg)",
              minWidth: 200,
            }}
          >
            <option value="">Todos los perfiles</option>
            {profiles.map((p) => (
              <option key={p.id} value={String(p.id)}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
        {visible.map((profile) => (
          <section
            key={profile.id}
            data-testid={`captura-profile-${profile.id}`}
            style={{ display: "flex", flexDirection: "column", gap: 10 }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: "var(--fg)", margin: 0 }}>
                {profile.name}
              </h2>
              <span
                data-testid={`captura-profile-summary-${profile.id}`}
                style={{ fontSize: 12, color: "var(--fg-muted)" }}
              >
                {profile.connectors.length === 0
                  ? "sin conectores"
                  : profile.actionableConnectors > 0
                    ? `${profile.actionableConnectors} conector${profile.actionableConnectors === 1 ? "" : "es"} por hacer · ${profile.totalTasks} tarea${profile.totalTasks === 1 ? "" : "s"}`
                    : `todo al día · ${profile.totalTasks} tarea${profile.totalTasks === 1 ? "" : "s"}`}
              </span>
            </div>

            {profile.connectors.length === 0 ? (
              <p
                data-testid={`captura-profile-empty-${profile.id}`}
                style={{ fontSize: 13, color: "var(--fg-muted)" }}
              >
                Este perfil no tiene ninguna tarea de captura disponible todavía.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {profile.connectors.map((connector) => (
                  <ConnectorSection
                    key={connector.portal}
                    profileId={profile.id}
                    connector={connector}
                  />
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
