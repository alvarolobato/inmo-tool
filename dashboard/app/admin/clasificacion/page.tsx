import Link from "next/link";
import {
  getPromotionCandidates,
  getCandidatePromotionThreshold,
  type PromotionCandidate,
} from "@/lib/db/redflag-candidates";
import { DismissButton } from "./DismissButton";

export const metadata = {
  title: "Clasificación — inmo-tool",
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
  // #606: these pills sit in a `flexWrap: "wrap"` row (their container,
  // below), but `whiteSpace: "nowrap"` fixes each pill's own width at its
  // full text's min-content size — a real listing address is easily long
  // enough on its own to exceed a 390px viewport, and by default a flex
  // item can't shrink below its own min-content width regardless of how
  // much the row wraps around it.
  //
  // `overflow: "hidden"` is the whole fix: a flex item whose `overflow` is
  // anything other than `visible` gets an automatic minimum size of 0
  // (CSS Sizing 3 §5.2), so the nowrap pill becomes free to shrink to the
  // space its wrapped line actually has, and `textOverflow` renders the
  // ellipsis. Measured at 390px: pills shrink 540 -> 300px, `main
  // .main-content` scrollWidth 390 == clientWidth 390.
  //
  // Deliberately NO `maxWidth` cap. An earlier revision of this fix added
  // `maxWidth: "min(240px, 60vw)"`; it did no work (removing only that
  // line keeps mobile-clasificacion.spec.ts green) and was actively
  // harmful in two ways, both measured:
  //   - Phone: five properties on the same street all render at an
  //     identical 234px and read as the same truncated prefix. Spanish
  //     addresses put the distinguishing part ("número 123, piso 4B") at
  //     the END, so a tighter cap truncates exactly the bytes that tell
  //     two candidates apart.
  //   - Desktop: at 1440px it capped a pill that had room to render in
  //     full at 240px instead of 540px — a regression on a width that had
  //     no overflow problem to begin with.
  // Let `overflow: hidden` truncate only when the line genuinely runs out
  // of room, and never above that.
  const capStyle: React.CSSProperties = {
    overflow: "hidden",
    textOverflow: "ellipsis",
  };
  if (profileId !== null) {
    return (
      <Link
        href={`/profiles/${profileId}/properties/${id}`}
        title={label}
        style={{
          fontSize: 12,
          color: "var(--accent)",
          textDecoration: "none",
          padding: "2px 8px",
          borderRadius: 6,
          background: "var(--accent-soft)",
          whiteSpace: "nowrap",
          display: "inline-block",
          ...capStyle,
        }}
      >
        {label}
      </Link>
    );
  }
  // The full address must stay recoverable on hover/long-press in this
  // branch too — `overflow: hidden` truncates here exactly as it does in
  // the linked branch above, so a `title` that only explained the missing
  // link (what this used to say) left a truncated address with no recovery
  // path at all.
  return (
    <span
      style={{
        fontSize: 12,
        color: "var(--fg-muted)",
        padding: "2px 8px",
        borderRadius: 6,
        background: "var(--bg-2)",
        whiteSpace: "nowrap",
        display: "inline-block",
        ...capStyle,
      }}
      title={`${label} — sin perfil asociado todavía, no hay enlace directo`}
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

export default async function AdminClasificacionPage() {
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
      data-testid="clasificacion-page"
      style={{ maxWidth: 900, display: "flex", flexDirection: "column", gap: 16 }}
    >
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--fg)", margin: "0 0 6px" }}>
          Clasificación — vocabulario de redflags
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
          data-testid="clasificacion-empty"
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
