"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import {
  ProfileForm,
  DEFAULT_VALUES,
  type ProfileFormValues,
} from "@/components/profiles/ProfileForm";
import { TemplatePicker } from "@/components/profiles/TemplatePicker";
import { findTemplate, templateToFormValues } from "@/lib/profile-templates";
import { ProfileOverviewRow } from "@/components/profiles/ProfileOverviewRow";
import { Modal } from "@/components/Modal";
import { NovedadesStrip } from "@/components/profiles/NovedadesStrip";
import { RefreshIndicator } from "@/components/profiles/RefreshIndicator";
import type {
  ProfileRefreshResult,
  SearchProfileRow,
} from "@/lib/profiles-schema";
import type { ProfileOverviewEntry } from "@/lib/profile-overview-types";

type Mode =
  | { kind: "none" }
  | { kind: "create" }
  | { kind: "edit"; profile: SearchProfileRow }
  // Issue #113/#193: a malformed-scope profile's OLD scope can't be
  // recovered (it never parsed), so "repair" seeds only the (valid) name
  // and a fresh default scope skeleton — the user re-enters the geography/
  // type from scratch, then PATCH overwrites the broken row in place.
  | { kind: "repair"; id: number; name: string };

/**
 * Skeleton row (issue #193's loading state) — fixed height matching the
 * real row so the page doesn't jump-shift once data arrives.
 */
function SkeletonRow() {
  return (
    <div
      data-testid="profile-row-skeleton"
      style={{
        height: 84,
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--bg-1)",
        marginBottom: 10,
        opacity: 0.5,
      }}
    />
  );
}

/**
 * Fallback row rendered only when the aggregate overview query fails but
 * the plain profile list still loads (issue #193's partial-failure
 * degradation: "the profiles list itself... should still attempt to render
 * from the cheap plain list if the heavier aggregate 500s").
 */
function DegradedProfileRow({ profile }: { profile: SearchProfileRow }) {
  return (
    <div
      data-testid="profile-row-degraded"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "14px 12px",
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--bg-1)",
        marginBottom: 10,
        gap: 12,
      }}
    >
      <div>
        <p
          style={{
            fontWeight: 500,
            color: "var(--fg)",
            margin: 0,
            fontSize: 14,
          }}
        >
          {profile.name}
        </p>
        <p
          style={{ fontSize: 12, color: "var(--fg-subtle)", margin: "2px 0 0" }}
        >
          {profile.scope.property_types.join(", ")} · radio{" "}
          {profile.scope.geography.radius_km} km
        </p>
        <p
          data-testid="profile-degraded-note"
          style={{ fontSize: 11, color: "var(--warn)", margin: "4px 0 0" }}
        >
          No se pudieron cargar las métricas.
        </p>
      </div>
      <Link
        href={`/profiles/${profile.id}`}
        style={{
          padding: "7px 14px",
          background: "var(--accent)",
          color: "#fff",
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 500,
          textDecoration: "none",
          whiteSpace: "nowrap",
        }}
      >
        Entrar →
      </Link>
    </div>
  );
}

