"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import DashboardSurface from "@/components/surfaces/DashboardSurface";

function DashboardPageInner() {
  const params = useParams<{ id: string }>();
  return <DashboardSurface dashboardId={params.id} />;
}

export default function ViewDashboard() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-12">
          <div
            className="h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
            style={{ borderColor: "var(--border)", borderTopColor: "var(--accent)" }}
            role="status"
            aria-label="Cargando"
          />
        </div>
      }
    >
      <DashboardPageInner />
    </Suspense>
  );
}
