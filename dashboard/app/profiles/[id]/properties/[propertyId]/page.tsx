"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import type { PropertyDetail } from "@/lib/property-detail";
import type { InvestmentMetrics } from "@/lib/investment-metrics";
import type { StateFeedbackType } from "@/lib/db/feedback";
import { PropertyHeader } from "@/components/property/PropertyHeader";
import { PropertyProblemFlags } from "@/components/property/PropertyProblemFlags";
import { PhotoGallery } from "@/components/property/PhotoGallery";
import { LinkedListings } from "@/components/property/LinkedListings";
import { PropertyDescription, pickDescriptions } from "@/components/property/PropertyDescription";
import { PriceHistoryChart } from "@/components/property/PriceHistoryChart";
import { YieldSection } from "@/components/property/sections/YieldSection";
import { FlipSection } from "@/components/property/sections/FlipSection";
import { InvestorScoreSection } from "@/components/property/sections/InvestorScoreSection";
import { DetailSections, type DetailSection } from "@/components/property/DetailSections";
import { TriageBar } from "@/components/property/TriageBar";

interface Adjacent {
  prevPropertyId: number | null;
  nextPropertyId: number | null;
}

function parseId(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export default function PropertyDetailPage() {
  const params = useParams<{ id: string; propertyId: string }>();
  const router = useRouter();
  const profileId = parseId(params.id);
  const propertyId = parseId(params.propertyId);

  const [property, setProperty] = useState<PropertyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);
  const [adjacent, setAdjacent] = useState<Adjacent>({ prevPropertyId: null, nextPropertyId: null });
  // #585: mirrors `adjacent`, but as a promise `handleVoted` can safely
  // `await` — see that function's doc comment for why reading `adjacent`
  // state directly at vote time is unsafe. Always holds the in-flight (or
  // settled) fetch for the CURRENT (profileId, propertyId, includeRejected),
  // kept in lockstep by the fetch effect below. Never null after the first
  // render since it starts pre-resolved to the initial `{ null, null }`
  // state — a vote fired before profileId/propertyId are even known can't
  // happen (the page returns early below without registering any voteable
  // controls).
  const adjacentPromiseRef = useRef<Promise<Adjacent>>(Promise.resolve(adjacent));
  const [investmentMetrics, setInvestmentMetrics] = useState<InvestmentMetrics | null>(null);
  // #585: set when a confirmed vote landed with no next candidate (the last
  // property in the queue) — the triage bar shows "Fin de la lista" instead
  // of navigating. Reset on every propertyId change (a navigation, whether
  // via the bar or any other link, always lands on a fresh, non-final state
  // until proven otherwise by a vote on THAT page).
  const [endOfQueue, setEndOfQueue] = useState(false);
  useEffect(() => {
    setEndOfQueue(false);
  }, [propertyId]);

  // #417: the feed's "Mostrar descartadas" flag, carried in this page's URL
  // when the user arrived from the show-rejected list. Read from window in a
  // mount effect (SSR-safe — starts false, corrected on the client) rather
  // than useSearchParams, which would force a Suspense boundary. Drives both
  // the prev/next fetch and the neighbour link hrefs so the flag survives the
  // whole chain.
  const [includeRejected, setIncludeRejected] = useState(false);

  useEffect(() => {
    setIncludeRejected(new URLSearchParams(window.location.search).get("includeRejected") === "true");
  }, []);

  // #585: the triage loop's one navigation decision. Called by TriageBar
  // only from FeedbackControls' onVoted — i.e. only after the vote's POST
  // resolved ok (see FeedbackControls.tsx's submitState) — so a flaky
  // network never silently drops a verdict by navigating on the optimistic
  // write. `adjacent` was fetched on mount, before this vote (D-094), so a
  // just-rejected property's OWN nextPropertyId is still the pre-reject
  // value — correct: the rejected card only drops out of the NEXT page's
  // prev/next chain, not this one's. `voteState` (accept/reject) isn't
  // branched on: both verdicts categorise the property and both advance
  // (D-096 — two states, accept IS seguimiento).
  //
  // Awaits `adjacentPromiseRef` rather than reading `adjacent` state
  // directly: a vote confirmed fast enough (a quick, deliberate double-tap;
  // this is exactly what the triage-loop e2e's own immediate-vote tests do)
  // can resolve BEFORE the mount-time GET /adjacent request settles, and
  // `adjacent` state starts at `{ nextPropertyId: null, ... }` — reading it
  // directly at that moment would misread "not loaded yet" as "confirmed no
  // next candidate" and wrongly show "Fin de la lista" on a property that
  // has a real next one. The ref always holds the in-flight (or already
  // resolved) promise for the CURRENT propertyId (see the fetch effect
  // below), so awaiting it here is always correct regardless of timing.
  const handleVoted = async (_voteState: StateFeedbackType) => {
    const resolvedAdjacent = await adjacentPromiseRef.current;
    if (resolvedAdjacent.nextPropertyId === null) {
      setEndOfQueue(true);
      return;
    }
    const qs = includeRejected ? "?includeRejected=true" : "";
    router.push(`/profiles/${profileId}/properties/${resolvedAdjacent.nextPropertyId}${qs}`);
  };

  useEffect(() => {
    if (profileId === null || propertyId === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/profiles/${profileId}/properties/${propertyId}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw isApiErrorResponse(body) ? body : new Error("No se pudo cargar la propiedad.");
        }
        return res.json();
      })
      .then((data: PropertyDetail) => {
        if (!cancelled) setProperty(data);
      })
      .catch((err) => {
        if (!cancelled) setError(isApiErrorResponse(err) ? err : "No se pudo cargar la propiedad.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [profileId, propertyId]);

  // Separate, non-blocking request (#152): the property renders as soon as
  // it's loaded and the prev/next controls fill in behind it. Best-effort —
  // failing to resolve neighbours must not surface an error on a page whose
  // actual content loaded fine.
  useEffect(() => {
    if (profileId === null || propertyId === null) return;
    let cancelled = false;
    setAdjacent({ prevPropertyId: null, nextPropertyId: null });
    // #417: forward the show-rejected flag so prev/next steps through rejected
    // candidates in the same order as the list the user is paging through.
    const adjacentUrl = `/api/profiles/${profileId}/properties/${propertyId}/adjacent${
      includeRejected ? "?includeRejected=true" : ""
    }`;
    // #585: the promise itself (not just its resolved value, via setAdjacent
    // below) is published to `adjacentPromiseRef` so `handleVoted` can await
    // the CURRENT property's real result even if a vote lands before this
    // fetch settles — see that function's doc comment.
    const promise = fetch(adjacentUrl)
      .then((res) => (res.ok ? (res.json() as Promise<Adjacent>) : null))
      .then((data) => {
        const resolved = data ?? { prevPropertyId: null, nextPropertyId: null };
        if (!cancelled) setAdjacent(resolved);
        return resolved;
      })
      .catch(() => {
        /* best-effort — leave the controls disabled */
        return { prevPropertyId: null, nextPropertyId: null };
      });
    adjacentPromiseRef.current = promise;
    return () => {
      cancelled = true;
    };
  }, [profileId, propertyId, includeRejected]);

  // Separate, non-blocking request (task 5.3, #33 — same pattern as
  // `adjacent` above): this is a heavier, multi-query computation (area
  // price median, acquisition costs, amortization) that must not delay the
  // core property content, and a failure here (e.g. no DB reachable for
  // this specific query) must not surface an error banner on an otherwise
  // fine page — the section simply doesn't render.
  useEffect(() => {
    if (profileId === null || propertyId === null) return;
    let cancelled = false;
    setInvestmentMetrics(null);
    fetch(`/api/profiles/${profileId}/properties/${propertyId}/investment`)
      .then((res) => (res.ok ? (res.json() as Promise<InvestmentMetrics>) : null))
      .then((data) => {
        if (!cancelled && data) setInvestmentMetrics(data);
      })
      .catch(() => {
        /* best-effort — section stays absent */
      });
    return () => {
      cancelled = true;
    };
  }, [profileId, propertyId]);

  if (profileId === null || propertyId === null) {
    return (
      <main style={{ maxWidth: 900, margin: "0 auto", padding: 24 }}>
        <ErrorDisplay error="Id de perfil o de propiedad no válido." />
      </main>
    );
  }

  // Core sections (order 10/20 — see DetailSections.tsx for the full slot
  // contract and reserved order numbers for Phase 4/5/6's future sections).
  const sections: DetailSection[] = property
    ? [
        // #452 Puntuación inversora (order 5 — first, above the linked
        // listings): the 0–100 score + band + breakdown + risk chips. Only
        // added when the route resolved the investor-score inputs (best-effort),
        // the same "absent, not a placeholder" rule the other sections follow.
        ...(property.investor_score
          ? [
              {
                id: "investor-score",
                title: "Puntuación inversora",
                order: 5,
                content: <InvestorScoreSection score={property.investor_score} />,
              },
            ]
          : []),
        {
          id: "listings",
          title: "Anuncios vinculados",
          order: 10,
          content: <LinkedListings listings={property.listings} />,
        },
        // Advert description (issue #360 — order 15, between listings and
        // history). Only added when a listing carries non-empty text, so a
        // property with no description shows no empty "Descripción" box —
        // the component and this gate share pickDescriptions().
        ...(pickDescriptions(property.listings).length > 0
          ? [
              {
                id: "description",
                title: "Descripción",
                order: 15,
                content: <PropertyDescription listings={property.listings} />,
              },
            ]
          : []),
        {
          id: "history",
          title: "Historial de precio y estado",
          order: 20,
          content: (
            <PriceHistoryChart priceHistory={property.price_history} statusEvents={property.status_events} />
          ),
        },
        // Investment metrics (task 5.3, #33 — reserved order 40). Only
        // added once loaded, same "absent rather than a placeholder" rule
        // CandidateCard's `flags` field follows — a slow/failed fetch means
        // no section, never a skeleton competing with the rest of the page.
        ...(investmentMetrics !== null
          ? [
              {
                id: "investment",
                title: "Métricas de inversión",
                order: 40,
                content: <YieldSection metrics={investmentMetrics} />,
              },
            ]
          : []),
        // Buy-to-flip metrics (issue #45 — reserved order 45). Gated: only
        // present when the profile's thesis_type is "flip" (getInvestmentMetrics
        // returns flip=null otherwise), so a rental profile never sees it.
        ...(investmentMetrics?.flip
          ? [
              {
                id: "flip",
                title: "Reforma, ARV y margen de flip",
                order: 45,
                content: <FlipSection metrics={investmentMetrics} />,
              },
            ]
          : []),
      ]
    : [];

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: 24 }} data-testid="property-detail-page">
      <Link
        href={`/profiles/${profileId}`}
        style={{ fontSize: 12, color: "var(--fg-muted)", display: "inline-block" }}
      >
        ← Volver al perfil
      </Link>

      {/*
        #585: the triage bar replaces both the old non-sticky prev/next row
        AND the mid-page "Tu valoración" box with ONE sticky control surface
        — see TriageBar.tsx's doc comment for the full rationale. It mounts
        unconditionally (not gated behind `loading`/`property`) since
        prev/next and the vote controls only need profileId/propertyId,
        already known from the route; the price/score chip is simply absent
        until `property` arrives, the page's existing best-effort convention.
      */}
      <TriageBar
        profileId={profileId}
        propertyId={propertyId}
        property={property}
        prevPropertyId={adjacent.prevPropertyId}
        nextPropertyId={adjacent.nextPropertyId}
        includeRejected={includeRejected}
        endOfQueue={endOfQueue}
        onVoted={handleVoted}
      />

      {loading && (
        <p style={{ marginTop: 16, fontSize: 13, color: "var(--fg-muted)" }}>Cargando propiedad…</p>
      )}

      {error && <ErrorDisplay error={error} className="mt-4" />}

      {!loading && !error && property && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 20 }}>
          <PropertyHeader property={property} />
          {/* #361 problem flags — own component/section, kept separate from
              where #360 adds the advert description, to minimize conflict. */}
          <PropertyProblemFlags flags={property.problem_flags} />
          <PhotoGallery photoUrls={property.photo_urls} lat={property.lat} lon={property.lon} />
          <DetailSections sections={sections} />
        </div>
      )}
    </main>
  );
}
