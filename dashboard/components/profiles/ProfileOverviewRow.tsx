"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react";
import type { ProfileOverviewEntry } from "@/lib/profile-overview-types";
import { PROPERTY_TYPE_LABELS, type PROPERTY_TYPES } from "@/lib/profiles-schema";
import { fmtEUR0, fmtInt } from "@/components/widgets/format";
import { ZeroCandidatesDiagnostic } from "./ZeroCandidatesDiagnostic";

const MIN_TRAINING_EXAMPLES = 32; // mirrors lib/scoring/pipeline.ts's MIN_TRAINING_EXAMPLES (4 * 8 features) — see note below.

/**
 * One row in the redesigned Perfiles list (issue #193), backed by
 * `GET /api/profiles/overview` (issue #192). Two shapes, both rendered here
 * so the caller doesn't need its own branch: a normal `{ok: true}` profile
 * with metrics + thumbnails, and a malformed-scope `{ok: false}` profile
 * (issue #113) rendered as a visibly broken row instead of being dropped.
 *
 * Entering (row / "Entrar →") is the only primary-weight action —
 * Editar/Clonar/Archivar sit behind a kebab overflow menu (Headless UI
 * `Menu`, keyboard-reachable and screen-reader-labelled out of the box,
 * rather than a hand-rolled hover-only control — see AGENTS.md's note on
 * the invisible-but-clickable control regression this project has already
 * hit once).
 */
export function ProfileOverviewRow({
  entry,
  onEdit,
  onClone,
  onArchive,
  busy,
  highlighted = false,
}: {
  entry: ProfileOverviewEntry;
  onEdit: () => void;
  onClone: () => void;
  onArchive: () => void;
  busy: boolean;
  /** Issue #195: the "novedades" strip's jump-to briefly rings this row when it's the profile that changed. */
  highlighted?: boolean;
}) {
  if (!entry.ok) {
    return <BrokenProfileRow id={entry.id} name={entry.name} issues={entry.issues} onEdit={onEdit} onArchive={onArchive} busy={busy} />;
  }
  return <ValidProfileRow entry={entry} onEdit={onEdit} onClone={onClone} onArchive={onArchive} busy={busy} highlighted={highlighted} />;
}

const rowStyle: React.CSSProperties = {
  position: "relative",
  display: "flex",
  gap: 12,
  padding: "14px 12px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg-1)",
  marginBottom: 10,
};

const kebabButtonStyle: React.CSSProperties = {
  position: "absolute",
  top: 10,
  right: 10,
  width: 28,
  height: 28,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--fg-muted)",
  cursor: "pointer",
  fontSize: 16,
  lineHeight: 1,
};

// `<MenuItems anchor="bottom end">` positions the panel itself (Headless UI
// portals it and sets its own `position`/`left`/`top` via floating-ui). This
// style must therefore NOT set `position`/`right`/`top`: a manual `right: 0`
// layered on top of floating-ui's computed `left`, on a portaled element with
// no width, makes the panel stretch from that left edge to the viewport's
// right edge — it rendered full-viewport-width (1280px) instead of hugging its
// three short labels. `width: max-content` sizes the panel to its content
// (the labels), `minWidth` keeps a comfortable floor, `maxWidth` a safety cap.
const menuItemsStyle: React.CSSProperties = {
  zIndex: 20,
  width: "max-content",
  minWidth: 140,
  maxWidth: 240,
  background: "var(--bg-2)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 4,
  boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
};

function menuItemStyle(disabled: boolean, danger?: boolean): React.CSSProperties {
  return {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "7px 10px",
    fontSize: 13,
    borderRadius: 5,
    border: "none",
    background: "transparent",
    color: disabled ? "var(--fg-subtle)" : danger ? "var(--down)" : "var(--fg)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
  };
}

