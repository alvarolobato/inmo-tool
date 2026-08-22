import { PropertyPairQueue } from "@/components/dedup/PropertyPairQueue";
import { RevisionTabs } from "@/components/admin/RevisionTabs";

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
      {/* #642 P2: Duplicados and Clasificación share one "Revisión" strip
          tab now, so the other queue has to be reachable from here. */}
      <RevisionTabs />
      <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--fg)", marginBottom: 6 }}>
        Revisión de duplicados
      </h1>
      {/* PR #621 review nit: "pares" here (as a count noun, "los pares con
          evidencia media"/"varios pares la corroboren") reinforced the same
          confusing framing D-135 removed from the cards below — reworded
          to "coincidencias"/"señales", matching the cards' own vocabulary.
          "pareja de propiedades" survives: that phrase names the GROUPING
          unit (a property pair), not an advert count, so it isn't the
          confusing usage. */}
      <p style={{ fontSize: 13, color: "var(--fg-muted)" }}>
        El motor de deduplicación compara cada anuncio con los demás y fusiona automáticamente
        los que tienen evidencia concluyente. Las coincidencias con evidencia media quedan aquí,
        agrupadas por pareja de propiedades — una tarjeta es una decisión, aunque varias señales
        la corroboren: confirma la fusión o rechaza la pareja si en realidad son propiedades
        distintas.
      </p>
      <PropertyPairQueue />
    </div>
  );
}
