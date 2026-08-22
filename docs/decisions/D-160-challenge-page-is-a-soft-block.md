---
id: D-160
title: An anti-bot challenge page halts the run and consumes nothing — it is never a withdrawal
date: 2026-08-22
group: Data / connectors
rule: 'An anti-bot challenge is a THIRD outcome ranked above withdrawal and failure: halt the batch, write nothing, leave the worklist row pending. Two accent-folded phrases from the shared table; never per-visit data.'
---

# D-160: An anti-bot challenge page halts the run and consumes nothing — it is never a withdrawal

*Decided: 2026-08-22*

**Context**:

While draining the #683 Idealista re-capture queue (2.586 pages), the portal
began serving an anti-bot challenge — a slider wall headed *"parece que
estamos recibiendo muchas peticiones tuyas en poco tiempo"* — **at the listing
URL itself**. A batch capture of `/inmueble/<id>/` therefore captured the
challenge instead of the advert, and the run sailed straight through it.

Three separate problems converged:

1. **The detector saw the wall and talked itself out of it.** `detect.js`
   already carried a `captcha_wall` signature that matched the page. But
   `detectBlockSignals` requires corroboration — a marker only counts once
   `!isRenderReady(doc, portal)` — and the challenge page is *text-rich*:
   measured at ~490 characters of prose inside a `<main>`, it clears both of
   `isRenderReady`'s tests (a key node via the generic `main`/`h1` fallback
   selectors, and the 400-character `MIN_BODY_TEXT` floor). So
   `isRenderReady` returned **true**, the corroboration discarded a correct
   match, and `detectBlockSignals` reported `{blocked: false}`. The
   corroboration assumes "rendered real content" and "interstitial" are
   mutually exclusive; a wordy challenge page breaks that assumption outright.

