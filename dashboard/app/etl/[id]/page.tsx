"use client";

import { useParams } from "next/navigation";
import { RunDetail } from "@/components/etl/RunDetail";

export default function EtlRunDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <RunDetail runId={id} />;
}
