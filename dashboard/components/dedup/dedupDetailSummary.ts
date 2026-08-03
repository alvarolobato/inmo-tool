import { fmtPct } from "@/components/widgets/format";
import type { MatchBasis } from "@/lib/dedup-shared";

/**
 * One human-readable line summarizing why a pair was flagged, per
 * match_basis's own `detail` JSON shape (see each etl/dedup/signals/*.py
 * module for what it writes). Falls back to a raw key:value dump for any
 * shape this doesn't recognize, so a future signal's detail never renders
 * as nothing.
 */
export function dedupDetailSummary(basis: MatchBasis, detail: Record<string, unknown>): string {
  switch (basis) {
    case "photo_hash": {
      const ratio = detail.match_ratio;
      if (typeof ratio === "number") return `Coincidencia de fotos: ${fmtPct(ratio)}`;
      break;
    }
    case "fuzzy": {
      const sim = detail.address_similarity;
      if (typeof sim === "number") return `Similitud de dirección: ${fmtPct(sim)}`;
      break;
    }
    case "phone": {
      const digits = detail.shared_phone_digits;
      if (Array.isArray(digits) && digits.length > 0) {
        return `Teléfono compartido: ${digits.join(", ")}`;
      }
      break;
    }
    case "reference_code": {
      const code = detail.shared_reference_code;
      if (typeof code === "string") return `Referencia compartida: ${code}`;
      break;
    }
    case "address_coords":
      return "Dirección y coordenadas próximas";
    case "cadastral":
      return "Misma referencia catastral";
  }
  const entries = Object.entries(detail);
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}: ${String(v)}`).join(", ");
}
