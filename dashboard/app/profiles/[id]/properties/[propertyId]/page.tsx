"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import type { PropertyDetail } from "@/lib/property-detail";
import { PropertyHeader } from "@/components/property/PropertyHeader";
import { PhotoGallery } from "@/components/property/PhotoGallery";
import { LinkedListings } from "@/components/property/LinkedListings";
import { PriceHistoryChart } from "@/components/property/PriceHistoryChart";
import { DetailSections, type DetailSection } from "@/components/property/DetailSections";

function parseId(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export default function PropertyDetailPage() {
  const params = useParams<{ id: string; propertyId: string }>();
  const profileId = parseId(params.id);
  const propertyId = parseId(params.propertyId);

  const [property, setProperty] = useState<PropertyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);

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
        {
          id: "history",
          title: "Historial de precio y estado",
          order: 20,
          content: (
            <PriceHistoryChart priceHistory={property.price_history} statusEvents={property.status_events} />
          ),
        },
      ]
    : [];

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: 24 }} data-testid="property-detail-page">
      <Link href={`/profiles/${profileId}`} style={{ fontSize: 12, color: "var(--fg-muted)" }}>
        ← Volver al perfil
      </Link>

      {loading && (
        <p style={{ marginTop: 16, fontSize: 13, color: "var(--fg-muted)" }}>Cargando propiedad…</p>
      )}

      {error && <ErrorDisplay error={error} className="mt-4" />}

      {!loading && !error && property && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 20 }}>
          <PropertyHeader property={property} />
          <PhotoGallery photoUrls={property.photo_urls} />
          <DetailSections sections={sections} />
        </div>
      )}
    </main>
  );
}