2. **A challenge is field-less, and so is a withdrawal notice.** PR #691
   (issue #690, D-159) was landing "ya no está publicado" detection at the
   same time. Its two checks resolve to `withdrawn` and `failed`
   respectively, and a challenge page satisfies the *second* one's condition
   exactly. `failed` writes nothing to the listing, so it is safe — but it is
   the wrong answer, and it is not inert: `_mark_failed` calls
   `_correlate_worklist(..., "failed", ...)`, which flips the
   `capture_worklist` row out of `pending`. The extension filters
   `status === 'pending'` client-side, so the page silently leaves the drain
   pool. A page the portal refused to serve us gets consumed as though we had
   looked at it and found it broken.

3. **Nothing could be reconstructed afterwards.** HTML retention was off for
   Idealista (D-150 — blanket retention is ~290 MB against a 204 MB
   database), so the 33 field-less production rows are byte-identical in the
   database: `fields_extracted = 3`, zero photos, Idealista's site-wide
   homepage `<title>`. One of them is a confirmed withdrawal, read by hand.
   The rest cannot be classified from stored data at all.

This is the trap `etl/connectors/milanuncios.py` was already built around:
it deliberately ships **no** `retired_page_signature`, because its only
field-less page is a bot wall and any retirement signature there would have
withdrawn live inventory (D-047, D-157 — a soft block is never "gone").
Idealista now has both kinds of field-less page in circulation at once, so
the challenge has to be excluded **positively and first** rather than
hoped away.

**Decision**:

1. **A challenge is a third outcome, ranked above both of #691's.** The
   ordering is load-bearing and is evaluated before `normalize()` is called:

   | rank | condition | outcome | listing | worklist row |
   |---|---|---|---|---|
   | 1 | challenge signature matched | `blocked` | untouched | **stays `pending`** |
   | 2 | retirement notice matched | `withdrawn` | marked withdrawn | retired to `stale` |
   | 3 | zero substantive fields | `failed` | untouched | consumed → `failed` |

2. **Detection is two distinct phrases from one shared table.**
   `CHALLENGE_PHRASES` lives in exactly two places kept pinned identical by a
   test — `etl/soft_block.py` and `browser-extension/detect.js`. Each entry is
   an accent-folded fragment of the *portal's own voice about the visitor's
   request behaviour*, matched against visible text with
   `<script>`/`<style>`/`<noscript>` stripped. **Two distinct phrases must
   co-occur**; one alone is not enough.

3. **Never key on anything per-visit.** The page also renders the visitor's
   IP address and a per-visit `ID:` UUID. Neither may become a signature, and
   neither may reach a log, a fixture or an issue — both are personal data
   and this is a public repo. Pinned by tests on both sides.

4. **The challenge signature is `selfCorroborated` and skips the
   render-readiness veto.** Its own two-phrase threshold is strictly narrower
   than the veto would be, and the veto demonstrably misfires on exactly this
   page. No other signature's behaviour changes.

5. **On detection the batch halts and returns its in-flight slots to
   `pending`** (`InmoBatch.pauseForBlock`). Resume is an explicit action by
   the owner. Nothing solves, bypasses, retries, auto-clicks or disguises
   anything (issue #1 §15, D-026/D-027/D-033).

6. **Retain the pages the system could not ACCOUNT FOR — and only those.**
   Not "retain whatever parsed to nothing". A *classified* field-less page is
   not an anomaly: a recognised retirement notice (D-159) and a recognised
   challenge both drop their HTML, because we already know what they were and
   the evidence is recorded (`listing_status_event.evidence` and
   `extension_capture.error_msg` respectively). What is retained is a capture
   at or below its portal's **measured, per-portal** field-count floor
   (`{"idealista": 3}`, default 0) — i.e. a page nothing could explain.

   The retained set should read as *"pages we cannot explain"*. If it ever
   fills up with pages we do have a classifier for, that means the classifier
   should be handling them, not that storage should grow.

   This is self-correcting in the direction that matters: if a portal rewords
   its wall, the phrase table stops matching, the page stops being classified,
   and it lands in the retained bucket — so the sample needed to repair the
   table appears exactly when the table is broken, and never while it works.

**Alternatives rejected**:

- **Loosening or removing the `isRenderReady` corroboration globally.** It is
  doing real work for the other six signatures — a Turnstile widget on a
  contact form, an Incapsula tag on an ordinary 200. Fixing it by weakening
  it would reopen the false-positive class review B1 closed. Scoping the
  exemption to a signature that carries its own, narrower corroboration keeps
  both properties.

- **Raising `MIN_BODY_TEXT` above the challenge page's ~490 characters.** It
  would fix this page and break on the next one, which might be wordier — and
  it would simultaneously make `isRenderReady` worse at its actual job
  (knowing when a real advert has painted), risking captures fired against
  half-rendered pages.

- **A single phrase, or matching the page's `<h1>`.** One phrase is
  quotable by a seller's description ("se vende en poco tiempo"). Requiring
  two fragments of the operator's anti-bot voice in one document is not
  something a property advert produces.

- **Reusing `failed` for a challenge.** Safe for the listing, but it consumes
  the attempt and the worklist row, and it tells the owner "this capture is
  broken" when the truth is "this page was never served to us". A challenge
  is *come back later*.

- **Leaving the capture row `pending` instead of adding `blocked`.** The poll
  query would re-process it forever. `blocked` is terminal for the capture;
  the page returns via its still-pending *worklist* row.

- **Retaining every field-less page ("no fields → keep it").** The obvious
  implementation, and backwards: it hoards every withdrawal notice and every
  wall we already understand, while the framing that matters is *unexplained*,
  not *empty*. Pinned by tests on both sides — a classified challenge must NOT
  retain, an unclassified field-less page must.

- **A single global anomaly floor of 3.** Tried first; it correctly broke
  `test_calibrated_hipoges_capture_now_nulls_html`. The 3 was measured on
  idealista's markup and claiming it for another portal is unmeasured — it
  would either miss that portal's anomalies or hoard its thin-but-real
  adverts. The floor is per-portal, defaulting to 0.

- **Detecting the challenge by absence (zero fields, zero photos).** The
  correlation is perfect in the data and still rejected, for the same reason
  #691 rejected it: absence is equally what a half-rendered page, a login
  interstitial and a retirement notice look like. Absence never decides an
  outcome here.

- **Slowing the batch pacing.** Considered and explicitly dropped by the
  owner: a one-off 2.586-page drain tripping the wall is an acceptable
  consequence, not a defect to engineer around. No pacing constant changed.

**Rationale**:

The owner's requirement was *"necesito que se pare y espere a que yo pase a
mano el challenge — no confundir con anuncio no publicado."* Both halves are
data-integrity requirements, not conveniences. Not stopping means the run
grinds through a wall producing garbage captures; confusing the two means
writing `status = 'withdrawn'` onto live listings on the strength of a
rate-limit page.

The safe direction is asymmetric and that asymmetry drove every choice here.
Failing to detect a challenge costs one wasted capture attempt. Mistaking one
for a withdrawal corrupts the listing pool in a way nothing downstream can
detect — which is precisely why the challenge check is ranked *first* and
built on positive identification, and why the withdrawal path is the one
hedged about with corroboration.

**See**:
- `etl/soft_block.py`, `etl/capture.py` (`_mark_blocked`, and the retention
  decision in `_process_one`)
- `browser-extension/detect.js` (`CHALLENGE_PHRASES`, `rate_limit_challenge`,
  `selfCorroborated`), `browser-extension/batch.js` (`pauseForBlock`)
- `etl/tests/test_soft_block.py`,
  `dashboard/__tests__/extension-challenge-halt.test.ts`
- D-159 (the retirement notice this must never be confused with), D-047 /
  D-157 (a soft block is never "gone"), D-150 (HTML retention cost),
  D-142 / issue #634 (the block-episode machinery reused here), issue #683
  (the requeue metadata the worklist row must keep)