function OverflowMenu({
  onEdit,
  onClone,
  onArchive,
  busy,
  cloneDisabled,
  cloneDisabledReason,
}: {
  onEdit: () => void;
  onClone: () => void;
  onArchive: () => void;
  busy: boolean;
  cloneDisabled?: boolean;
  cloneDisabledReason?: string;
}) {
  return (
    <Menu as="div" style={{ position: "absolute", top: 10, right: 10 }}>
      <MenuButton
        aria-label="Más acciones para este perfil"
        title="Más acciones"
        style={kebabButtonStyle}
        disabled={busy}
        // Keep the kebab out of the row's own navigation link — this
        // element is rendered as a sibling of the <Link>, never nested
        // inside it (same discipline CandidateCard/FeedbackControls use),
        // so no stopPropagation footgun is needed here.
      >
        ⋮
      </MenuButton>
      <MenuItems anchor="bottom end" style={menuItemsStyle}>
        <MenuItem>
          <button type="button" onClick={onEdit} disabled={busy} style={menuItemStyle(busy)}>
            Editar
          </button>
        </MenuItem>
        <MenuItem>
          <button
            type="button"
            onClick={onClone}
            disabled={busy || cloneDisabled}
            title={cloneDisabled ? cloneDisabledReason : undefined}
            style={menuItemStyle(busy || Boolean(cloneDisabled))}
          >
            Clonar
          </button>
        </MenuItem>
        <MenuItem>
          <button type="button" onClick={onArchive} disabled={busy} style={menuItemStyle(busy, true)}>
            Archivar
          </button>
        </MenuItem>
      </MenuItems>
    </Menu>
  );
}

