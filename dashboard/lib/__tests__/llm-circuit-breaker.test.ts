import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CircuitBreakerOpenError,
  callWithCircuitBreaker,
  getCircuitState,
  _resetCircuitBreaker,
} from "../llm-circuit-breaker";

function makeHttpError(status: number): Error & { status: number } {
  const err = new Error(`HTTP ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

function makeNetworkError(): Error {
  return new Error("Network error");
}

async function triggerFailures(n: number, err: unknown = makeHttpError(503)) {
  for (let i = 0; i < n; i++) {
    await expect(
      callWithCircuitBreaker(() => Promise.reject(err))
    ).rejects.toThrow();
  }
}

describe("llm-circuit-breaker", () => {
  beforeEach(() => {
    _resetCircuitBreaker();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("initial state", () => {
    it("starts closed", () => {
      expect(getCircuitState()).toBe("closed");
    });
  });

  describe("closed → open (5 consecutive failures)", () => {
    it("stays closed after fewer than 5 failures", async () => {
      await triggerFailures(4);
      expect(getCircuitState()).toBe("closed");
    });

    it("opens after exactly 5 consecutive circuit failures", async () => {
      await triggerFailures(5);
      expect(getCircuitState()).toBe("open");
    });

    it("rejects immediately without calling fn when open", async () => {
      await triggerFailures(5);
      const fn = vi.fn().mockResolvedValue("should-not-be-called");
      await expect(callWithCircuitBreaker(fn)).rejects.toBeInstanceOf(
        CircuitBreakerOpenError
      );
      expect(fn).not.toHaveBeenCalled();
    });

    it("resets failure count to 0 on any success", async () => {
      await triggerFailures(4);
      await callWithCircuitBreaker(() => Promise.resolve("ok"));
      // 4 failures + 1 success → should be reset; 4 more failures should not open
      await triggerFailures(4);
      expect(getCircuitState()).toBe("closed");
    });
  });

  describe("open → half-open after 60 seconds", () => {
    it("transitions to half-open after 60s have elapsed", async () => {
      const now = Date.now();
      const dateSpy = vi.spyOn(Date, "now");
      dateSpy.mockReturnValue(now);

      await triggerFailures(5);
      expect(getCircuitState()).toBe("open");

      // Advance time by 60 seconds
      dateSpy.mockReturnValue(now + 60_000);
      expect(getCircuitState()).toBe("half-open");
    });

    it("stays open before 60s have elapsed", async () => {
      const now = Date.now();
      const dateSpy = vi.spyOn(Date, "now");
      dateSpy.mockReturnValue(now);

      await triggerFailures(5);

      dateSpy.mockReturnValue(now + 59_999);
      expect(getCircuitState()).toBe("open");
    });
  });

  describe("half-open → closed on success", () => {
    it("closes the circuit on one success in half-open state", async () => {
      const now = Date.now();
      const dateSpy = vi.spyOn(Date, "now");
      dateSpy.mockReturnValue(now);

      await triggerFailures(5);
      dateSpy.mockReturnValue(now + 60_000);
      expect(getCircuitState()).toBe("half-open");

      await callWithCircuitBreaker(() => Promise.resolve("ok"));
      expect(getCircuitState()).toBe("closed");
    });
  });

  describe("half-open → open on failure", () => {
    it("re-opens the circuit on one failure in half-open state", async () => {
      const now = Date.now();
      const dateSpy = vi.spyOn(Date, "now");
      dateSpy.mockReturnValue(now);

      await triggerFailures(5);
      dateSpy.mockReturnValue(now + 60_000);
      expect(getCircuitState()).toBe("half-open");

      await expect(
        callWithCircuitBreaker(() => Promise.reject(makeHttpError(503)))
      ).rejects.toThrow();

      // After re-opening, must stay open (not half-open yet)
      dateSpy.mockReturnValue(now + 60_000); // same time, no additional delay
      expect(getCircuitState()).toBe("open");
    });
  });

  describe("failure classification", () => {
    it("does NOT count HTTP 400 as a circuit failure", async () => {
      await triggerFailures(4, makeHttpError(400));
      // After 4 × 400 errors, circuit must still be closed
      expect(getCircuitState()).toBe("closed");
    });

    it("does NOT count HTTP 429 as a circuit failure", async () => {
      await triggerFailures(5, makeHttpError(429));
      expect(getCircuitState()).toBe("closed");
    });

    it("counts HTTP 503 as a circuit failure", async () => {
      await triggerFailures(5, makeHttpError(503));
      expect(getCircuitState()).toBe("open");
    });

    it("counts HTTP 500 as a circuit failure", async () => {
      await triggerFailures(5, makeHttpError(500));
      expect(getCircuitState()).toBe("open");
    });

    it("counts network errors (no .status) as circuit failures", async () => {
      await triggerFailures(5, makeNetworkError());
      expect(getCircuitState()).toBe("open");
    });

    it("counts TypeError (fetch failure) as a circuit failure", async () => {
      await triggerFailures(5, new TypeError("Failed to fetch"));
      expect(getCircuitState()).toBe("open");
    });

    it("does NOT count application errors (no .status, no network keywords) as circuit failures", async () => {
      await triggerFailures(5, new RangeError("index out of bounds"));
      expect(getCircuitState()).toBe("closed");
    });

    it("does NOT count HTTP 400 even when mixed with 5xx", async () => {
      // 3 × 503 then a 400 — the 400 should still propagate but not count
      await triggerFailures(3, makeHttpError(503));
      await expect(
        callWithCircuitBreaker(() => Promise.reject(makeHttpError(400)))
      ).rejects.toThrow();
      // 2 more 503s — total circuit failures = 3 + 2 = 5 → open
      await triggerFailures(2, makeHttpError(503));
      expect(getCircuitState()).toBe("open");
    });
  });

  describe("CircuitBreakerOpenError", () => {
    it("has the correct Spanish message", () => {
      const err = new CircuitBreakerOpenError();
      expect(err.message).toBe(
        "Servicio de IA temporalmente no disponible. Inténtelo en unos minutos."
      );
    });

    it("is an instance of Error", () => {
      expect(new CircuitBreakerOpenError()).toBeInstanceOf(Error);
    });
  });

  describe("pass-through on success", () => {
    it("returns the value from fn when circuit is closed", async () => {
      const result = await callWithCircuitBreaker(() =>
        Promise.resolve("hello")
      );
      expect(result).toBe("hello");
    });
  });
});
