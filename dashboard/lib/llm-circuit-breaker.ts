export type CircuitState = "closed" | "open" | "half-open";

export class CircuitBreakerOpenError extends Error {
  constructor() {
    super(
      "Servicio de IA temporalmente no disponible. Inténtelo en unos minutos."
    );
    this.name = "CircuitBreakerOpenError";
  }
}

const FAILURE_THRESHOLD = 5;
const HALF_OPEN_TIMEOUT_MS = 60_000;

let state: CircuitState = "closed";
let consecutiveFailures = 0;
let openedAt: number | null = null;

export function getCircuitState(): CircuitState {
  if (state === "open" && openedAt !== null) {
    if (Date.now() - openedAt >= HALF_OPEN_TIMEOUT_MS) {
      state = "half-open";
    }
  }
  return state;
}

function isCircuitFailure(err: unknown): boolean {
  if (err instanceof CircuitBreakerOpenError) return false;
  if (err !== null && typeof err === "object" && "status" in err) {
    const status = (err as { status: number }).status;
    if (status === 400 || status === 429) return false;
    if (status >= 500) return true;
    return false;
  }
  // Only count as a circuit failure if it looks like a network/fetch error.
  // Application errors (TypeError from a bug, RangeError, etc.) should not
  // trip the breaker — they indicate a code defect, not a service outage.
  if (
    err instanceof TypeError ||
    (err instanceof Error &&
      /fetch|network|ECONNREFUSED|ETIMEDOUT/i.test(err.message))
  ) {
    return true;
  }
  return false;
}

function onSuccess(): void {
  state = "closed";
  consecutiveFailures = 0;
  openedAt = null;
}

function onFailure(): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= FAILURE_THRESHOLD || state === "half-open") {
    state = "open";
    openedAt = Date.now();
    consecutiveFailures = 0;
  }
}

export async function callWithCircuitBreaker<T>(
  fn: () => Promise<T>
): Promise<T> {
  const current = getCircuitState();

  if (current === "open") {
    throw new CircuitBreakerOpenError();
  }

  try {
    const result = await fn();
    onSuccess();
    return result;
  } catch (err) {
    if (isCircuitFailure(err)) {
      onFailure();
    }
    throw err;
  }
}

/** Reset all state — for testing only. */
export function _resetCircuitBreaker(): void {
  state = "closed";
  consecutiveFailures = 0;
  openedAt = null;
}
