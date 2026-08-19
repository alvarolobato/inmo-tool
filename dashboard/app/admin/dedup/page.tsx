import { SuggestionQueue } from "@/components/dedup/SuggestionQueue";

export const metadata = {
  title: "Revisión de duplicados — inmo-tool",
};

export default function DedupReviewPage() {
  return (
    // dedup-page: AdminChrome (app/admin/AdminChrome.tsx) already wraps every
    // /admin/* page's children in its own `padding: var(--pad)` div — this
    // div's OWN padding doubles that up. At desktop width that's just extra
    // margin (left as-is: touching it isn't in scope, and AdminChrome is
    // shared by every admin page, not just this one), but on a 390px phone
    // that redundant second 20px-per-side was costing the comparison panels
    // real width (#576: panels measured 244px instead of the ~300px+ target
    // with it removed). .dedup-page zeroes ITS OWN padding below 768px only
    // (globals.css) — AdminChrome's single padding layer still applies, so
    // spacing doesn't disappear, it just stops doubling. Desktop (>=768px)
    // is untouched.
    <div className="dedup-page" style={{ padding: "var(--pad)", maxWidth: 900 }}>
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
