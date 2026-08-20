import Link from "next/link";
import { notFound } from "next/navigation";
import { getProfileById } from "@/lib/db/profiles";
import { resolveSearchTasks } from "@/lib/search-url/resolve";
import { findOverridesForProfile } from "@/lib/db/profile-connector-filter";
import { CAPTURE_PORTALS } from "@/lib/worklist";
import { portalTitle } from "@/lib/captura-tasks";
import { decodeFilterUrl } from "@/lib/filter-validation";
import { PARSERS } from "@/lib/search-url/parsers";
import { FilterValidationRow } from "@/components/profiles/FilterValidationRow";
import { ExtensionCta } from "@/components/extension/ExtensionCta";
import { ProfileSwitcher } from "@/components/layout/ProfileSwitcher";
import { EtlConnectorPreviewRow } from "@/components/profiles/EtlConnectorPreviewRow";
import { RecalcularPreviewsButton } from "@/components/profiles/RecalcularPreviewsButton";
import { getEtlConnectorPreviews } from "@/lib/db/connector-search-preview";
import { deriveGrammarPreview } from "@/lib/connector-url/derive";
import type { LoosenedConstraint } from "@/lib/search-url";
import type { ProfileConnectorFilterSource } from "@/lib/db/profile-connector-filter";

/**
 * "Validar filtros" — per-profile connector search-URL preview / pin page
 * (issue #478 P2).
 *
 * Reached from a profile's ⋮ menu. Lists, for extension capture portals, the
 * search TASK each one will run for this profile ({@link resolveSearchTasks},
 * which already folds in the tier-0 owner override from Phase 1): a source
 * badge, the copyable URL, decoded filter chips + mismatch warnings, the
 * resolver's loosened flags, and owner controls to pin (PUT) / unpin (DELETE) /
 * open the URL. altamira (a capture portal with no builder AND no parser) always
 * gets a row so its first URL can be pasted in even though nothing is derived;
 * that row is flagged `verbatimOnly` (#497) so it shows an honest "sin gramática
 * verificada; se usa tal cual" note instead of offering (impossible) inference.
 *
 * Phase 3: "Abrir" opens the URL in the extension's validation mode
 * (`withValidateSignal`) — no batch autostart, no listing banner, no detail
 * auto-capture — and the extension popup offers "Usar esta URL como filtro" to
 * pin the tuned URL back. The ETL-connector section is a degraded Phase-4
 * placeholder.
 *
 * `force-dynamic`: every load reflects the live override table + resolver.
 * Admin-gated by middleware.ts like every page.
 */
export const dynamic = "force-dynamic";

/**
 * Issue #515: the public home page for an extension capture portal, derived from
 * its host suffix in {@link CAPTURE_PORTALS} (no Python/registry round-trip for
 * these — the capture portals live entirely on the TS side). null for a portal
 * not in that list.
 */
function capturePortalHomeUrl(portal: string): string | null {
  const p = CAPTURE_PORTALS.find((c) => c.portal === portal);
  return p ? `https://www.${p.hostSuffix}` : null;
}

interface FilterRowModel {
  connector: string;
  label: string;
  url: string;
  /** Issue #515: the portal home page, for the empty-URL "Abrir portal" fallback. */
  homeUrl: string | null;
  sectionKey: string;
  overridden: boolean;
  source?: ProfileConnectorFilterSource;
  loosened: LoosenedConstraint[];
  chips: string[];
  warnings: string[];
  unparseable: boolean;
  /** Portal with no verified grammar (no parser) — pin + verbatim only (#497). */
  verbatimOnly: boolean;
}

