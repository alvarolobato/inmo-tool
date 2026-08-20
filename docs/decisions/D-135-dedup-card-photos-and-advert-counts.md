---
id: D-135
title: Dedup photo-match card shows the photos that matched, and advert counts, not pair counts
date: 2026-08-20
group: Data / connectors
rule: 'A dedup photo card renders EVERY stored photo per side, matched_pairs-ordered matched-first (never re-derived in the UI, never capped — D-139); copy shows advert counts, never pair_count.'
---

# D-135: Dedup photo-match card shows the photos that matched, and advert counts, not pair counts

*Decided: 2026-08-20 — revised same day, mid-implementation, on a direct
owner instruction relayed by the coordinating agent (see "Revision"
below). **Point 2's "capped at 4, expandable" mechanic was itself
superseded the same week by [D-139](D-139-dedup-card-uncapped-photos-internal-link.md)
(issue #626)** — the owner's #615 wording ("me muestras 4 fotos como
máximo... necesito ver el resto") was read here as "4 by default is fine
as long as they're the right 4"; his #626 follow-up ("solo me muestras 4
fotos como máximo" — the SAME complaint, again) clarified he meant "stop
capping it, full stop." The matched-FIRST ordering this point establishes
is unchanged and still binding — D-139 removes the cap, not the ordering.
The frontmatter `rule:` above reflects the current (post-D-139) behavior;
point 2's prose below is left as originally written, for the historical
record of what actually shipped and why, per this project's "retire,
don't rewrite" convention applied at paragraph grain.*

**Context**: Issue #615, filed mid-review by the owner on his phone, one
card after #611 (D-133) shipped:

> *"el primero pendiente por foto me está enseñando dos que no son el
> mismo. pero me dice que hay otros 37 pares, ¿qué es esto? ¿anuncios en
> idealista de la misma propiedad? ¿37? eso es prácticamente imposible.
> por otro lado me muestra una descripción cuando digo ver, no puedo
> realmente verlo ni saber si son el mismo o no."*

Two compounding problems on the exact card he was on, property pair
`(1729, 1732)`:

1. **The evidence was unviewable.** The suggestion is made on photo
   hashes; the card showed a one-line text summary
   (`dedupDetailSummary`, e.g. "Coincidencia de fotos: 100%") and
   `ListingSidePanel` truncated each side's photos to the first 4 — so a
   1729-vs-1732 comparison (7 listings on one side, 13 on the other, some
   with dozens of photos each) never showed the owner enough of the
   actual pictures to judge "is this the same flat?" himself.
2. **"37/38 pares" read as "38 adverts of the same property."** D-133's
   badge showed the raw `pair_count` — the number of `suggested_merge`
   listing-pair ROWS the engine had queued for this property pair — with
   the label "N pares corroborantes". Measured on the live case: property
   1729 has 7 sale listings (4 fotocasa, 3 idealista); property 1732 has
   13 (11 fotocasa, 2 idealista). 7×13 = 91 possible listing combinations,
   38 of which were pending `suggested_merge` rows. The owner read that
   as "38 adverts of one property, on one portal", correctly concluded
   that was impossible, and had no way from the card alone to learn the
   true, sane number.

**Revision — during implementation, a direct owner instruction**:

> *"cuando esté comparando duplicados me muestras 4 fotos como máximo.
> necesito ver el resto, o por lo menos que me muestres las que
> coinciden, no las primeras que te salen."*

The first cut of this decision (show ALL photos per side, uncapped,
scrolling inside a height-capped grid) solved "I can't see any photos" but
not the sharper problem: showing every photo in **storage order** still
buries the two or three photos that actually produced the match among a
dozen unrelated ones, and the owner explicitly said a 4-photo default is
fine **as long as those 4 are the ones that matched**, with the rest
reachable and their count visible. This revision supersedes the
"show every photo, uncapped" design with a "matched-first, capped at 4,
expandable" one — see Decision point 2 below for the mechanics, and
`docs/decisions/D-135-dedup-card-photos-and-advert-counts.md`'s own git
history for the superseded first cut (kept in history, not restated
here).

**Decision**: Six linked changes, spanning `etl/dedup/signals/photo_hash.py`,
`etl/dedup/engine.py`, `dashboard/lib/dedup-shared.ts`, and
`PropertyPairCard.tsx`/`ListingSidePanel.tsx` (issue #615):

1. **The perceptual-hash matching itself computes AND persists which
   specific photos matched — one place, never re-derived.**
   `photo_hash.py` splits its existing fetch loop into
   `fetch_hash_pairs_with_stats` (returns `(url, hash)` PAIRS; the
   pre-existing `fetch_hashes_with_stats`/`fetch_hashes` become thin
   wrappers over it, byte-for-byte the same observable behaviour —
   log lines, stats, hash values — as before, so every existing test
   stays green untouched). A new pure function, `matched_pairs(pairs_a,
   pairs_b) -> list[MatchedPhotoPair]`, mirrors `match_ratio`'s own
   matching rule exactly (iterate the SMALLER side, each hash's BEST
   candidate — closest Hamming distance, not just the first one within
   threshold — in the LARGER side) but reports each pairing's actual
   URLs and distance instead of collapsing to one fraction, sorted
   strongest-first. `_PhotoHashCache` (`etl/dedup/engine.py`) now caches
   `(url, hash)` pairs instead of bare hashes (`get()`'s own return
   shape — `list[ImageHash]` — is unchanged, derived from the same
   cache; `get_pairs()` is the new accessor) so this costs **zero
   additional fetches** — every URL was already being fetched for the
   ratio calculation. `evaluate_pair` adds `detail["matched_photos"]`
   (a list of `{url_a, url_b, distance}`) whenever any pair matches,
   using the exact same cached pairs `hashes_a`/`hashes_b` above already
   computed. `matched_pairs` itself introduces one new pitfall this PR's
   own review caught before it shipped: imagehash's `-` operator returns
   `numpy.int64`, not a plain Python `int`, and `detail["matched_photos"]`
   is the first place this module ever persists a raw distance value
   (`match_ratio`, the only prior consumer, only ever divides it into a
   plain float) — an un-cast `numpy.int64` there crashes `json.dumps` at
   `file_suggestion`'s write. Caught by `TestDedupRunResultPhotoHealth`'s
   real-Postgres test before merge, fixed with an explicit `int()` cast —
   a self-introduced papercut in new code, not a pre-existing production
   bug (no signal wrote a hash distance into `detail` before this PR).

2. **[SUPERSEDED by D-139/issue #626 — the cap itself is gone; the
   matched-first ORDERING this point establishes is still binding.]**
   The dashboard shows matched-first, capped at 4, with the rest
   reachable — never all-at-once, never index-order. Direct owner
   instruction, in priority order: (a) show the photos that ACTUALLY
   matched, never the first N in storage order; (b) the rest must stay
   reachable, with the hidden count visible. `dashboard/lib/dedup-shared.ts`
   gains `resolveMatchedPhotos(detail, listingLo, listingHi)` — pins each
   persisted `{url_a, url_b}` pair to this group's canonical lo/hi
   property order via a plain URL-membership test against each side's OWN
   `photo_urls` (never a re-match; a pair whose URLs recognize neither
   side, e.g. a listing's `photo_urls` changed since the suggestion was
   filed, is silently dropped rather than mis-assigned) — and
   `orderPhotosMatchedFirst(allUrls, matchedUrlsInOrder)`, which puts the
   matched URLs first (in match-strength order) and every remaining
   unmatched photo after, never interleaved by index.
   `ListingSidePanel` renders `DEFAULT_VISIBLE_PHOTOS` (4) of that ordered
   list by default — a matched photo sitting at index 5 or 9 of a
   6-or-14-photo listing is still shown, because the ordering already put
   it first, not because the cap is high enough to reach it — plus a
   `data-testid="dedup-photos-expand"` "+N más" button (real 44px tap
   target, same class as confirm/reject) when photos remain hidden,
   revealing the rest via the existing height-capped, internally-scrolling
   `.dedup-photo-grid` (kept from the first cut, still the right answer
   for "20 photos in the expanded view shouldn't stretch the card to
   full-page height" — see the class's own comment in `globals.css`).
   Each matched thumbnail carries a `data-testid="dedup-photo-matched"`
   plus a visible ring/badge; unmatched ones carry
   `data-testid="dedup-photo-unmatched"` — the owner needs to see AT A
   GLANCE which photo is the evidence, not infer it from position alone.

3. **Never implies pixel-equality.** Portals stamp their own watermark on
   a photo, so two genuinely matched photos routinely differ visually —
   the ring/badge marks "this is the evidence the suggestion is based
   on", not "these two images are identical". No diff/overlay view; the
   owner judges by eye, same as any other comparison on this card.

4. **Advert counts replace the pair-count badge everywhere in the UI.**
   `listDedupPropertyPairSuggestions`'s query (`dashboard/lib/dedup.ts`)
   gains two correlated-subquery columns, `lo_listing_count`/
   `hi_listing_count` — `COUNT(*) FROM listing WHERE property_id = <lo|hi>
   AND operation = 'sale'` (D-016: sale-candidate queries filter
   `operation='sale'` explicitly) — surfaced as `listing_count_lo`/
   `listing_count_hi`. The old `data-testid="dedup-pair-count-badge"`
   ("N pares corroborantes") is gone; a new
   `data-testid="dedup-advert-counts"` line reads "7 anuncios ↔ 13
   anuncios" — genuinely different numbers from `pair_count`, which stays
   on the type (needed for the reject blast-radius warning's own
   bookkeeping) and on the card only as the pre-existing `data-pair-count`
   DOM attribute — never rendered as its own visible "N pares" text
   anywhere: not the header, not the reject warning (which now names the
   advert counts instead — "se rechazará que estos anuncios (7 ↔ 13) sean
   la misma vivienda"), not the reject button (drops its old "(N pares)"
   suffix entirely), not even the collapsed corroborating-evidence toggle
   (relabeled "ver M señales más" — "señales", never "pares" or
   "anuncios" — the one place the internal count still appears at all,
   deliberately behind the pre-existing collapsed-by-default expander,
   #615's "bury it behind a debug affordance" option).

5. **One line states the card is a single decision.**
   `data-testid="dedup-single-decision-note"`, next to the advert counts:
   "Una decisión: ¿son la misma vivienda?" — answers the owner's third
   question about why 7-vs-13 listings collapse into one card instead of
   being asked about repeatedly (D-133/#605 had already fixed the
   grouping; the card just never said so).

6. **Every new test can fail, and the fixture is asymmetric AND
   index-independent.** `etl/tests/test_dedup_signals_photo_hash.py::
   TestMatchedPairs` builds a case where side A's photo at a non-zero
   index matches side B's photo at a DIFFERENT non-zero index — a
   same-index (or 1×1) fixture would pass even with no real
   `matched_pairs` logic at all. `etl/tests/test_dedup_engine.py::
   TestPhotoHashMatchedPairsThreading` proves the same end-to-end through
   `evaluate_pair`. `dashboard/e2e/mobile-dedup.spec.ts`'s dedicated #615
   test uses the coordinator's own example shape (photo 5 of a 6-photo
   side matches photo 9 of a 14-photo side) plus the issue's own 7-vs-13
   asymmetric advert-count fixture in ONE test, asserting the default
   4-photo cap, the matched badge on the correct URL on both sides, the
   "+N más" count, the expand interaction, and the resulting internal
   scroll.

**Alternatives rejected**:
- *Show all photos, uncapped, relying on the scroll container alone*
  (this decision's own first cut): rejected on direct owner instruction —
  a cap of 4 is fine and even preferred as the default view, PROVIDED the
  4 shown are the true matches. Showing everything in storage order still
  buries the evidence among unrelated photos.
- *Highlight matched photos without reordering them*: rejected — a match
  at index 9 of 14 is still off-screen below the fold at a 4-photo-tall
  default view unless it's moved to the front; a highlight nobody scrolls
  to reach doesn't solve "no puedo verlo".
- *Re-derive "which photos look similar" in the dashboard (e.g. comparing
  image URLs or dimensions)*: rejected outright — the owner and the
  coordinator both flagged this class of duplication (a second,
  driftable implementation of matching logic) as a repeat mistake this
  week. The ONE place a photo hash and its URL are produced together is
  `photo_hash.py`'s fetch loop; everything downstream consumes that,
  never recomputes it.
- *Keep the pair count visible but relabel it "combinaciones" or
  similar*: rejected — any number derived from 7×13 combinatorics reads
  as meaningless to a human regardless of the noun; advert counts are the
  number that actually answers "how many adverts am I looking at."
- *Extend `photo_hash.py` to persist per-photo match indices as a
  separate follow-up PR, ship advert counts now*: rejected once the
  owner's photo instruction landed — bundling both fixes in the same PR
  is the honest scope; splitting them would ship a card that still can't
  answer "which photos" for another review cycle.

**Rationale**: The owner's blocker was structural, not cosmetic — he
could not evaluate a photo-hash suggestion without seeing the photos that
actually produced it, and could not trust a headline number that
misdescribed the situation as "38 adverts of the same property"
(impossible on its face). Threading the real match through — instead of
either hiding it (the pre-#615 4-photo truncation) or diluting it (the
first cut's "show everything, unordered") — is what makes the evidence
actually usable for the "is this the same flat?" judgment call the whole
card exists to support.

**Supersedes**: [D-133](D-133-dedup-queue-grouped-by-property-pair.md)'s
point 1 UI-copy paragraph — the "the toggle shows BOTH the 'others' count
... and the same noun, 'pares'" text there describes the PRE-#615 design;
D-133's grouping/confirm/reject/veto semantics (points 2–5) are entirely
unchanged and still binding.

**See**: issue #615, issue #605 (parent), D-133 (grouping/reject
semantics this only revises the UI copy of), D-016 (rental listings must
never enter a sale-candidate count),
`etl/dedup/signals/photo_hash.py` (`fetch_hash_pairs_with_stats`,
`matched_pairs`, `MatchedPhotoPair`),
`etl/dedup/engine.py` (`_PhotoHashCache.get_pairs`, `evaluate_pair`'s
`detail["matched_photos"]`),
`etl/tests/test_dedup_signals_photo_hash.py::TestMatchedPairs`,
`etl/tests/test_dedup_engine.py::TestPhotoHashMatchedPairsThreading`,
`dashboard/lib/dedup-shared.ts` (`resolveMatchedPhotos`,
`orderPhotosMatchedFirst`, `lo_listing_count`/`hi_listing_count`),
`dashboard/lib/dedup.ts`,
`dashboard/components/dedup/PropertyPairCard.tsx`,
`dashboard/components/dedup/ListingSidePanel.tsx`, `dashboard/app/globals.css`
(`.dedup-photo-grid`), `dashboard/e2e/mobile-dedup.spec.ts` (issue #615's
dedicated non-index-0, 7-vs-13 asymmetric fixture test),
`dashboard/e2e/dedup-review.spec.ts`,
`dashboard/lib/__tests__/dedup.integration.test.ts`.
