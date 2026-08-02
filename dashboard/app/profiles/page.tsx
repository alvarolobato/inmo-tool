"use client";

import { useCallback, useEffect, useState } from "react";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import { ProfileForm, type ProfileFormValues } from "@/components/profiles/ProfileForm";
import type { SearchProfileRow } from "@/lib/profiles-schema";

export default function ProfilesPage() {
  const [profiles, setProfiles] = useState<SearchProfileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
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
    setShowCreate(false);
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

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Perfiles de búsqueda</h1>
        <button
          onClick={() => setShowCreate((s) => !s)}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white"
        >
          {showCreate ? "Cerrar" : "Nuevo perfil"}
        </button>
      </div>

      {showCreate && (
        <div className="mt-4 rounded border p-4">
          <ProfileForm submitLabel="Crear perfil" onSubmit={handleCreate} onCancel={() => setShowCreate(false)} />
        </div>
      )}

      {error && <ErrorDisplay error={error} className="mt-4" />}

      {loading ? (
        <p className="mt-4 text-sm text-gray-500">Cargando…</p>
      ) : profiles.length === 0 ? (
        <p className="mt-4 text-sm text-gray-500">
          No hay perfiles de búsqueda activos. Crea uno para empezar a filtrar candidatos.
        </p>
      ) : (
        <ul className="mt-4 divide-y">
          {profiles.map((p) => (
            <li key={p.id} className="flex items-center justify-between py-3">
              <div>
                <p className="font-medium">{p.name}</p>
                <p className="text-xs text-gray-500">
                  {p.scope.property_types.join(", ")} · radio {p.scope.geography.radius_km} km
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleClone(p.id)}
                  disabled={busyId === p.id}
                  className="rounded border px-2 py-1 text-xs disabled:opacity-50"
                >
                  Clonar
                </button>
                <button
                  onClick={() => handleArchive(p.id)}
                  disabled={busyId === p.id}
                  className="rounded border px-2 py-1 text-xs text-red-600 disabled:opacity-50"
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
