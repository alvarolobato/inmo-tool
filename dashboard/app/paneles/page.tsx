"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DashboardSummary {
  id: number;
  name: string;
  description: string | null;
  widget_count?: number;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Home() {
  const [dashboards, setDashboards] = useState<DashboardSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState<ApiErrorResponse | string | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);

  const fetchDashboards = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/dashboards");
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        if (isApiErrorResponse(errBody)) {
          setError(errBody);
        } else {
          setError("Error al cargar los dashboards");
        }
        return;
      }
      const data: DashboardSummary[] = await res.json();
      setDashboards(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Error al cargar los dashboards",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboards();
  }, [fetchDashboards]);

  const handleDelete = async (id: number) => {
    const confirmed = window.confirm(
      "¿Seguro que quieres eliminar este dashboard?",
    );
    if (!confirmed) return;

    setDeletingId(id);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/dashboard/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        const errBody = await res.json().catch(() => null);
        if (isApiErrorResponse(errBody)) {
          throw errBody;
        }
        throw new Error(
          (errBody?.error as string) || "Error al eliminar el dashboard",
        );
      }
      setDashboards((prev) => prev.filter((d) => d.id !== id));
    } catch (err) {
      if (isApiErrorResponse(err)) {
        setDeleteError(err);
      } else {
        setDeleteError(
          err instanceof Error ? err.message : "Error al eliminar el dashboard",
        );
      }
    } finally {
      setDeletingId(null);
    }
  };

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleString("es-ES", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, padding: "24px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: "var(--fg)", margin: 0, letterSpacing: "-0.02em" }}>
            Dashboards
          </h1>
          <p style={{ marginTop: 4, fontSize: 13, color: "var(--fg-muted)" }}>
            Crea y gestiona cuadros de mando con inteligencia artificial
          </p>
        </div>
        <Link
          href="/dashboard/new"
          style={{
            borderRadius: 6,
            background: "var(--accent)",
            padding: "8px 16px",
            fontSize: 13,
            fontWeight: 500,
            color: "#fff",
            textDecoration: "none",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            transition: "filter 120ms",
          }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.filter = "brightness(1.1)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.filter = "")}
        >
          + Crear nuevo
        </Link>
      </div>

      {/* Loading */}
      {loading && (
        <div style={{ display: "flex", justifyContent: "center", padding: "48px 0" }}>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              border: "3px solid var(--border)",
              borderTopColor: "var(--accent)",
              animation: "spin 0.8s linear infinite",
            }}
            role="status"
            aria-label="Cargando"
          />
        </div>
      )}

      {/* Delete error */}
      {deleteError && (
        <ErrorDisplay error={deleteError} />
      )}

      {/* Error */}
      {!loading && error && (
        <ErrorDisplay
          error={error}
          onRetry={fetchDashboards}
        />
      )}

      {/* Empty state */}
      {!loading && !error && dashboards.length === 0 && (
        <div
          style={{
            maxWidth: 480,
            background: "var(--bg-1)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 24,
          }}
        >
          <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--fg)", margin: "0 0 8px" }}>
            No hay dashboards
          </h2>
          <p style={{ fontSize: 13, color: "var(--fg-muted)", margin: "0 0 16px" }}>
            No hay dashboards. Crea el primero.
          </p>
          <Link
            href="/dashboard/new"
            style={{
              display: "inline-block",
              borderRadius: 6,
              background: "var(--accent)",
              padding: "8px 16px",
              fontSize: 13,
              fontWeight: 500,
              color: "#fff",
              textDecoration: "none",
            }}
          >
            Crear dashboard
          </Link>
        </div>
      )}

      {/* Dashboard cards */}
      {!loading && !error && dashboards.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: 16,
          }}
        >
          {dashboards.map((dashboard) => (
            <div
              key={dashboard.id}
              style={{
                background: "var(--bg-1)",
                border: "1px solid var(--border)",
                borderTop: `3px solid ${hovered === dashboard.id ? "var(--accent)" : "var(--accent-soft)"}`,
                borderRadius: 8,
                padding: 20,
                position: "relative",
                transition: "transform 120ms, border-top-color 120ms, box-shadow 120ms",
                transform: hovered === dashboard.id ? "translateY(-2px)" : undefined,
                boxShadow: hovered === dashboard.id ? "0 8px 24px rgba(0,0,0,0.12)" : undefined,
              }}
              onMouseEnter={() => setHovered(dashboard.id)}
              onMouseLeave={() => setHovered(null)}
            >
              <Link
                href={`/dashboard/${dashboard.id}`}
                style={{ textDecoration: "none", display: "block" }}
                data-testid={`dashboard-card-${dashboard.id}`}
              >
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--fg)", marginBottom: 6 }}>
                  {dashboard.name}
                </div>
                {dashboard.description && (
                  <p
                    style={{
                      fontSize: 12,
                      color: "var(--fg-muted)",
                      margin: "0 0 10px",
                      display: "-webkit-box",
                      WebkitBoxOrient: "vertical" as React.CSSProperties["WebkitBoxOrient"],
                      WebkitLineClamp: 2,
                      overflow: "hidden",
                    }}
                  >
                    {dashboard.description}
                  </p>
                )}
                <p
                  style={{
                    fontSize: 11,
                    color: "var(--fg-subtle)",
                    margin: 0,
                    fontFamily: "var(--font-jetbrains, monospace)",
                  }}
                >
                  {dashboard.widget_count != null
                    ? `${dashboard.widget_count} widgets · `
                    : ""}
                  actualizado {formatDate(dashboard.updated_at)}
                </p>
              </Link>
              <button
                onClick={() => handleDelete(dashboard.id)}
                disabled={deletingId === dashboard.id}
                aria-label={`Eliminar ${dashboard.name}`}
                style={{
                  position: "absolute",
                  top: 12,
                  right: 12,
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 13,
                  color: "var(--fg-subtle)",
                  opacity: hovered === dashboard.id ? 1 : 0,
                  transition: "opacity 120ms, color 120ms",
                  padding: 4,
                }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "var(--down)")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "var(--fg-subtle)")}
              >
                {deletingId === dashboard.id ? "..." : "✕"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
