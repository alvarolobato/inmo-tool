import Link from "next/link";
import {
  getPromotionCandidates,
  getCandidatePromotionThreshold,
  type PromotionCandidate,
} from "@/lib/db/redflag-candidates";
import { DismissButton } from "./DismissButton";

export const metadata = {
  title: "Candidatos a promoción — inmo-tool",
};

// Reads Postgres at request time (server-only aggregation) — never prerender.
export const dynamic = "force-dynamic";

/** A single property reference, deep-linked when we know a profile for it. */
function PropertyRef({
  id,
  address,
  profileId,
}: PromotionCandidate["properties"][number]) {
  const label = address?.trim() ? address : `Inmueble #${id}`;
  if (profileId !== null) {
    return (
      <Link
        href={`/profiles/${profileId}/properties/${id}`}
        style={{
          fontSize: 12,
          color: "var(--accent)",
          textDecoration: "none",
          padding: "2px 8px",
          borderRadius: 6,
          background: "var(--accent-soft)",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </Link>
    );
  }
  return (
    <span
      style={{
        fontSize: 12,
        color: "var(--fg-muted)",
        padding: "2px 8px",
        borderRadius: 6,
        background: "var(--bg-2)",
        whiteSpace: "nowrap",
      }}
      title="Sin perfil asociado todavía — no hay enlace directo"
    >
      {label}
    </span>
  );
}

function CandidateCard({ c }: { c: PromotionCandidate }) {
  return (
    <div
      data-testid={`candidato-${c.candidateType}`}
      style={{
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: "var(--bg-1)",
        padding: "var(--pad, 16px)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {/* Header: slug + count + dismiss */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <code
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: "var(--fg)",
            fontFamily: "var(--font-jetbrains, monospace)",
          }}
        >
          {c.candidateType}
        </code>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--accent)",
            background: "var(--accent-soft)",
            padding: "2px 10px",
            borderRadius: 999,
            whiteSpace: "nowrap",
          }}
        >
          {c.count} apariciones
        </span>
        <div style={{ marginLeft: "auto" }}>
          <DismissButton slug={c.candidateType} />
        </div>
      </div>

      {/* Definition */}
      <p
        style={{
          margin: 0,
          fontSize: 13,
          color: c.definition ? "var(--fg)" : "var(--fg-subtle)",
          lineHeight: 1.5,
          fontStyle: c.definition ? "normal" : "italic",
        }}
      >
        {c.definition ?? "Sin definición del modelo."}
      </p>

      {/* Evidence quotes */}
      {c.evidence.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.04em",
              color: "var(--fg-subtle)",
              textTransform: "uppercase",
            }}
          >
            Evidencia
          </span>
          {c.evidence.map((q, i) => (
            <blockquote
              key={i}
              style={{
                margin: 0,
                padding: "6px 12px",
                borderLeft: "3px solid var(--border)",
                fontSize: 12,
                color: "var(--fg-muted)",
                lineHeight: 1.5,
              }}
            >
              “{q}”
            </blockquote>
          ))}
        </div>
      )}

      {/* Property refs */}
      {c.properties.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.04em",
              color: "var(--fg-subtle)",
              textTransform: "uppercase",
            }}
          >
            Inmuebles ({c.properties.length})
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {c.properties.map((p) => (
              <PropertyRef key={p.id} {...p} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default async function AdminCandidatosPage() {
  const threshold = getCandidatePromotionThreshold();
  let candidates: PromotionCandidate[] = [];
  let loadError: string | null = null;
  try {
    candidates = await getPromotionCandidates({ threshold });
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Error al cargar los candidatos.";
  }

  return (
    <div
      data-testid="candidatos-page"
      style={{ maxWidth: 900, display: "flex", flexDirection: "column", gap: 16 }}
    >
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--fg)", margin: "0 0 6px" }}>
          Candidatos a promoción
        </h1>
        <p style={{ fontSize: 13, color: "var(--fg-muted)", margin: 0, lineHeight: 1.6 }}>
          Slugs <code>candidate_type</code> que el modelo ha propuesto en los redflags de tipo{" "}
          <code>other</code> y que ya se han visto al menos{" "}
          <strong>{threshold}</strong>{" "}
          {threshold === 1 ? "vez" : "veces"}. Revísalos y decide cuáles son categorías reales vs.
          ruido.
        </p>
      </div>

      {/* Manual-promotion note — the page never promotes anything itself. */}
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg-2)",
          padding: "10px 14px",
          fontSize: 12,
          color: "var(--fg-muted)",
          lineHeight: 1.6,
        }}
      >
        <strong style={{ color: "var(--fg)" }}>La promoción es manual.</strong> Esta página solo
        surface los candidatos y su evidencia. Promover un slug al vocabulario cerrado de redflags
        (lo que lo hace filtrable) sigue siendo un PR humano — nada se convierte en filtro sin
        revisión.
      </div>

      {loadError && (
        <p
          style={{
            borderRadius: 6,
            border: "1px solid var(--warn, #f59e0b)",
            background: "var(--warn-bg, rgba(245,158,11,0.08))",
            padding: "8px 12px",
            fontSize: 13,
            color: "var(--warn, #f59e0b)",
            margin: 0,
          }}
        >
          {loadError}
        </p>
      )}

      {!loadError && candidates.length === 0 && (
        <div
          data-testid="candidatos-empty"
          style={{
            border: "1px dashed var(--border)",
            borderRadius: 10,
            padding: "40px 20px",
            textAlign: "center",
            color: "var(--fg-muted)",
            fontSize: 13,
          }}
        >
          Aún no hay candidatos sobre el umbral (≥ {threshold}). Se irán llenando a medida que la
          ingesta descubra problemas nuevos que el modelo no sabe nombrar con el vocabulario
          cerrado.
        </div>
      )}

      {!loadError && candidates.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {candidates.map((c) => (
            <CandidateCard key={c.candidateType} c={c} />
          ))}
        </div>
      )}
    </div>
  );
}
