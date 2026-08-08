"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import type { PropertyDetail } from "@/lib/property-detail";
import type { InvestmentMetrics } from "@/lib/investment-metrics";
import { PropertyHeader } from "@/components/property/PropertyHeader";
import { PropertyProblemFlags } from "@/components/property/PropertyProblemFlags";
import { PhotoGallery } from "@/components/property/PhotoGallery";
import { LinkedListings } from "@/components/property/LinkedListings";
import { PropertyDescription, pickDescriptions } from "@/components/property/PropertyDescription";
import { PriceHistoryChart } from "@/components/property/PriceHistoryChart";
import { YieldSection } from "@/components/property/sections/YieldSection";
import { FlipSection } from "@/components/property/sections/FlipSection";
import { DetailSections, type DetailSection } from "@/components/property/DetailSections";
import { FeedbackControls } from "@/components/candidates/FeedbackControls";

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

const adjacentStyle: React.CSSProperties = {
  padding: "4px 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  fontSize: 12,
  textDecoration: "none",
};

function AdjacentLink({
  profileId,
  propertyId,
  testId,
  label,
  includeRejected,
}: {
  profileId: number;
  propertyId: number | null;
  testId: string;
  label: string;
  // #417: carry the show-rejected flag into the neighbour link so the flag
  // survives the whole prev/next chain — otherwise the second hop would drop
  // it and revert to the default (rejected-excluded) ordering, desyncing from
  // the list the user is paging through.
  includeRejected: boolean;
}) {
  if (propertyId === null) {
    return (
      <span
        data-testid={testId}
        aria-disabled="true"
        style={{ ...adjacentStyle, color: "var(--fg-subtle)", opacity: 0.5 }}
      >
        {label}
      </span>
    );
  }
  return (
    <Link
      data-testid={testId}
      href={`/profiles/${profileId}/properties/${propertyId}${
        includeRejected ? "?includeRejected=true" : ""
      }`}
      style={{ ...adjacentStyle, color: "var(--fg)" }}
    >
      {label}
    </Link>
  );
}

export default function PropertyDetailPage() {
  const params = useParams<{ id: string; propertyId: string }>();
  const profileId = parseId(params.id);
  const propertyId = parseId(params.propertyId);

  const [property, setProperty] = useState<PropertyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);
  const [adjacent, setAdjacent] = useState<Adjacent>({ prevPropertyId: null, nextPropertyId: null });
  const [investmentMetrics, setInvestmentMetrics] = useState<InvestmentMetrics | null>(null);
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
    fetch(adjacentUrl)
      .then((res) => (res.ok ? (res.json() as Promise<Adjacent>) : null))
      .then((data) => {
        if (!cancelled && data) setAdjacent(data);
      })
      .catch(() => {
        /* best-effort — leave the controls disabled */
      });
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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <Link href={`/profiles/${profileId}`} style={{ fontSize: 12, color: "var(--fg-muted)" }}>
          ← Volver al perfil
        </Link>

        {/*
          Prev/next through the profile's ranking (#152) so a review session
          doesn't bounce back to the list between every property. Rendered as
          disabled <span>s at the ends rather than hidden, so the controls
          don't jump position as you move through the queue.
        */}
        <nav aria-label="Navegación entre candidatos" style={{ display: "flex", gap: 8 }}>
          <AdjacentLink
            profileId={profileId}
            propertyId={adjacent.prevPropertyId}
            testId="candidate-prev"
            label="← Anterior"
            includeRejected={includeRejected}
          />
          <AdjacentLink
            profileId={profileId}
            propertyId={adjacent.nextPropertyId}
            testId="candidate-next"
            label="Siguiente →"
            includeRejected={includeRejected}
          />
        </nav>
      </div>

      {loading && (
        <p style={{ marginTop: 16, fontSize: 13, color: "var(--fg-muted)" }}>Cargando propiedad…</p>
      )}

      {error && <ErrorDisplay error={error} className="mt-4" />}

      {!loading && !error && property && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 20 }}>
          <PropertyHeader property={property} />
          {/*
            #417: the same seguir(accept)/descartar(reject) controls the feed
            card carries (#422 retired the star toggle),
            mounted here so you can reject/track from the page you're reading —
            reusing FeedbackControls (no new feedback logic). initialState is
            omitted, so it self-fetches this property's current verdict on mount
            (its original behaviour). Deferred-removal semantics are unchanged:
            a reject writes the event and the card drops out of the feed on the
            NEXT fetch, not here. Wrapped so the overlay-styled buttons read as
            an intentional control row on the detail page.
          */}
          <div
            data-testid="detail-feedback-controls"
            // #448 H: the feedback toggles default to opacity:0 (revealed by
            // `.candidate-card:hover` on the feed). This detail-page row has no
            // such card ancestor, so without this class the buttons stayed
            // invisible until a click set an active state — the "empty block
            // until you click" bug. `.detail-feedback-controls` (globals.css)
            // forces them visible from the start.
            className="detail-feedback-controls"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "6px 8px",
              borderRadius: 8,
              background: "var(--bg-1)",
              border: "1px solid var(--border)",
              alignSelf: "flex-start",
            }}
          >
            <span style={{ fontSize: 13, color: "var(--fg-muted)" }}>Tu valoración:</span>
            <FeedbackControls profileId={profileId} propertyId={propertyId} />
          </div>
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
