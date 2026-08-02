import type { ReactNode } from "react";

/**
 * Extension-point contract for the property detail page (task 2.8, #44).
 *
 * This task builds the page shell and the sections with real data today
 * (linked listings, price/status history). Later phases each add their own
 * section by:
 *   1. Building their own component (e.g. `components/property/sections/
 *      AiAssessmentSection.tsx`, `YieldSection.tsx`, `NotesSection.tsx`).
 *   2. Adding ONE entry to the `sections` array built in
 *      `app/profiles/[id]/properties/[propertyId]/page.tsx`, using one of
 *      the `order` numbers already reserved below.
 *
 * No task after this one needs to edit this file or any of the "core"
 * section components (PropertyHeader/PhotoGallery/PriceHistoryChart/
 * LinkedListings) — they only ever add a new array entry in page.tsx.
 *
 * Reserved `order` values (gaps left deliberately so a section can be
 * inserted between two existing ones without renumbering everything):
 *   10  — Linked listings (this task)
 *   20  — Price/status history (this task)
 *   30  — AI assessment (task 4.4, #27 — occupancy/condition/red-flags)
 *   40  — Investment metrics / yield (task 5.3, #33)
 *   50  — Notes & activity log (task 6.2, #37)
 */
export interface DetailSection {
  id: string;
  title: string;
  order: number;
  content: ReactNode;
}

export function DetailSections({ sections }: { sections: DetailSection[] }) {
  const sorted = [...sections].sort((a, b) => a.order - b.order);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {sorted.map((s) => (
        <section key={s.id} data-section-id={s.id}>
          <h2 style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 600, color: "var(--fg)" }}>{s.title}</h2>
          {s.content}
        </section>
      ))}
    </div>
  );
}
