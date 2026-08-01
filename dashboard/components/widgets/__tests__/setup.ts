/**
 * JSDOM setup for widget component tests.
 * Polyfills missing browser APIs that Tremor/recharts depend on.
 */
import "@testing-library/jest-dom/vitest";

// recharts ResponsiveContainer requires ResizeObserver
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
