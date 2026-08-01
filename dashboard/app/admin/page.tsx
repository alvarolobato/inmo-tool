import Link from "next/link";

export const metadata = {
  title: "Admin — PowerShop Analytics",
};

const ADMIN_LINKS = [
  {
    href: "/etl",
    label: "Monitor ETL",
    description: "Estado de sincronización, ejecuciones recientes y estadísticas del proceso ETL.",
  },
  {
    href: "/admin/slow-queries",
    label: "Consultas lentas",
    description: "Consultas SQL lentas registradas en los últimos días.",
  },
  {
    href: "/admin/tool-calls",
    label: "Herramientas LLM",
    description: "Uso de herramientas agenticas del modelo de lenguaje.",
  },
  {
    href: "/admin/usage",
    label: "Uso LLM",
    description: "Tokens consumidos y coste estimado por proveedor y función.",
  },
  {
    href: "/admin/interactions",
    label: "Interacciones LLM",
    description: "Historial de interacciones generate/modify/analyze con logs de herramientas.",
  },
  {
    href: "/admin/config",
    label: "Configuración",
    description: "Ver y editar la configuración del sistema (config.yaml) desde el navegador.",
  },
] as const;

export default function AdminIndexPage() {
  return (
    <div style={{ padding: "var(--pad)", maxWidth: 720 }}>
      <h1
        style={{
          fontSize: 20,
          fontWeight: 700,
          color: "var(--fg)",
          marginBottom: 6,
        }}
      >
        Administración
      </h1>
      <p style={{ fontSize: 13, color: "var(--fg-muted)", marginBottom: 24 }}>
        Herramientas de monitorización y diagnóstico del sistema.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: "var(--gap)",
        }}
      >
        {ADMIN_LINKS.map(({ href, label, description }) => (
          <Link
            key={href}
            href={href}
            style={{
              display: "block",
              padding: "var(--pad)",
              background: "var(--bg-1)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              textDecoration: "none",
              transition: "border-color 0.15s, background 0.15s",
            }}
          >
            <span
              style={{
                display: "block",
                fontSize: 14,
                fontWeight: 600,
                color: "var(--fg)",
                marginBottom: 6,
              }}
            >
              {label}
            </span>
            <span
              style={{
                display: "block",
                fontSize: 12,
                color: "var(--fg-muted)",
                lineHeight: 1.5,
              }}
            >
              {description}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
