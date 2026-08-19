import { SuggestionQueue } from "@/components/dedup/SuggestionQueue";

export const metadata = {
  title: "Revisión de duplicados — inmo-tool",
};

export default function DedupReviewPage() {
  return (
    // dedup-page: AdminChrome (app/admin/AdminChrome.tsx) already wraps every
    // /admin/* page's children in its own `padding: var(--pad)` div — this
    // page used to apply a second, matching padding of its own on top of
    // that (a real double-padding bug, not just cosmetic — see D-122). The
    // `padding` value now lives entirely in the .dedup-page class
    // (globals.css) instead of here: desktop keeps the exact same var(--pad)
    // value, and the mobile override zeroes THIS page's layer only —
    // AdminChrome's own padding layer still applies underneath, so spacing
    // doesn't disappear, it just stops doubling.
    <div className="dedup-page" style={{ maxWidth: 900 }}>
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
