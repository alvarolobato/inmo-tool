import Link from "next/link";
import { ADMIN_LLM_SUBPAGES } from "@/lib/admin-nav";

export const metadata = {
  title: "LLM — Admin",
};

/**
 * Consolidated landing for the four LLM diagnostics surfaces (#508). The strip
 * used to carry four separate tabs (Consultas lentas, Herramientas LLM, Uso
 * LLM, Interacciones); they now live under one "LLM" tab whose landing links to
 * each. The existing routes are untouched — this page only groups them, and the
 * strip highlights the LLM tab on any of the four (see activeAdminHref).
 */
export default function AdminLlmPage() {
  return (
    <div
      data-testid="admin-llm-page"
      style={{ padding: "var(--pad)", maxWidth: 720 }}
    >
      <h1
        style={{
          fontSize: 20,
          fontWeight: 700,
          color: "var(--fg)",
          marginBottom: 6,
        }}
      >
        LLM
      </h1>
      <p style={{ fontSize: 13, color: "var(--fg-muted)", marginBottom: 24 }}>
        Diagnóstico del modelo de lenguaje: rendimiento de las consultas, uso de
        herramientas, tokens/coste e historial de interacciones.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: "var(--gap)",
        }}
      >
        {ADMIN_LLM_SUBPAGES.map(({ href, label, description }) => (
          <Link
            key={href}
            href={href}
            data-testid={`admin-llm-link-${href.replace("/admin/", "")}`}
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