function Thumbnails({ thumbnails }: { thumbnails: { property_id: number; photo_url: string | null }[] }) {
  const slots = [0, 1, 2, 3];
  return (
    <div style={{ display: "flex", gap: 4, flexShrink: 0 }} data-testid="profile-thumbnails">
      {slots.map((i) => {
        const thumb = thumbnails[i];
        return (
          <div
            key={thumb?.property_id ?? `empty-${i}`}
            style={{
              width: 52,
              height: 52,
              borderRadius: 6,
              overflow: "hidden",
              background: "var(--bg-2)",
              flexShrink: 0,
            }}
          >
            {thumb?.photo_url ? (
              /* eslint-disable-next-line @next/next/no-img-element -- external, unpredictable-domain photo URLs, same as CandidateCard/CandidatePhotoTicker. */
              <img
                src={thumb.photo_url}
                alt=""
                loading="lazy"
                data-testid="profile-thumb-img"
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
              />
            ) : (
              <div
                data-testid="profile-thumb-placeholder"
                style={{ width: "100%", height: "100%" }}
                aria-hidden="true"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function BrokenProfileRow({
  id,
  name,
  issues,
  onEdit,
  onArchive,
  busy,
}: {
  id: number;
  name: string;
  issues: string[];
  onEdit: () => void;
  onArchive: () => void;
  busy: boolean;
}) {
  return (
    <div style={rowStyle} data-testid="profile-row-broken" data-profile-id={id}>
      <div style={{ flex: 1, paddingRight: 36 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <p style={{ fontWeight: 500, color: "var(--fg)", margin: 0, fontSize: 14 }}>{name}</p>
          <span
            data-testid="profile-invalid-badge"
            style={{
              fontSize: 10,
              fontWeight: 600,
              padding: "2px 6px",
              borderRadius: 4,
              background: "var(--down-bg)",
              color: "var(--down)",
            }}
          >
            Configuración inválida
          </span>
        </div>
        <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12, color: "var(--fg-muted)" }}>
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
        {/* Entrar/Clonar have no sensible target for a scope that can't be
            parsed — only Editar (which may still fail to populate the form,
            in which case Archivar is the fallback) and Archivar make sense. */}
      </div>
      <OverflowMenu
        onEdit={onEdit}
        onClone={() => {}}
        onArchive={onArchive}
        busy={busy}
        cloneDisabled
        cloneDisabledReason="No se puede clonar un perfil con configuración inválida."
      />
    </div>
  );
}

function ValidProfileRow({
  entry,
  onEdit,
  onClone,
  onArchive,
  busy,
  highlighted = false,
}: {
  entry: Extract<ProfileOverviewEntry, { ok: true }>;
  onEdit: () => void;
  onClone: () => void;
  onArchive: () => void;
  busy: boolean;
  highlighted?: boolean;
}) {
  const { profile, metrics } = entry;
  const [showZeroDiagnostic, setShowZeroDiagnostic] = useState(false);

  const typeLabels = profile.scope.property_types
    .map((t) => (t in PROPERTY_TYPE_LABELS ? PROPERTY_TYPE_LABELS[t as (typeof PROPERTY_TYPES)[number]] : t))
    .join(", ");

  const priceRange =
    metrics.min_price !== null && metrics.max_price !== null
      ? metrics.min_price === metrics.max_price
        ? fmtEUR0(metrics.min_price)
        : `${fmtEUR0(metrics.min_price)}–${fmtEUR0(metrics.max_price)}` +
          (metrics.median_price !== null ? ` (mediana ${fmtEUR0(metrics.median_price)})` : "")
      : null;

  const modelLabel = metrics.model_trained
    ? `entrenado (${fmtInt(metrics.trained_count)} candidatos puntuados)`
    : `cold-start (${fmtInt(metrics.training_example_count ?? 0)}/${MIN_TRAINING_EXAMPLES} valoraciones para entrenar)`;

  return (
    <div
      id={`profile-row-${profile.id}`}
      style={{
        ...rowStyle,
        flexDirection: "column",
        gap: 0,
        ...(highlighted
          ? { borderColor: "var(--accent)", boxShadow: "0 0 0 2px var(--accent)" }
          : {}),
        transition: "box-shadow 0.2s ease, border-color 0.2s ease",
      }}
      data-testid="profile-row"
      data-profile-id={profile.id}
      data-highlighted={highlighted ? "true" : undefined}
    >
      <div style={{ display: "flex", gap: 12, width: "100%" }}>
      <Thumbnails thumbnails={metrics.thumbnails} />

      {/*
        "¿Por qué 0?" is a real <button>, deliberately a SIBLING of the
        <Link> below, never nested inside it — this codebase already
        documents (CandidateCard.tsx/FeedbackControls.tsx) that interactive
        content inside an <a> is invalid HTML, and relying on
        stopPropagation alone to fix it has already produced a real bug here
        (a "recent card change had to fix an invisible-but-clickable control
        that wrote real feedback rows on a stray click"). Both live in this
        shared flex:1 column so they read as one visual block.
      */}
      <div style={{ flex: 1, minWidth: 0, paddingRight: 36 }}>
        <Link
          href={`/profiles/${profile.id}`}
          style={{ display: "block", textDecoration: "none", color: "inherit" }}
          data-testid="profile-row-link"
        >
          <p style={{ fontWeight: 500, color: "var(--fg)", margin: 0, fontSize: 14 }}>{profile.name}</p>
          <p style={{ fontSize: 12, color: "var(--fg-subtle)", margin: "2px 0 0" }}>
            {typeLabels} · radio {profile.scope.geography.radius_km} km
          </p>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "4px 14px",
              marginTop: 8,
              fontSize: 12,
              color: "var(--fg-muted)",
            }}
          >
            <span data-testid="profile-metric-matched">
              <strong style={{ color: "var(--fg)" }}>{fmtInt(metrics.matched_count)}</strong> candidatos
            </span>
            <span data-testid="profile-metric-new">
              <strong style={{ color: metrics.new_count > 0 ? "var(--up)" : "var(--fg)" }}>
                {fmtInt(metrics.new_count)}
              </strong>{" "}
              nuevos
            </span>
            {priceRange !== null && <span data-testid="profile-metric-price">{priceRange}</span>}
            <span data-testid="profile-metric-model">{modelLabel}</span>
            {metrics.gross_yield_median_pct !== null && (
              <span data-testid="profile-metric-yield">
                yield bruto ~
                {metrics.gross_yield_median_pct.toLocaleString("es-ES", {
                  minimumFractionDigits: 1,
                  maximumFractionDigits: 1,
                })}
                % (estimado)
              </span>
            )}
            {metrics.flagged_count > 0 && (
              <span data-testid="profile-metric-flags" style={{ color: "var(--warn)" }}>
                {fmtInt(metrics.flagged_count)} con alertas
              </span>
            )}
          </div>
        </Link>

        {metrics.matched_count === 0 && (
          <button
            type="button"
            data-testid="profile-zero-why-link"
            onClick={() => setShowZeroDiagnostic((v) => !v)}
            style={{
              marginTop: 6,
              padding: 0,
              background: "transparent",
              border: "none",
              color: "var(--accent)",
              fontSize: 12,
              cursor: "pointer",
              textDecoration: "underline",
            }}
          >
            {showZeroDiagnostic ? "Ocultar diagnóstico" : "¿Por qué 0?"}
          </button>
        )}
      </div>

      <div
        style={{
          alignSelf: "center",
          flexShrink: 0,
        }}
      >
        <Link
          href={`/profiles/${profile.id}`}
          data-testid="profile-enter-button"
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

      <OverflowMenu onEdit={onEdit} onClone={onClone} onArchive={onArchive} busy={busy} />
      </div>

      {metrics.matched_count === 0 && showZeroDiagnostic && (
        <div style={{ width: "100%", paddingLeft: 64 }}>
          <ZeroCandidatesDiagnostic profileId={profile.id} />
        </div>
      )}
    </div>
  );
}
