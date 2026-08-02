/**
 * Home page (`/inicio`, also mounted at `/`).
 *
 * Placeholder pending the real inmo-tool home surface. The original
 * PowerShop retail-KPI home (HeroToday/PeriodGrid/DailyTrendChart/etc.,
 * still under components/home/) queried `ps_ventas` directly and hard-
 * crashed once task 1.2 replaced the schema with the real-estate model —
 * see issue #63. Those components are left in place (not deleted) since
 * Phase 2+ may reuse pieces of them for a real KPI home once there's
 * scored/ranked candidate data to summarize; this page just stops calling
 * into them until that exists.
 */
export default function InicioPage() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100%",
        padding: "64px 24px",
        textAlign: "center",
        gap: 12,
      }}
    >
      <h1 style={{ fontSize: 28, fontWeight: 700, color: "var(--fg)", margin: 0 }}>
        Inmo-Tool
      </h1>
      <p style={{ fontSize: 15, color: "var(--fg-subtle)", maxWidth: 480, margin: 0 }}>
        Plataforma de búsqueda de inversión inmobiliaria. La ingesta de datos
        (Fase 1) está completa; el panel de candidatos y las vistas de
        inversión se están construyendo en fases posteriores.
      </p>
      <div
        style={{
          marginTop: 16,
          padding: "10px 16px",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg-1)",
          fontSize: 13,
          color: "var(--fg-subtle)",
          fontFamily: "var(--font-jetbrains), monospace",
        }}
      >
        Ver progreso: github.com/alvarolobato/inmo-tool/issues/1
      </div>
    </div>
  );
}
