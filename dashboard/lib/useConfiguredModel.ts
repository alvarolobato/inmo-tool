"use client";

import { useState, useEffect } from "react";

let _cachedModel: string | null = null;
// Shared in-flight promise so concurrent mounts don't fire duplicate requests.
let _modelPromise: Promise<void> | null = null;

/** Strips the provider prefix from a model id, e.g. "anthropic/claude-3" → "claude-3". */
export function displayModelName(raw: string): string {
  return raw.split("/").pop() ?? raw;
}

/** Resets module-level cache for test isolation. Do not call in production code. */
export function _resetCacheForTesting() {
  _cachedModel = null;
  _modelPromise = null;
}

/**
 * Fetches the configured LLM model name from the server once and caches it.
 * Returns null while loading or on error.
 */
export function useConfiguredModel(): string | null {
  const [model, setModel] = useState<string | null>(_cachedModel);
  useEffect(() => {
    let mounted = true;
    if (_cachedModel) {
      // Another component already populated the cache before this effect ran.
      setModel(_cachedModel);
      return;
    }
    if (!_modelPromise) {
      _modelPromise = (async () => {
        try {
          const r = await fetch("/api/config/model");
          if (!r.ok) throw new Error("non-ok");
          const data = (await r.json()) as { model?: string };
          if (data?.model) {
            _cachedModel = data.model;
          } else {
            _modelPromise = null; // allow retry if response missing model field
          }
        } catch {
          _modelPromise = null; // allow retry on next mount after network/server error
        }
      })();
    }
    void _modelPromise.then(() => {
      if (mounted && _cachedModel) setModel(_cachedModel);
    });
    return () => {
      mounted = false;
    };
  }, []);
  return model;
}