export default function ProfilesPage() {
  const [overviews, setOverviews] = useState<ProfileOverviewEntry[] | null>(
    null,
  );
  const [degradedProfiles, setDegradedProfiles] = useState<
    SearchProfileRow[] | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "none" });
  // Issue #39: which profile template seeds the create form. null = "Empezar en
  // blanco" (the unchanged task-2.3 blank flow — ProfileForm gets no `initial`
  // and falls back to DEFAULT_VALUES). Picking a template remounts ProfileForm
  // (via `key`) with the template's plausible starting values, still fully
  // editable. Reset to null whenever the create panel is (re)opened.
  const [createTemplateId, setCreateTemplateId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  // Issue #245: the ad-hoc sweep trigger id from the last create/scope-edit, so
  // <RefreshIndicator> can poll it and show "buscando datos nuevos…". null when
  // the last save enqueued no crawl (a rename, or an enqueue that failed).
  const [refreshTriggerId, setRefreshTriggerId] = useState<number | null>(null);
  // Issue #195: the profile row the "novedades" strip last jumped to — briefly
  // ringed so the eye lands on it after the scroll. Cleared on a timer.
  const [highlightedId, setHighlightedId] = useState<number | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Scroll to and briefly highlight a profile row (novedades strip click).
  const jumpToProfile = useCallback((profileId: number) => {
    setHighlightedId(profileId);
    if (typeof document !== "undefined") {
      document
        .getElementById(`profile-row-${profileId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightedId(null), 2500);
  }, []);

  useEffect(() => {
    return () => {
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
    };
  }, []);

  const fetchProfiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    setDegradedProfiles(null);
    try {
      const res = await fetch("/api/profiles/overview");
      if (res.ok) {
        setOverviews(await res.json());
        return;
      }
      // Degraded fallback (issue #193): the heavier aggregate failed — try
      // the cheap plain list (names/scope only) instead of blocking the
      // whole page behind ErrorDisplay.
      const plainRes = await fetch("/api/profiles");
      if (plainRes.ok) {
        setOverviews(null);
        setDegradedProfiles(await plainRes.json());
        return;
      }
      const errBody = await res.json().catch(() => null);
      setError(
        isApiErrorResponse(errBody)
          ? errBody
          : "Error al cargar los perfiles de búsqueda",
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Error al cargar los perfiles de búsqueda",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  // Materialization on create/scope-edit now happens SERVER-side, inside the
  // POST/PATCH routes' quick-refresh (issue #245) — the client no longer
  // fires a separate /materialize call for those, so the candidate list is
  // fresh the instant the save returns even if the browser navigates away.
  // This client helper is kept ONLY for clone (task 2.4 / Fable phase-2
  // review): clone's route doesn't scope-change, so it isn't a quick-refresh
  // caller, but a clone still needs its identical candidate set materialized.
  // Best-effort: a materialize failure is logged and swallowed, never
  // surfaced as if the save itself failed.
  const triggerMaterialize = async (id: number) => {
    try {
      const res = await fetch(`/api/profiles/${id}/materialize`, {
        method: "POST",
      });
      if (!res.ok) {
        console.error(
          "No se pudieron recalcular los candidatos tras guardar el perfil:",
          res.status,
          await res.text().catch(() => ""),
        );
      }
    } catch (err) {
      console.error(
        "No se pudieron recalcular los candidatos tras guardar el perfil:",
        err,
      );
    }
  };

  // Issue #245: if the save kicked off an ad-hoc sweep, remember its trigger
  // id so <RefreshIndicator> can poll it. A rename (refresh null, or crawl
  // skipped) leaves the previous indicator cleared.
  const applyRefresh = (refresh: ProfileRefreshResult | null | undefined) => {
    if (
      refresh &&
      refresh.crawl.triggerId !== null &&
      (refresh.crawl.status === "enqueued" ||
        refresh.crawl.status === "already_pending")
    ) {
      setRefreshTriggerId(refresh.crawl.triggerId);
    } else {
      setRefreshTriggerId(null);
    }
  };

  const handleCreate = async (values: ProfileFormValues) => {
    const res = await fetch("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(
        isApiErrorResponse(body) ? body.error : "No se pudo crear el perfil.",
      );
    }
    const created: SearchProfileRow & {
      refresh?: ProfileRefreshResult | null;
    } = await res.json();
    setMode({ kind: "none" });
    await fetchProfiles();
    applyRefresh(created.refresh);
  };

  const handleUpdate = async (id: number, values: ProfileFormValues) => {
    const res = await fetch(`/api/profiles/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(
        isApiErrorResponse(body)
          ? body.error
          : "No se pudo actualizar el perfil.",
      );
    }
    const updated: SearchProfileRow & {
      refresh?: ProfileRefreshResult | null;
    } = await res.json();
    setMode({ kind: "none" });
    await fetchProfiles();
    applyRefresh(updated.refresh);
  };

  const handleArchive = async (id: number) => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/profiles/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(
          isApiErrorResponse(body) ? body : "No se pudo archivar el perfil.",
        );
        return;
      }
      await fetchProfiles();
    } finally {
      setBusyId(null);
    }
  };

  const handleClone = async (id: number) => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/profiles/${id}/clone`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(
          isApiErrorResponse(body) ? body : "No se pudo clonar el perfil.",
        );
        return;
      }
      const cloned: SearchProfileRow = await res.json();
      await fetchProfiles();
      // Without this, a clone of a profile with real matches ships with an
      // empty candidate list until the user happens to open "Editar" and
      // re-save it — clone's scope/thesis_params are identical to the
      // source, so its candidates should be too (Fable phase-2 review).
      await triggerMaterialize(cloned.id);
    } finally {
      setBusyId(null);
    }
  };

  const hasAnyProfiles =
    (overviews?.length ?? 0) > 0 || (degradedProfiles?.length ?? 0) > 0;

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <h1
          style={{
            fontSize: 20,
            fontWeight: 600,
            color: "var(--fg)",
            margin: 0,
          }}
        >
          Perfiles de búsqueda
        </h1>
        <button
          onClick={() =>
            setMode((m) => {
              if (m.kind === "create") return { kind: "none" };
              // Fresh create panel always starts on the blank ("Empezar en
              // blanco") selection so the default flow is unchanged (EC-3).
              setCreateTemplateId(null);
              return { kind: "create" };
            })
          }
          style={{
            padding: "7px 14px",
            background: "var(--accent)",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          {mode.kind === "create" ? "Cerrar" : "Nuevo perfil"}
        </button>
      </div>

      {/* Issue #245: after a create/scope-edit, poll the ad-hoc sweep and show
          a subtle "buscando datos nuevos…" indicator. `key` remounts it when a
          new save starts a new sweep so its poll loop restarts cleanly. */}
      <RefreshIndicator
        key={refreshTriggerId ?? "none"}
        triggerId={refreshTriggerId}
        onSettled={fetchProfiles}
      />

      {mode.kind === "create" && (
        <div
          style={{
            marginTop: 16,
            padding: 16,
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg-1)",
          }}
        >
          {/* Issue #39: template chooser above the (always-rendered) form.
              Picking a template pre-fills the form; "Empezar en blanco" keeps
              the original blank flow. */}
          <TemplatePicker
            selectedId={createTemplateId}
            onPick={setCreateTemplateId}
          />
          <ProfileForm
            // Remount on template change so the newly-picked template's values
            // seed ProfileForm's internal state. Blank → no `initial` →
            // DEFAULT_VALUES (task 2.3's exact behaviour, EC-3).
            key={createTemplateId ?? "blank"}
            initial={
              createTemplateId
                ? templateToFormValues(findTemplate(createTemplateId)!)
                : undefined
            }
            submitLabel="Crear perfil"
            onSubmit={handleCreate}
            onCancel={() => setMode({ kind: "none" })}
          />
        </div>
      )}

      {/* Issue #446: the row-triggered edit/repair forms open in a focus-managed
          modal instead of appearing inline at the top of the page (where, with
          the row far down the list, they went unnoticed). The modal centers in
          the viewport, autofocuses the first field, traps Tab, and closes on
          Escape / backdrop — the save/validation flow inside ProfileForm is
          unchanged. */}
      <Modal
        open={mode.kind === "edit"}
        onClose={() => setMode({ kind: "none" })}
        title="Editar perfil"
        testId="profile-edit-modal"
        maxWidth={620}
      >
        {mode.kind === "edit" && (
          <ProfileForm
            initial={{
              name: mode.profile.name,
              scope: mode.profile.scope,
              thesis_params: mode.profile.thesis_params,
            }}
            submitLabel="Guardar cambios"
            onSubmit={(values) => handleUpdate(mode.profile.id, values)}
            onCancel={() => setMode({ kind: "none" })}
          />
        )}
      </Modal>

      <Modal
        open={mode.kind === "repair"}
        onClose={() => setMode({ kind: "none" })}
        title="Reparar perfil"
        testId="profile-repair-modal"
        maxWidth={620}
      >
        {mode.kind === "repair" && (
          <>
            <p
              style={{
                margin: "0 0 12px",
                fontSize: 12,
                color: "var(--fg-muted)",
              }}
            >
              Este perfil tenía una configuración inválida y no se pudo recuperar
              su ámbito (scope) original — defínelo de nuevo desde cero.
            </p>
            <ProfileForm
              initial={{ ...DEFAULT_VALUES, name: mode.name }}
              submitLabel="Guardar y reparar"
              onSubmit={(values) => handleUpdate(mode.id, values)}
              onCancel={() => setMode({ kind: "none" })}
            />
          </>
        )}
      </Modal>

      {error && <ErrorDisplay error={error} className="mt-4" />}

      {loading ? (
        <div style={{ marginTop: 16 }}>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : !error && !hasAnyProfiles ? (
        <p style={{ marginTop: 16, fontSize: 13, color: "var(--fg-muted)" }}>
          No hay perfiles de búsqueda activos. Crea uno para empezar a filtrar
          candidatos.
        </p>
      ) : (
        <div style={{ marginTop: 16 }}>
          {/* Issue #195: the "novedades" glance — sums each profile's new_count
              (candidates first-seen since last visit) into a page-level strip.
              Rendered only for the full overview shape; the degraded plain-list
              fallback has no new_count, so NovedadesStrip returns null there. */}
          <NovedadesStrip
            overviews={overviews}
            onJumpToProfile={jumpToProfile}
          />
          {overviews !== null &&
            overviews.map((entry) => (
              <ProfileOverviewRow
                key={entry.ok ? entry.profile.id : entry.id}
                entry={entry}
                highlighted={entry.ok && highlightedId === entry.profile.id}
                busy={busyId === (entry.ok ? entry.profile.id : entry.id)}
                onEdit={() =>
                  entry.ok
                    ? setMode({ kind: "edit", profile: entry.profile })
                    : setMode({
                        kind: "repair",
                        id: entry.id,
                        name: entry.name,
                      })
                }
                onClone={() => entry.ok && handleClone(entry.profile.id)}
                onArchive={() =>
                  handleArchive(entry.ok ? entry.profile.id : entry.id)
                }
              />
            ))}
          {degradedProfiles !== null &&
            degradedProfiles.map((p) => (
              <DegradedProfileRow key={p.id} profile={p} />
            ))}
        </div>
      )}
    </main>
  );
}
