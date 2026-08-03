/**
 * Pure index-wrapping arithmetic for cycling through a fixed-length photo
 * array (#167's in-place candidate-card ticker). Deliberately dependency-free
 * (no React, no server imports) so it's importable from a client component
 * (`CandidatePhoto.tsx`) and unit-testable without mounting anything.
 *
 * Mirrors the wrap formula `PhotoGallery.tsx`'s lightbox `step()` already
 * uses (`(current + delta + length) % length`) rather than inventing a
 * second, subtly different cycling rule for the same product concept — see
 * that component's docstring. Extracted to a shared pure function instead of
 * literally importing from `PhotoGallery.tsx` because that component is a
 * "use client" component with its own DOM/focus-management concerns (thumbnail
 * refs, lightbox open state) that the card ticker doesn't need or want to
 * pull in; the arithmetic is the only part worth sharing.
 */

/**
 * Wraps `current + delta` into `[0, length)`. Returns 0 for any
 * non-positive `length` (an empty or single-photo array never has a "next"
 * index a caller should act on, but this stays total rather than throwing —
 * callers gate ticker rendering on `length > 1` instead of relying on this
 * to signal that).
 */
export function wrapIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (current + delta + length) % length;
}
