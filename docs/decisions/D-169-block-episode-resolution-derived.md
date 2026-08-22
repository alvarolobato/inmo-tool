---
id: D-169
title: A block episode is resolved by evidence the portal served us a page, derived at read time — never stored
date: 2026-08-22
group: Data / connectors
rule: 'A block episode reads as ACTIVE only until a done/withdrawn/listing capture from that portal lands after it — derived at read time from the capture ledger, never a stored column.'
---

# D-169: A block episode is resolved by evidence the portal served us a page, derived at read time — never stored

*Decided: 2026-08-22*

**Context**: The owner screenshotted his Estado board (a phone surface) showing
two claims one line apart, read from the same database:

> **idealista — nota: captura de idealista pausada por bloqueo (muro CAPTCHA) · hace 2 h**
> idealista · +16 en 24h · hace 1m

*"idealista me sale como bloqueado pero hace un rato que está capturando bien.
debe detectarse bien."* The source row was right.

`extension_block_episode` (`etl/schema/init.sql`) is append-only — `id`,
`portal`, `signature`, `detected_at`, `reported_at`. There is no resolution
column and no writer that closes an episode, and there was never going to be
one: the wall clears **in the owner's browser** (solve the challenge, press
"Reanudar" in the extension popup), which is exactly how the feature is
designed, and nothing reports that back. `activeBlocksByPortal`
(`dashboard/lib/data-health.ts`) nevertheless derived an ACTIVE state from
recency alone (`ACTIVE_BLOCK_WINDOW_HOURS = 24`, D-168), so a detection stayed
an alarm for a full day no matter what happened afterwards.

Production, read-only, at the moment of the screenshot (`NOW()` 17:45:00+00):
exactly **one** episode has ever been recorded — `idealista / captcha_wall /
detected_at 2026-08-22 14:53:33+00` — and after that instant idealista produced
**53 terminal captures** (14 `done`, 39 `withdrawn`, 2 `failed`), the most
recent 11 seconds earlier. The wall was real at 14:53, the owner cleared it by
hand as intended, and the proof that he had was already sitting in our own
tables, unread.

The rule was never in doubt — it was only ever applied on the wrong side of
the wire. `browser-extension/background.js:138` already does exactly this,
locally: *"A real capture succeeding is the resolve signal for a block episode
(issue #634)"* → `clearBlockIfActive(portal)` → `InmoBatch.clearBlock`. The
extension resolves its own episode on the first successful EXTRACT and resumes
draining, and it never tells the server. Its local TTL is 2 h
(`BLOCK_EPISODE_TTL_MS`, D-142) against the dashboard's 24 h, so there is a
22-hour window in which the extension is capturing normally while Estado shows
a red alarm chip. That gap is the measurable size of this defect, and it is why
the fix is a read-side derivation rather than a new rule: the rule already
exists and is already agreed on by both halves of the system.

**Decision**:

1. **An episode is resolved once a capture from that portal lands after it with
   an outcome that proves the portal SERVED us the page we asked for.** The
   clearing set is exactly `done`, `withdrawn`, `listing`. Everything else —
   `blocked`, `never_rendered`, `failed`, `pending` — does not clear.
2. **Resolution is DERIVED at read time, not stored.** No `resolved_at` column
   on `extension_block_episode`, no new writer, no extension change.
   `getRecentBlockEpisodes` computes it with a `LEFT JOIN LATERAL` over
   `extension_capture`, correlated on `connector_name = portal`.
3. **The comparison is anchored on `GREATEST(detected_at, reported_at)`**, not
   `detected_at`. The displayed timestamp stays `detected_at`.
4. **Two bounds, both required, in this order**: resolved beats the clock; the
   24 h window only expires an episode nothing has contradicted. Resolution is
   checked on the portal's NEWEST episode, after per-portal selection.
5. **Only the ACTIVE reading changes.** Actividad's `bloqueo` rows (#706) are
   history and keep rendering every episode, resolved or not.

**Alternatives rejected**:

- **A `resolved_at` column on the table.** It is queryable and survives
  hypothetical pruning of `extension_capture`, and it is still wrong here. A
  column needs a writer, and the missing writer *is the bug* — nothing observes
  the wall coming down, so the column would be null forever and we would have
  shipped a schema migration that changes nothing. Worse, a stored answer can
  drift from the evidence it was derived from; a derived one cannot. The
  pruning argument is also moot in fact: nothing in this repo ever deletes from
  `extension_capture` (only tests do), and resolution is only ever consulted
  inside a 24 h window, far shorter than any pruning horizon we would adopt.
- **`never_rendered` (#701) as a clearing outcome.** The tempting reading is
  "the portal served *something*". Its own schema comment says otherwise: the
  honest claim is *only* that "we ran out of patience", and it deliberately
  does not assert that a page arrived. A challenge page that never finishes
  rendering is precisely the shape that produces it, so letting it clear a
  block would let the failure mode announce its own absence.
- **`failed` as a clearing outcome.** Bytes arrived and the parser rejected
  them — evidence about our parser, not about the portal's willingness to serve
  us, and a wall whose phrase table has stopped matching lands here.
- **Making `_mark_blocked` (`etl/capture.py`) write an episode.** Checked: it
  does not today, and the gap is real — the extension's client-side detector
  and `capture.py`'s server-side `challenge_page_signature` are two independent
  detectors and only the first reaches the board. But it is a *different*
  defect (a missing signal, not a stale one); it adds a new alarm writer in the
  same change that fixes a false alarm; it needs episode de-duplication (one
  wall can produce dozens of `blocked` captures); and Actividad's `bloqueo`
  ledger would need to agree. Filed separately.
- **Shortening `ACTIVE_BLOCK_WINDOW_HOURS`.** Treats the symptom. D-168 argued
  that window carefully and the reasoning still holds; the bug was that it was
  the *only* bound, not that it was the wrong number.

**Rationale**:

This is D-157 pointed the other way. There, *elapsed time only nominates a
listing for verification; evidence decides whether it is gone.* Here, elapsed
time was allowed to keep **asserting** a state that evidence had already
contradicted. Same discipline, opposite direction: evidence clears a state
instead of setting one, and in both cases the clock is never the last word.

The line between clearing and non-clearing outcomes is "did the portal serve us
the page", not "did anything happen", because that is precisely the question a
block is about. The asymmetry decides every close call: failing to clear leaves
a stale alarm the owner can see is wrong (annoying, self-evident, and he did
see it); clearing wrongly hides a real wall behind a green board while the
capture queue drains into nothing. Ambiguity fails toward alarming — in the SQL
(only three positively-identified outcomes clear), in the clock (`GREATEST`
pushes the anchor later, demanding fresher evidence), and in the TypeScript
(anything that is not a real timestamp reads as unresolved).

**See**: issue #711 · `dashboard/lib/db/extension-blocks.ts` ·
`dashboard/lib/data-health.ts` (`activeBlocksByPortal`) ·
`dashboard/lib/db/__tests__/extension-blocks.integration.test.ts` ·
`etl/schema/init.sql` (`extension_block_episode`, `idx_extension_capture_served`) ·
`browser-extension/background.js` (`clearBlockIfActive`, the same rule applied client-side) ·
[D-157](D-157-evidence-not-time-for-withdrawal.md) ·
[D-168](D-168-admin-six-sections-etl-tree-deleted.md) · [D-159](D-159-idealista-retired-notice-evidence.md) ·
#634 (episode reporting) · #692 (`blocked`) · #690 (`withdrawn`) · #701 (`never_rendered`) ·
#706 (Actividad history) · #710 (Fuentes state notice)
