"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { PortalCaptureCard } from "@/components/captura/PortalCaptureCard";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import { buildPortalCaptureViews, captureTotals } from "@/lib/captura-view";
import type { SearchTask } from "@/lib/search-url";
import type { SearchProfileRow } from "@/lib/profiles-schema";
import type { WorklistPortalSummary } from "@/lib/worklist";

/**
 * Captura — top-level guided-capture EXECUTION page (issue #268, part of #237).
 *
 * A first-class, polished surface next to Perfiles for the day-to-day capture
 * loop: pick a profile → see the pre-filtered search per capture portal + that
 * portal's worklist progress → "Abrir búsqueda" opens the portal already
 * filtered, and the browser extension's batch capture (issue #262) takes over.
 *
 * This is EXECUTION, deliberately distinct from the admin SETUP surfaces under
 * `/etl/*` (install the extension, API key, connector config, the raw worklist
 * table). It reuses their APIs — `GET /api/profiles/[id]/search-urls` (#267)
 * and `GET /api/etl/worklist` (#260) — and never re-implements the batch loop
 * (that lives in the extension) nor the worklist/search-url logic.
 *
 * Same-origin fetches carry the `ps_admin` cookie, so the admin-gated
 * `/api/etl/*` route is reachable from this page without a separate auth
 * surface (middleware.ts gates the whole app — it is a single-operator tool).
 */

// Minimal shape the picker needs from GET /api/profiles.
type ProfileOption = Pick<SearchProfileRow, "id" | "name">;

interface SearchUrlsResponse {
  profileId: number;
  name: string;
  tasks: SearchTask[];
}

export default function CapturaPage() {
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const [tasks, setTasks] = useState<SearchTask[]>([]);
  const [summaries, setSummaries] = useState<WorklistPortalSummary[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);

  // ── Load the profile list once ──────────────────────────────────────────
  const fetchProfiles = useCallback(async () => {
    setProfilesLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/profiles");
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(isApiErrorResponse(body) ? body : "No se pudieron cargar los perfiles.");
        return;
      }
      const body: SearchProfileRow[] = await res.json();
      setProfiles(body.map((p) => ({ id: p.id, name: p.name })));
      // Auto-select the first profile so the operator lands on a working view.
      if (body.length > 0) setSelectedId((prev) => prev ?? body[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los perfiles.");
    } finally {
      setProfilesLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  // ── Load the selected profile's search URLs + the worklist roll-up ──────
  const fetchDetail = useCallback(async (id: number) => {
    setDetailLoading(true);
    setError(null);
    try {
      const [urlsRes, wlRes] = await Promise.all([
        fetch(`/api/profiles/${id}/search-urls`),
        fetch("/api/etl/worklist"),
      ]);
      if (!urlsRes.ok) {
        const body = await urlsRes.json().catch(() => null);
        setError(isApiErrorResponse(body) ? body : "No se pudieron cargar las búsquedas del perfil.");
        return;
      }
      if (!wlRes.ok) {
        const body = await wlRes.json().catch(() => null);
        setError(isApiErrorResponse(body) ? body : "No se pudo cargar el progreso de captura.");
        return;
      }
      const urlsBody: SearchUrlsResponse = await urlsRes.json();
      const wlBody = await wlRes.json();
      setTasks(urlsBody.tasks ?? []);
      setSummaries(wlBody.summaries ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la captura del perfil.");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId !== null) fetchDetail(selectedId);
  }, [selectedId, fetchDetail]);

  const views = useMemo(() => buildPortalCaptureViews(tasks, summaries), [tasks, summaries]);
  const totals = useMemo(() => captureTotals(views), [views]);

  return (
    <main style={{ padding: 24, maxWidth: 900, margin: "0 auto" }} data-testid="captura-page">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--fg)", margin: 0 }}>Captura</h1>
        <Link
          href="/etl/extension"
          data-testid="captura-setup-link"
          style={{ fontSize: 13, color: "var(--accent)", textDecoration: "none", marginLeft: "auto" }}
        >
          ¿Primera vez? Instalar la extensión →
        </Link>
      </div>
      <p style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 8, lineHeight: 1.5 }}>
        Elige un perfil, abre su búsqueda ya filtrada en cada portal y deja que la extensión capture
        los anuncios en secuencia. Aquí ves el progreso de lo capturado. La configuración (extensión,
        clave, conectores) vive en{" "}
        <Link href="/etl/captura" style={{ color: "var(--accent)", textDecoration: "none" }}>
          Admin · Captura
        </Link>
        .
      </p>

      {error && (
        <div style={{ marginTop: 16 }}>
          <ErrorDisplay error={error} />
        </div>
      )}

      {/* Profile picker */}
      <section style={{ marginTop: 20 }} data-testid="captura-profile-picker">
        {profilesLoading ? (
          <div
            data-testid="captura-profiles-loading"
            style={{ height: 38, width: 260, borderRadius: 8, background: "var(--bg-2)", opacity: 0.6 }}
          />
        ) : profiles.length === 0 ? (
          <div
            data-testid="captura-no-profiles"
            style={{
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: 20,
              background: "var(--bg-1)",
              fontSize: 13,
              color: "var(--fg-muted)",
            }}
          >
            No hay perfiles de búsqueda todavía. Crea uno en{" "}
            <Link href="/profiles" style={{ color: "var(--accent)", textDecoration: "none" }}>
              Perfiles
            </Link>{" "}
            para empezar a capturar.
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <label htmlFor="captura-profile-select" style={{ fontSize: 13, color: "var(--fg-muted)" }}>
              Perfil
            </label>
            <select
              id="captura-profile-select"
              data-testid="captura-profile-select"
              value={selectedId ?? ""}
              onChange={(e) => setSelectedId(Number(e.target.value))}
              style={{
                fontSize: 13,
                padding: "7px 10px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--bg-1)",
                color: "var(--fg)",
                minWidth: 220,
              }}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              data-testid="captura-refresh"
              onClick={() => selectedId !== null && fetchDetail(selectedId)}
              disabled={detailLoading || selectedId === null}
              style={{
                fontSize: 13,
                fontWeight: 600,
                padding: "7px 14px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--bg-1)",
                color: "var(--fg)",
                cursor: detailLoading ? "not-allowed" : "pointer",
                opacity: detailLoading ? 0.6 : 1,
              }}
            >
              {detailLoading ? "Actualizando…" : "Actualizar progreso"}
            </button>
          </div>
        )}
      </section>

      {/* Totals strip + per-portal cards */}
      {selectedId !== null && profiles.length > 0 && (
        <section style={{ marginTop: 20 }} data-testid="captura-portals">
          {detailLoading && views.length === 0 ? (
            <div
              data-testid="captura-detail-loading"
              style={{ height: 120, borderRadius: 12, background: "var(--bg-1)", border: "1px solid var(--border)", opacity: 0.6 }}
            />
          ) : views.length === 0 ? (
            <p data-testid="captura-portals-empty" style={{ fontSize: 13, color: "var(--fg-muted)" }}>
              Este perfil no tiene ningún portal con búsqueda pre-filtrada disponible todavía.
            </p>
          ) : (
            <>
              <p
                data-testid="captura-totals"
                style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 0, marginBottom: 12 }}
              >
                {totals.captured} de {totals.total} capturadas en {totals.portals} portal
                {totals.portals === 1 ? "" : "es"} · {totals.pending} pendientes ({totals.capturedPct}%)
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {views.map((v) => (
                  <PortalCaptureCard key={v.portal} view={v} />
                ))}
              </div>
            </>
          )}
        </section>
      )}
    </main>
  );
}
