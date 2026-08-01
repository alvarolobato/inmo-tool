import Link from "next/link";
import { loginAdmin } from "./actions";
import { safeAdminRedirectTarget } from "@/lib/admin-redirect";

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: { error?: string; redirect?: string };
}) {
  const sp = searchParams;
  const err = sp.error === "1";
  const noConfig = sp.error === "2";
  // Sanitize early so the hidden input only ever carries a safe local path.
  const redirectTarget = safeAdminRedirectTarget(sp.redirect);

  return (
    <div
      style={{
        maxWidth: 400,
        margin: "0 auto",
        padding: "24px",
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--bg-1)",
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <h1 style={{ fontSize: 17, fontWeight: 600, color: "var(--fg)", margin: 0 }}>
        Acceso administración
      </h1>
      <p style={{ fontSize: 13, color: "var(--fg-muted)", margin: 0 }}>
        Introduce la clave configurada en{" "}
        <code
          style={{
            borderRadius: 3,
            background: "var(--bg-2)",
            padding: "1px 5px",
            fontFamily: "var(--font-jetbrains, monospace)",
            fontSize: 12,
          }}
        >
          ADMIN_API_KEY
        </code>
        .
      </p>
      {err && (
        <p style={{ fontSize: 13, color: "var(--down)", margin: 0 }} role="alert">
          Clave incorrecta.
        </p>
      )}
      {noConfig && (
        <p style={{ fontSize: 13, color: "var(--warn)", margin: 0 }} role="alert">
          Falta{" "}
          <code
            style={{
              borderRadius: 3,
              background: "var(--bg-2)",
              padding: "1px 5px",
              fontFamily: "var(--font-jetbrains, monospace)",
              fontSize: 12,
            }}
          >
            ADMIN_API_KEY
          </code>{" "}
          en el entorno del servidor.
        </p>
      )}
      <form action={loginAdmin} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <input type="hidden" name="redirect" value={redirectTarget} />
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            fontSize: 13,
            fontWeight: 500,
            color: "var(--fg)",
          }}
        >
          Clave
          <input
            type="password"
            name="password"
            required
            autoComplete="current-password"
            style={{
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-2)",
              color: "var(--fg)",
              padding: "8px 12px",
              fontSize: 13,
              outline: "none",
              fontFamily: "inherit",
            }}
          />
        </label>
        <button
          type="submit"
          style={{
            borderRadius: 6,
            background: "var(--accent)",
            color: "#fff",
            padding: "9px 16px",
            fontSize: 13,
            fontWeight: 500,
            border: "none",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Entrar
        </button>
      </form>
      <Link
        href="/"
        style={{
          display: "block",
          textAlign: "center",
          fontSize: 13,
          color: "var(--accent)",
          textDecoration: "none",
        }}
      >
        Volver al inicio
      </Link>
    </div>
  );
}
