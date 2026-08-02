"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { ConnectorCard } from "@/components/connectors/ConnectorCard";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import type { ConnectorConfigPatch, ConnectorView } from "@/lib/connectors-schema";

/**
 * Connector management (issue #100) — the operator surface for "which
 * connectors run, over what, with which filters".
 *
 * Lives under /etl because middleware.ts already admin-gates `/etl/:path*`
 * (and `/api/etl/:path*` for this page's API), so this inherits the same
 * gating as the rest of the ETL tooling with no middleware change.
 */
export default function ConnectorsPage() {
  const [connectors, setConnectors] = useState<ConnectorView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);

  const fetchConnectors = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/etl/connectors");
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        setError(isApiErrorResponse(errBody) ? errBody : "Error al cargar los conectores");
        return;
      }
      const body = await res.json();
      setConnectors(body.connectors ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cargar los conectores");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConnectors();
  }, [fetchConnectors]);

  const handlePatch = useCallback(
    async (name: string, patch: ConnectorConfigPatch) => {
      setError(null);
      try {
        const res = await fetch(`/api/etl/connectors/${encodeURIComponent(name)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const errBody = await res.json().catch(() => null);
          setError(
            isApiErrorResponse(errBody) ? errBody : `No se pudo actualizar el conector ${name}`,
          );
          return;
        }
        // Refetch rather than patching local state: the effective scope
        // summary is derived server-side from config + active profiles, so
        // a local guess could disagree with what the ETL will actually do.
        await fetchConnectors();
      } catch (err) {
        setError(err instanceof Error ? err.message : `No se pudo actualizar el conector ${name}`);
      }
    },
    [fetchConnectors],
  );

  return (
    <main style={{ padding: 24, maxWidth: 900 }} data-testid="connectors-page">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: "var(--fg)", margin: 0 }}>Conectores</h1>
        <Link
          href="/etl"
          style={{ fontSize: 13, color: "var(--accent)", textDecoration: "none", marginLeft: "auto" }}
        >
          Monitor ETL →
        </Link>
      </div>

      <p style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 8 }}>
        Activa o desactiva cada conector y define qué descarga. Un conector
        desactivado no se ejecuta en absoluto: ni descubre ni descarga nada, y
        tampoco procesa capturas de la extensión. Los conectores nuevos nacen
        desactivados: no se descarga nada hasta que lo actives aquí.
      </p>

      {error && (
        <div style={{ marginTop: 16 }}>
          <ErrorDisplay error={error} />
        </div>
      )}

      {loading ? (
        <p style={{ marginTop: 16, fontSize: 13, color: "var(--fg-muted)" }}>Cargando…</p>
      ) : connectors.length === 0 ? (
        <p
          style={{ marginTop: 16, fontSize: 13, color: "var(--fg-muted)" }}
          data-testid="connectors-empty"
        >
          No hay conectores registrados todavía. El ETL publica su registro al
          arrancar — si acabas de desplegar, ejecuta el contenedor ETL una vez.
        </p>
      ) : (
        <div style={{ marginTop: 16 }}>
          {connectors.map((c) => (
            <ConnectorCard key={c.name} connector={c} onPatch={handlePatch} />
          ))}
        </div>
      )}
    </main>
  );
}
