import {
  listDiagnostics,
  getDiagnosticsStorageSummary,
  type DiagnosticSummary,
} from "@/lib/db/extension-diagnostics";
import { DeleteDiagnosticButton } from "./DeleteDiagnosticButton";
import { listSpikeRequests } from "@/lib/db/spike-queue";
import { pendingSpikeOrigins, summarizeSpikeRequests } from "@/lib/spike-queue";
import { SpikeQueuePanel } from "./SpikeQueuePanel";

export const metadata = {
  title: "Diagnósticos de extensión — inmo-tool",
};

// Reads Postgres at request time — never prerender.
export const dynamic = "force-dynamic";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Chip({ label, tone }: { label: string; tone: "ok" | "warn" | "neutral" }) {
  const colors = {
    ok: { fg: "#16a34a", bg: "rgba(22,163,74,0.12)" },
    warn: { fg: "#f59e0b", bg: "rgba(245,158,11,0.12)" },
    neutral: { fg: "var(--fg-muted)", bg: "var(--bg-2)" },
  }[tone];
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        color: colors.fg,
        background: colors.bg,
        padding: "2px 8px",
        borderRadius: 999,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

/**
 * The `isRenderReady` chip's text. `reason` is what makes a negative verdict
 * actionable ("no matching selector" vs. "body text below threshold"), and a
 * POSITIVE verdict's `selector` is what explained the Hipoges empty shell
 * (the generic `main` fallback alone satisfying the check) — so neither is
 * dropped. PR #675 review, B3.
 */
function renderReadyLabel(d: DiagnosticSummary): string {
  if (d.renderReady === null) return "isRenderReady: ?";
  if (d.renderReady) {
    const selector = d.renderReadySelector ?? "?";
    return d.renderReadyReason
      ? `isRenderReady ✓ (${selector}) · ${d.renderReadyReason}`
      : `isRenderReady ✓ (${selector})`;
  }
  return d.renderReadyReason ? `isRenderReady ✗ · ${d.renderReadyReason}` : "isRenderReady ✗";
}

/**
 * One diagnostic's summary row — the fields called out in issue #671's "what
 * it should send": portal detection, the shared isRenderReady verdict + WHICH
 * selector satisfied it, harvest counts, the D-142 block verdict, and whether
 * auto-capture would have fired. The raw HTML lives behind "Ver HTML" (a
 * download, never rendered inline — see the API route's own docstring for
 * why); every remaining stored field lives behind "Ver JSON"
 * (`?format=json`), so nothing in the payload needs SQL to reach.
 */
function DiagnosticRow({ d }: { d: DiagnosticSummary }) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: "var(--bg-1)",
        padding: "var(--pad, 16px)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <a
            href={d.url}
            target="_blank"
            rel="noreferrer"
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--accent)",
              textDecoration: "none",
              wordBreak: "break-all",
            }}
          >
            {d.title?.trim() || d.url}
          </a>
          <p style={{ fontSize: 11, color: "var(--fg-muted)", marginTop: 2 }}>
            #{d.id} · {new Date(d.createdAt).toLocaleString("es-ES")} · {formatBytes(d.htmlBytes)}
            {d.extensionVersion ? ` · v${d.extensionVersion}` : ""}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>
          <a
            className="diag-action"
            href={`/api/admin/diagnostics/${d.id}`}
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
          {/* The full stored payload minus `html` — every detection/network
              field, not just the handful summarised on this row. Issue #671's
              "he should not need SQL" applies to the WHOLE payload, and this
              row can only ever show a summary. */}
          <a
            className="diag-action"
            href={`/api/admin/diagnostics/${d.id}?format=json`}
            target="_blank"
            rel="noreferrer"
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
            Ver JSON
          </a>
          <DeleteDiagnosticButton id={d.id} />
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {d.detailPortal && <Chip label={`detalle · ${d.detailPortal}`} tone="ok" />}
        {d.listingPortal && <Chip label={`listado · ${d.listingPortal}`} tone="ok" />}
        {!d.detailPortal && !d.listingPortal && (
          <Chip label={d.pageRole ? `otro · ${d.pageRole}` : "no soportada"} tone="neutral" />
        )}
        {/* The `ready === false` branch used to drop BOTH the selector and the
            reason — i.e. it went silent in exactly the captured-too-early case
            this feature exists to diagnose. Now the reason rides along either
            way (PR #675 review, B3). */}
        <Chip label={renderReadyLabel(d)} tone={d.renderReady ? "ok" : "warn"} />
        {d.renderReadyBodyTextLength != null && (
          <Chip label={`texto: ${d.renderReadyBodyTextLength} car.`} tone="neutral" />
        )}
        {/* The "0 of 17": anchors present on the page vs. detail URLs the
            harvest actually got out of them. A wide gap IS the Hipoges
            empty-shell signature. */}
        {(d.anchorCount != null || d.extractDetailUrlsCount != null) && (
          <Chip
            label={`harvest: ${d.extractDetailUrlsCount ?? "?"} de ${d.anchorCount ?? "?"} enlaces`}
            tone={
              d.extractDetailUrlsCount === 0 && (d.anchorCount ?? 0) > 0 ? "warn" : "neutral"
            }
          />
        )}
        {d.blocked && <Chip label={`bloqueada · ${d.blockSignature ?? "?"}`} tone="warn" />}
        {d.autoCaptureWouldFire !== null && (
          <Chip
            label={d.autoCaptureWouldFire ? "auto-captura: sí" : "auto-captura: no"}
            tone={d.autoCaptureWouldFire ? "ok" : "neutral"}
          />
        )}
        {d.networkEntryCount != null && d.networkEntryCount > 0 && (
          <Chip
            label={`red: ${d.networkEntryCount} llamada(s)${d.networkDroppedCount ? ` (+${d.networkDroppedCount} descartadas)` : ""}`}
            tone="neutral"
          />
        )}
      </div>
    </div>
  );
}

export default async function DiagnosticsAdminPage() {
  const [diagnostics, storage, spikeRows] = await Promise.all([
    listDiagnostics(),
    getDiagnosticsStorageSummary(),
    // Prospective-site capture queue (issue #705). It lives on THIS page
    // because its output is the diagnostic list below it — queue a page, see
    // the captured page in the same place — and because a nav tab of its own
    // would be a fifth admin surface for what is one panel of work.
    listSpikeRequests(),
  ]);

  return (
    <div style={{ maxWidth: 900, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--fg)", marginBottom: 6 }}>
          Diagnósticos de extensión
        </h1>
        <p style={{ fontSize: 13, color: "var(--fg-muted)" }}>
          Capturas de &ldquo;forzar captura + diagnóstico&rdquo; (extensión de navegador): HTML
          crudo más lo que la extensión pensó de la página en ese momento. Canal de diagnóstico —
          nunca crea ni actualiza un anuncio. {storage.count} diagnóstico(s), {formatBytes(storage.totalBytes)} en
          total.
        </p>
      </div>

      <SpikeQueuePanel
        rows={spikeRows}
        summaries={summarizeSpikeRequests(spikeRows)}
        pendingOrigins={pendingSpikeOrigins(spikeRows)}
      />

      {diagnostics.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--fg-muted)" }}>
          Sin diagnósticos todavía. Desde el popup de la extensión, pulsa &ldquo;Forzar captura +
          diagnóstico&rdquo; en cualquier página.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {diagnostics.map((d) => (
            <DiagnosticRow key={d.id} d={d} />
          ))}
        </div>
      )}
    </div>
  );
}
