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
 *
 * Rate limiting (Opus review, PR #103): Nominatim's usage policy caps
 * requests at 1/second. A client-side debounce alone doesn't actually
 * guarantee this — multiple browser tabs, request retries, or anyone
 * hitting the route directly all bypass it. So outbound requests are
 * serialized here behind a module-level queue enforcing a minimum spacing,
 * and a short-TTL cache avoids re-querying Nominatim at all for a repeated
 * identical search (e.g. re-focusing the same input).
 */

const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";

// Identifies the app + a way to reach the operator, per Nominatim's usage
// policy. Configurable via env var since a real deployment may want a real
// contact email; the default at least points at the project itself so an
// abuse report has somewhere to go, which a purely descriptive string with
// no reachable contact did not provide.
const USER_AGENT =
  process.env.NOMINATIM_USER_AGENT ??
  "inmo-tool/1.0 (self-hosted personal real-estate sourcing tool; " +
    "https://github.com/alvarolobato/inmo-tool)";

const REQUEST_TIMEOUT_MS = 8_000;

// Nominatim's policy caps at 1 req/s; add a small margin.
const MIN_REQUEST_SPACING_MS = 1_100;

// Repeated identical searches (e.g. blur/refocus, a second component
// mounting) shouldn't re-hit Nominatim within this window.
const CACHE_TTL_MS = 60_000;

export interface GeocodeResult {
  label: string;
  lat: number;
  lon: number;
}

export class GeocodeError extends Error {}

// --- Outbound request serialization -----------------------------------
// A module-level promise chain: each call to `withThrottle` waits for the
// previous one to finish, then waits out any remaining spacing before
// actually running. This is process-local (fine for a single-deployment
// personal tool with one Node process) and enforces real spacing between
// *actual* outbound Nominatim calls, independent of how many concurrent
// callers (tabs, retries) are asking.
let requestChain: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

function withThrottle<T>(fn: () => Promise<T>): Promise<T> {
  const run = requestChain.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, lastRequestAt + MIN_REQUEST_SPACING_MS - now);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
  });
  // Don't let one throttle-wait failure break the chain for later calls.
  requestChain = run.catch(() => undefined);
  return run.then(fn);
}

// --- Query cache --------------------------------------------------------
const cache = new Map<string, { at: number; results: GeocodeResult[] }>();

function cacheKey(query: string): string {
  return query.trim().toLowerCase();
}

function getCached(query: string): GeocodeResult[] | undefined {
  const entry = cache.get(cacheKey(query));
  if (!entry) return undefined;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(cacheKey(query));
    return undefined;
  }
  return entry.results;
}

function setCached(query: string, results: GeocodeResult[]): void {
  cache.set(cacheKey(query), { at: Date.now(), results });
}

/**
 * Search Nominatim for places matching `query`. Returns up to 5 results,
 * restricted to Spain (this project's current market scope, per issue #1 —
 * this docstring previously claimed unrestricted search while the code
 * hardcoded `countrycodes=es`; the code was correct, the docstring wasn't).
 */
export async function searchPlaces(query: string): Promise<GeocodeResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];

  const cached = getCached(trimmed);
  if (cached) return cached;

  const results = await withThrottle(() => fetchFromNominatim(trimmed));
  setCached(trimmed, results);
  return results;
}

async function fetchFromNominatim(trimmed: string): Promise<GeocodeResult[]> {
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

// --- Per-IP request bucket (route-level abuse guard) --------------------
// Deliberately simple in-memory counter — this is a single-deployment
// personal tool, not a multi-tenant service; a distributed rate limiter
// would be over-engineering. Protects our own route from being hit directly
// in a loop, independent of the outbound-request throttle above (which
// protects Nominatim; this protects us from being used as a free relay).
const REQUESTS_PER_WINDOW = 20;
const WINDOW_MS = 10_000;
const ipBuckets = new Map<string, { count: number; windowStart: number }>();

export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = ipBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    ipBuckets.set(ip, { count: 1, windowStart: now });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= REQUESTS_PER_WINDOW;
}

/**
 * Test-only: reset module-level throttle/cache/rate-limit state between
 * test cases. Without this, the query cache and the inter-request spacing
 * timer both persist across tests in the same file (module state, not
 * reset by vitest between `it()` blocks), which would either make
 * unrelated tests spuriously see cached results from an earlier test's
 * identical query string, or force every test after the first to wait out
 * the real throttle spacing for no reason.
 */
export function __resetGeocodeStateForTests(): void {
  cache.clear();
  ipBuckets.clear();
  lastRequestAt = 0;
  requestChain = Promise.resolve();
}
