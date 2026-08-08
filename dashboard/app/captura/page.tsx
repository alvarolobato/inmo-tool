import Link from "next/link";
import { CapturaProfiles } from "@/components/captura/CapturaProfiles";
import { listActiveProfiles } from "@/lib/db/profiles";
import { resolveSearchTasks } from "@/lib/search-url/resolve";
import { getTaskRuns, getProfileConnectorCaptured } from "@/lib/db/capture-task-run";
import { getStalenessConfig } from "@/lib/captura-staleness-config";
import { buildProfileCaptureView, type ProfileCaptureView } from "@/lib/captura-tasks";

/**
 * Captura — task-driven guided-capture EXECUTION page (issue #237 → #289 →
 * redesign #413).
 *
 * #413 redesign: instead of a profile DROPDOWN showing one profile at a time,
 * this now STACKS every active profile, one under another. Under each profile
 * its connectors (portals) render as COLLAPSIBLE sections: a connector that is
 * DUE (nothing done this cycle) or A-MEDIAS (a batch started but not finished)
 * starts EXPANDED with its launch buttons; one that is "al día" collapses to a
 * single stats line. The owner sees at a glance exactly which captures are
 * pending across all profiles, and can still expand/collapse any connector by
 * hand to run one even when it is not due.
 *
 * Now a SERVER component (was client + client-side fetch fan-out): it reads all
 * profiles, their pre-filtered tasks (learned-aware, {@link resolveSearchTasks}),
 * the per-profile task-run ledger (staleness → due/collapse), and the
 * per-profile captured counts, then hands a fully-computed view-model to the
 * client {@link CapturaProfiles}. The page shows ONLY profile-scoped numbers —
 * no portal-global figures (#445). The due/collapse decision is
 * derived purely from each task's last-run timestamp vs. the staleness window —
 * see lib/captura-tasks `buildConnectorViews`.
 *
 * `force-dynamic`: every load reflects the live ledger (no static caching).
 * Admin-gated by middleware.ts like every page.
 */
export const dynamic = "force-dynamic";

export default async function CapturaPage() {
  let views: ProfileCaptureView[] = [];
  let loadError = false;

  try {
    const now = new Date();
    const staleness = getStalenessConfig();
    const profiles = await listActiveProfiles();

    // Resolve every profile's tasks + run ledger first, so we know exactly which
    // (profile, connector) pairs are on screen before the per-profile captured
    // query — it is bounded to those ids/connectors (issue #430), never a
    // full-table scan.
    const perProfile = await Promise.all(
      profiles.map(async (p) => {
        const [tasks, runs] = await Promise.all([resolveSearchTasks(p.scope, p.id), getTaskRuns(p.id)]);
        return { profile: p, tasks, runs };
      }),
    );

    const profileIds = perProfile.map((x) => x.profile.id);
    const connectors = Array.from(
      new Set(perProfile.flatMap((x) => x.tasks.map((t) => t.portal))),
    );
    const capturedByProfileConnector = await getProfileConnectorCaptured(profileIds, connectors);

    views = perProfile.map(({ profile, tasks, runs }) =>
      buildProfileCaptureView(profile, tasks, runs, staleness, capturedByProfileConnector, now),
    );
  } catch {
    // Never surface a technical error page: the capture ledger is best-effort
    // context, not a hard dependency. Render a benign notice and let the owner
    // retry — the D-041 e2e asserts no error surface under seeded data.
    loadError = true;
  }

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
        Todos tus perfiles, uno debajo de otro. Bajo cada perfil, sus conectores: los que{" "}
        <strong>toca ejecutar</strong> o están <strong>a medias</strong> se muestran abiertos con sus
        botones de captura; los que están al día se pliegan en una línea. Puedes abrir o plegar
        cualquiera a mano para lanzar una captura aunque no toque. La configuración (extensión, clave,
        conectores) vive en{" "}
        <Link href="/etl/captura" style={{ color: "var(--accent)", textDecoration: "none" }}>
          Admin · Captura
        </Link>
        .
      </p>

      {loadError ? (
        <p
          data-testid="captura-load-notice"
          style={{
            marginTop: 20,
            fontSize: 13,
            color: "var(--fg-muted)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: 16,
            background: "var(--bg-1)",
          }}
        >
          No se pudo cargar la captura ahora mismo. Vuelve a intentarlo en unos segundos.
        </p>
      ) : views.length === 0 ? (
        <div
          data-testid="captura-no-profiles"
          style={{
            marginTop: 20,
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
        <section style={{ marginTop: 20 }}>
          <CapturaProfiles profiles={views} />
        </section>
      )}
    </main>
  );
}
