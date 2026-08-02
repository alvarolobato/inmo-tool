/**
 * Server-side client for Nominatim (OpenStreetMap's free geocoding service),
 * used by the search profile location picker (issue #95) to convert a typed
 * address/place name into coordinates.
 *
 * Proxied through our own API route (app/api/geocode/route.ts) rather than
 * called directly from the browser: Nominatim's usage policy
 * (https://operations.osmfoundation.org/policies/nominatim/) asks for a
 * genuine identifying User-Agent, which browser JS cannot set (the browser
 * always overrides it) — a server-side fetch can set one for real. This also
 * keeps the single external HTTP call in one place, consistent with this
 * project's existing "connectors are the only thing that talks to the
 * outside world" discipline.
 */

const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";

// Identifies the app + a way to reach the operator, per Nominatim's usage
// policy — no contact email is configured for this personal/self-hosted
// tool, so this is deliberately just descriptive rather than a real contact
// method. Request volume here is bounded by a human typing in a form on a
// single-user tool, well under Nominatim's documented rate limits.
const USER_AGENT = "inmo-tool/1.0 (self-hosted personal real-estate sourcing tool)";

const REQUEST_TIMEOUT_MS = 8_000;

export interface GeocodeResult {
  label: string;
  lat: number;
  lon: number;
}

export class GeocodeError extends Error {}

/**
 * Search Nominatim for places matching `query`. Returns up to 5 results,
 * biased toward Spain (this project's current market, per issue #1) but not
 * restricted to it — a profile scoped elsewhere should still resolve.
 */
export async function searchPlaces(query: string): Promise<GeocodeResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];

  const url = new URL(NOMINATIM_SEARCH_URL);
  url.searchParams.set("q", trimmed);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");
  url.searchParams.set("countrycodes", "es");
  url.searchParams.set("accept-language", "es");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
  } catch (err) {
    throw new GeocodeError(
      err instanceof Error && err.name === "AbortError"
        ? "La búsqueda de ubicación ha tardado demasiado."
        : "No se pudo contactar con el servicio de geocodificación.",
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new GeocodeError(
      `El servicio de geocodificación respondió con un error (${response.status}).`,
    );
  }

  const body: unknown = await response.json();
  if (!Array.isArray(body)) {
    throw new GeocodeError("Respuesta inesperada del servicio de geocodificación.");
  }

  const results: GeocodeResult[] = [];
  for (const item of body) {
    if (
      typeof item === "object" &&
      item !== null &&
      "lat" in item &&
      "lon" in item &&
      "display_name" in item
    ) {
      const lat = Number((item as { lat: unknown }).lat);
      const lon = Number((item as { lon: unknown }).lon);
      const label = (item as { display_name: unknown }).display_name;
      if (Number.isFinite(lat) && Number.isFinite(lon) && typeof label === "string") {
        results.push({ label, lat, lon });
      }
    }
  }
  return results;
}
