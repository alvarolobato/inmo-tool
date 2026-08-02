"use client";

import { useCallback, useEffect, useState } from "react";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import { ProfileForm, type ProfileFormValues } from "@/components/profiles/ProfileForm";
import type { SearchProfileRow } from "@/lib/profiles-schema";

type Mode = { kind: "none" } | { kind: "create" } | { kind: "edit"; profile: SearchProfileRow };

export default function ProfilesPage() {
  const [profiles, setProfiles] = useState<SearchProfileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "none" });
  const [busyId, setBusyId] = useState<number | null>(null);

  const fetchProfiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/profiles");
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        setError(isApiErrorResponse(errBody) ? errBody : "Error al cargar los perfiles de búsqueda");
        return;
      }
      setProfiles(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cargar los perfiles de búsqueda");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  const handleCreate = async (values: ProfileFormValues) => {
    const res = await fetch("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(isApiErrorResponse(body) ? body.error : "No se pudo crear el perfil.");
    }
    setMode({ kind: "none" });
    await fetchProfiles();
  };

  const handleUpdate = async (id: number, values: ProfileFormValues) => {
    const res = await fetch(`/api/profiles/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(isApiErrorResponse(body) ? body.error : "No se pudo actualizar el perfil.");
    }
    setMode({ kind: "none" });
    await fetchProfiles();
  };

  const handleArchive = async (id: number) => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/profiles/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(isApiErrorResponse(body) ? body : "No se pudo archivar el perfil.");
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
        setError(isApiErrorResponse(body) ? body : "No se pudo clonar el perfil.");
        return;
      }
      await fetchProfiles();
    } finally {
      setBusyId(null);
    }
  };

  const actionButtonStyle: React.CSSProperties = {
    padding: "4px 10px",
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: 6,
    fontSize: 12,
    color: "var(--fg)",
    cursor: "pointer",
  };

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: "var(--fg)", margin: 0 }}>
          Perfiles de búsqueda
        </h1>
        <button
          onClick={() => setMode((m) => (m.kind === "create" ? { kind: "none" } : { kind: "create" }))}
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
          <ProfileForm submitLabel="Crear perfil" onSubmit={handleCreate} onCancel={() => setMode({ kind: "none" })} />
        </div>
      )}

      {mode.kind === "edit" && (
        <div
          style={{
            marginTop: 16,
            padding: 16,
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg-1)",
          }}
        >
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
        </div>
      )}

      {error && <ErrorDisplay error={error} className="mt-4" />}

      {loading ? (
        <p style={{ marginTop: 16, fontSize: 13, color: "var(--fg-muted)" }}>Cargando…</p>
      ) : profiles.length === 0 ? (
        <p style={{ marginTop: 16, fontSize: 13, color: "var(--fg-muted)" }}>
          No hay perfiles de búsqueda activos. Crea uno para empezar a filtrar candidatos.
        </p>
      ) : (
        <ul style={{ marginTop: 16, listStyle: "none", padding: 0, margin: "16px 0 0" }}>
          {profiles.map((p) => (
            <li
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 0",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <div>
                <p style={{ fontWeight: 500, color: "var(--fg)", margin: 0, fontSize: 14 }}>{p.name}</p>
                <p style={{ fontSize: 12, color: "var(--fg-subtle)", margin: "2px 0 0" }}>
                  {p.scope.property_types.join(", ")} · radio {p.scope.geography.radius_km} km
                </p>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={() => setMode({ kind: "edit", profile: p })}
                  disabled={busyId === p.id}
                  style={{ ...actionButtonStyle, opacity: busyId === p.id ? 0.5 : 1 }}
                >
                  Editar
                </button>
                <button
                  onClick={() => handleClone(p.id)}
                  disabled={busyId === p.id}
                  style={{ ...actionButtonStyle, opacity: busyId === p.id ? 0.5 : 1 }}
                >
                  Clonar
                </button>
                <button
                  onClick={() => handleArchive(p.id)}
                  disabled={busyId === p.id}
                  style={{ ...actionButtonStyle, color: "var(--down)", opacity: busyId === p.id ? 0.5 : 1 }}
                >
                  Archivar
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