export default async function ValidarFiltrosPage({
  params,
}: {
  params: Promise<{ id: string }> | { id: string };
}) {
  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const profile = await getProfileById(id);
  if (!profile || profile.archived_at !== null) notFound();

  const [tasks, overrides, etlPreviews] = await Promise.all([
    resolveSearchTasks(profile.scope, id),
    findOverridesForProfile(id),
    getEtlConnectorPreviews(id).catch(() => []),
  ]);

  const rows: FilterRowModel[] = tasks.map((task) => {
    const decoded = decodeFilterUrl(task.portal, task.url, profile.scope);
    // A pinned task keeps the stored override's section_key + source so
    // Quitar/Guardar target the exact row (its categoryKey may be '' for an
    // unparseable pinned URL, which is what it was stored under).
    const pin = task.overridden
      ? overrides.find((o) => o.connector === task.portal && o.url === task.url)
      : undefined;
    return {
      connector: task.portal,
      label: task.label,
      url: task.url,
      homeUrl: capturePortalHomeUrl(task.portal),
      sectionKey: pin ? pin.section_key : decoded.sectionKey,
      overridden: Boolean(task.overridden),
      source: pin?.source,
      loosened: task.loosened,
      chips: decoded.chips,
      warnings: decoded.warnings,
      unparseable: decoded.unparseable,
      verbatimOnly: !PARSERS[task.portal],
    };
  });

  // Ensure every extension capture portal is represented, even one with no
  // builder and no pin (altamira) — an empty manual row so its first URL can be
  // pasted in.
  for (const { portal } of CAPTURE_PORTALS) {
    if (rows.some((r) => r.connector === portal)) continue;
    rows.push({
      connector: portal,
      label: portalTitle(portal),
      url: "",
      homeUrl: capturePortalHomeUrl(portal),
      sectionKey: "",
      overridden: false,
      loosened: [],
      chips: [],
      warnings: [],
      unparseable: false,
      verbatimOnly: !PARSERS[portal],
    });
  }

  return (
    <main className="route-shell" style={{ maxWidth: 860, margin: "0 auto" }} data-testid="validar-filtros-page">
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--fg)", margin: 0 }}>Validar filtros</h1>
        {/* Profile switcher — stays on this page for the newly selected profile. */}
        <ProfileSwitcher currentId={id} subpath="/filtros" />
        <Link
          href={`/profiles/${id}`}
          style={{ fontSize: 13, color: "var(--accent)", textDecoration: "none", marginLeft: "auto" }}
        >
          ← Volver al perfil
        </Link>
      </div>
      <p style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 8, lineHeight: 1.5 }}>
        Perfil <strong>{profile.name}</strong>. Aquí ves, por conector, la URL de búsqueda que se va a
        usar para este perfil. Puedes fijar una URL afinada a mano (será la fuente de recall de ese
        conector, sustituyendo a la derivada) y los filtros de datos se seguirán aplicando igual que
        ahora.
      </p>

      {/* Phase 3: "Abrir" enters the extension's validation mode — a short
          permanent hint on how to hand a tuned URL back. (The transient P2
          "not yet implemented" note is gone.) */}
      <p
        data-testid="validar-filtros-open-hint"
        style={{
          marginTop: 12,
          fontSize: 12,
          color: "var(--fg-muted)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: "10px 12px",
          background: "var(--bg-1)",
          lineHeight: 1.5,
        }}
      >
        «Abrir» abre la página del portal en <strong>modo validación</strong>: la extensión no arranca
        ninguna captura (ni banner, ni auto-captura de detalle), aunque navegues dentro del portal.
        Afina la búsqueda (por ejemplo, dibuja la zona) y pulsa «Usar esta URL como filtro» en el popup
        de la extensión para fijarla como fuente de este conector.
      </p>

      <section style={{ marginTop: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", margin: "0 0 10px" }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--fg)", margin: 0 }}>
            Portales de captura (extensión)
          </h2>
          {/* Inline CTA (#509): "Abrir"/pin need the extension linked — shown
              only while it isn't. */}
          <div style={{ marginLeft: "auto" }}>
            <ExtensionCta context="filtros" />
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {rows.map((row) => (
            <FilterValidationRow
              key={`${row.connector}-${row.sectionKey || "all"}`}
              profileId={id}
              connector={row.connector}
              label={row.label}
              url={row.url}
              homeUrl={row.homeUrl}
              sectionKey={row.sectionKey}
              overridden={row.overridden}
              source={row.source}
              loosened={row.loosened}
              chips={row.chips}
              warnings={row.warnings}
              unparseable={row.unparseable}
              verbatimOnly={row.verbatimOnly}
            />
          ))}
        </div>
      </section>

      <section style={{ marginTop: 24 }} data-testid="validar-filtros-etl-section">
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--fg)", margin: 0 }}>
            Conectores ETL
          </h2>
          <span style={{ marginLeft: "auto" }}>
            <RecalcularPreviewsButton />
          </span>
        </div>
        <p style={{ fontSize: 12, color: "var(--fg-muted)", margin: "0 0 10px", lineHeight: 1.5 }}>
          Por cada conector HTTP, la petición que va a ejecutar el ETL para este perfil (URL de
          búsqueda, sitemap o endpoint). Los afinables aceptan fijar una URL; los que barren a nivel
          nacional filtran por datos y son de solo lectura.
        </p>
        {etlPreviews.length === 0 ? (
          <p
            data-testid="validar-filtros-etl-empty"
            style={{
              fontSize: 12,
              color: "var(--fg-muted)",
              border: "1px dashed var(--border)",
              borderRadius: 10,
              padding: "12px 14px",
              background: "var(--bg-1)",
            }}
          >
            Aún no hay previsualizaciones de conectores ETL para este perfil. Se calcularán en la
            próxima ejecución del ETL — o pulsa «Recalcular».
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {etlPreviews.map((row) => {
              const pin = overrides.find((o) => o.connector === row.connector && o.section_key === "");
              const tunable = row.overrideHostSuffix !== null;
              // Issue #513: when there's no pin and no ETL-computed URL yet, build
              // one on demand from the grammar so the row is never URL-less.
              const derivedUrl =
                !pin && tunable && row.searchUrlGrammar && !row.previews[0]?.url
                  ? (deriveGrammarPreview(row.searchUrlGrammar, profile.scope)?.url ?? null)
                  : null;
              return (
                <EtlConnectorPreviewRow
                  key={row.connector}
                  profileId={id}
                  connector={row.connector}
                  preview={row.previews[0] ?? null}
                  tunable={tunable}
                  grammar={row.searchUrlGrammar}
                  computedAt={row.computedAt}
                  overridden={Boolean(pin)}
                  pinnedUrl={pin ? pin.url : null}
                  source={pin?.source}
                  derivedUrl={derivedUrl}
                  homeUrl={row.homeUrl}
                />
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
