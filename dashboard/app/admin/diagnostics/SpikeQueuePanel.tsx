"use client";

/**
 * "Sitios en evaluación" panel on /admin/diagnostics (issue #705).
 *
 * The seeding surface for prospective-site captures: paste some URLs from a
 * site inmo-tool does NOT support yet, name the site, and the extension's
 * auto-driver captures them from the owner's own browser next time it polls.
 * The captured pages land in `extension_diagnostic` and appear in the list
 * BELOW this panel — which is exactly why the panel lives here and not on a
 * nav tab of its own: you queue a page and see the result in the same place.
 *
 * Why the paste box is here and not the `/admin/fuentes/<portal>` one: that box
 * refuses any host WITHOUT a capture connector, this one refuses any host WITH
 * one. The two are mutually exclusive by host, so a mistyped idealista link is
 * refused by both and can never quietly become a spike capture. Naming the site
 * is required for the same reason — one deliberate act is a checkbox you leave
 * ticked, two is a choice.
 *
 * Same-origin fetches on the `ps_admin` cookie (no admin key in the bundle),
 * then router.refresh() so the server-rendered diagnostic list picks up
 * anything that landed.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { SpikeRequestRow, SpikeSiteSummary } from "@/lib/spike-queue";

interface AddResult {
  added: number;
  duplicate: number;
  invalid: { url: string; reason: string }[];
  capped?: number;
}

const STATUS_LABEL: Record<string, string> = {
  pending: "en cola",
  captured: "capturada",
  skipped: "descartada",
  unreachable: "sin respuesta",
};

const STATUS_TONE: Record<string, string> = {
  pending: "var(--fg-muted)",
  captured: "#16a34a",
  skipped: "var(--fg-muted)",
  unreachable: "#f59e0b",
};

export function SpikeQueuePanel({
  rows,
  summaries,
  pendingOrigins,
}: {
  rows: SpikeRequestRow[];
  summaries: SpikeSiteSummary[];
  /**
   * Origins a host grant would unblock — `pending` AND `unreachable` rows
   * (grantableSpikeOrigins). Deriving it from `pending` alone made the grant
   * affordance disappear exactly when a batch had been given up on, which is
   * when it is most needed (issue #705 review F2).
   */
  pendingOrigins: string[];
}) {
  const router = useRouter();
  const [siteLabel, setSiteLabel] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AddResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onAdd() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/etl/spike-queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: pasteText, siteLabel }),
      });
      const data = (await res.json().catch(() => null)) as
        | (AddResult & { error?: { message?: string } })
        | null;
      if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
      setResult(data as AddResult);
      setPasteText("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al encolar");
    } finally {
      setBusy(false);
    }
  }

  async function onSetStatus(id: number, status: string) {
    setError(null);
    try {
      const res = await fetch(`/api/etl/spike-queue/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al actualizar");
    }
  }

  return (
    <section
      style={{
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: "var(--bg-1)",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
      data-testid="spike-queue-panel"
    >
      <div>
        <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)", marginBottom: 4 }}>
          Sitios en evaluación
        </h2>
        <p style={{ fontSize: 12, color: "var(--fg-muted)" }}>
          Páginas de un portal que <strong>todavía no soportamos</strong>, para decidir si es
          construible. La extensión las abre en tu propio navegador mientras hace el sondeo
          automático y guarda el HTML aquí abajo, como un diagnóstico más. Nunca se hace ninguna
          petición automática al sitio, y nunca se crea un anuncio: un sitio sin conector no puede
          normalizarse, así que esto no es un fallo de ingesta, es una captura deliberada.
        </p>
      </div>

      {pendingOrigins.length > 0 && (
        <p
          style={{
            fontSize: 12,
            color: "#f59e0b",
            border: "1px solid #f59e0b",
            borderRadius: 8,
            padding: "8px 10px",
          }}
        >
          {pendingOrigins.length} origen(es) en cola necesitan permiso de host en la extensión:{" "}
          {pendingOrigins.join(", ")}. Se concede desde el popup → &ldquo;Permitir sitios en
          evaluación&rdquo; (el botón solo aparece si falta alguno; Chrome solo otorga el permiso
          con un clic en la extensión). Sin él esas páginas <strong>se quedan en cola</strong>: el
          planificador ni siquiera se las entrega a la extensión, así que no gastan intentos y no
          pueden acabar en &ldquo;sin respuesta&rdquo; por no haber abierto el popup a tiempo.
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input
          type="text"
          value={siteLabel}
          onChange={(e) => setSiteLabel(e.target.value)}
          placeholder="Nombre del sitio que estás evaluando (p. ej. Servihabitat)"
          data-testid="spike-site-label"
          style={{
            fontSize: 13,
            padding: "8px 10px",
            minHeight: 44,
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--bg-2)",
            color: "var(--fg)",
            width: "100%",
            boxSizing: "border-box",
          }}
        />
        <textarea
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder={"Una URL por línea — solo hosts SIN conector.\nUn host ya soportado se rechaza aquí: usa /admin/fuentes/<portal>."}
          rows={4}
          data-testid="spike-paste"
          style={{
            fontSize: 13,
            fontFamily: "var(--font-mono, monospace)",
            padding: "8px 10px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--bg-2)",
            color: "var(--fg)",
            width: "100%",
            boxSizing: "border-box",
            resize: "vertical",
          }}
        />
        <button
          type="button"
          className="diag-action"
          onClick={onAdd}
          disabled={busy || !siteLabel.trim() || !pasteText.trim()}
          data-testid="spike-add-btn"
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--accent)",
            background: "transparent",
            border: "1px solid var(--accent)",
            borderRadius: 6,
            cursor: busy ? "default" : "pointer",
            opacity: busy || !siteLabel.trim() || !pasteText.trim() ? 0.5 : 1,
            alignSelf: "flex-start",
          }}
        >
          {busy ? "Encolando…" : "Encolar para captura"}
        </button>
      </div>

      {error && <p style={{ fontSize: 12, color: "#f59e0b" }}>{error}</p>}

      {result && (
        <div style={{ fontSize: 12, color: "var(--fg-muted)" }} data-testid="spike-add-result">
          <p>
            {result.added} encolada(s), {result.duplicate} ya estaba(n)
            {result.capped ? `, ${result.capped} rechazada(s) por el tope de la cola` : ""}
            {result.invalid.length > 0 ? `, ${result.invalid.length} rechazada(s)` : ""}.
          </p>
          {result.invalid.slice(0, 10).map((iv) => (
            <p key={iv.url} style={{ color: "#f59e0b", wordBreak: "break-all" }}>
              {iv.url} — {iv.reason}
            </p>
          ))}
        </div>
      )}

      {summaries.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {summaries.map((s) => (
            <span
              key={s.site_label}
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: "var(--fg-muted)",
                background: "var(--bg-2)",
                padding: "2px 8px",
                borderRadius: 999,
              }}
            >
              {s.site_label}: {s.captured}/{s.total} capturadas
              {s.pending > 0 ? ` · ${s.pending} en cola` : ""}
              {s.unreachable > 0 ? ` · ${s.unreachable} sin respuesta` : ""}
            </span>
          ))}
        </div>
      )}

      {rows.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {rows.slice(0, 50).map((r) => (
            <li
              key={r.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                flexWrap: "wrap",
                fontSize: 12,
                borderTop: "1px solid var(--border)",
                paddingTop: 6,
              }}
            >
              <span style={{ minWidth: 0, wordBreak: "break-all", color: "var(--fg-muted)" }}>
                <strong style={{ color: STATUS_TONE[r.status] }}>
                  {STATUS_LABEL[r.status] ?? r.status}
                </strong>{" "}
                · {r.site_label} · {r.url}
                {r.attempts > 0 ? ` · ${r.attempts} intento(s)` : ""}
              </span>
              <span style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                {r.matched_diagnostic_id != null && (
                  <a
                    className="diag-action"
                    href={`/api/admin/diagnostics/${r.matched_diagnostic_id}`}
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--fg-muted)",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      textDecoration: "none",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Ver HTML
                  </a>
                )}
                {r.status === "pending" && (
                  <button
                    type="button"
                    className="diag-action"
                    onClick={() => onSetStatus(r.id, "skipped")}
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--fg-muted)",
                      background: "transparent",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Descartar
                  </button>
                )}
                {(r.status === "unreachable" || r.status === "skipped") && (
                  <button
                    type="button"
                    className="diag-action"
                    onClick={() => onSetStatus(r.id, "pending")}
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--fg-muted)",
                      background: "transparent",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Reintentar
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
