import { SuggestionQueue } from "@/components/dedup/SuggestionQueue";

export const metadata = {
  title: "Revisión de duplicados — inmo-tool",
};

export default function DedupReviewPage() {
  return (
    <div style={{ padding: "var(--pad)", maxWidth: 900 }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--fg)", marginBottom: 6 }}>
        Revisión de duplicados
      </h1>
      <p style={{ fontSize: 13, color: "var(--fg-muted)" }}>
        El motor de deduplicación compara cada par de anuncios y fusiona automáticamente los que
        tienen evidencia concluyente. Los pares con evidencia media quedan aquí, pendientes de tu
        decisión: confirma la fusión o rechaza el par si en realidad son propiedades distintas.
      </p>
      <SuggestionQueue />
    </div>
  );
}
