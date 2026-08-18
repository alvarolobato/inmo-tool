---
id: D-114
title: '"Capturar todo" is ONE page-level control across visible profiles, selection keyed by (profileId, taskId)'
date: 2026-08-18
group: Data / connectors
rule: "The `/captura` page's 'Capturar todo' button and its select-all/select-none are ONE control each, owned by `CapturaProfiles`, acting on every profile currently VISIBLE under the profile filter — never one pair per profile. Cross-profile selection/run-override state is keyed by `selectionKey(profileId, taskId)` (`dashboard/lib/captura-tasks.ts`), never a bare `CaptureTask.id` (which is only unique within one profile's filter scope). Per-task ticking is exposed via an ALWAYS-VISIBLE compact checklist in `ConnectorSection`, never gated behind its collapsible — `CaptureTaskRow`'s full detail row carries no checkbox of its own."
---

# D-114: "Capturar todo" is ONE page-level control across visible profiles, selection keyed by (profileId, taskId)

*Decided: 2026-08-18*

**Context**: Issue #556 asked for guided-capture batching; the owner was asked
directly "¿el botón es por perfil o global?" and answered "global, con los
checks me apaño" (global, with checkboxes I'll manage). #556 was nonetheless
written, and #558 built, as **one "Capturar todo" button + one select-all/none
pair PER PROFILE**, with the per-task checkboxes living inside
`ConnectorSection`'s collapsible (issue #559 body). The owner tried it and
rejected it outright, in his own words:

> *"te pedí un seleccionar todo que funcione en todos los perfiles a la vez y
> un capturar para todos también, no por perfil. los checkbox están dentro del
> desplegable lo que me obliga a abrirlo. ponlo fuera. el botón de captura que
> sea solo uno, y seleccionar todo nada que sea global y por perfil."*

This was a spec error on the implementing side, not a change of mind — the
answer to the direct question was on record before #556 was written. Issue
#559 is the correction. This decision records the two structural choices that
correction required, on top of D-113 (which owns the actual FRAGMENT-carrier
transport to the extension — untouched, see D-113's "Amended" section for how
the two decisions now relate).

**Decision**:

1. **Selection state (`ticked`) and the optimistic run-override map
   (`runOverrides`) are owned by `CapturaProfiles`** (the page-level component
   that already owned the profile filter, issue #413), not
   `CapturaProfileSection` (one instance per profile). The button, the
   select-all, and the select-none are each rendered EXACTLY ONCE on the page.
   `CapturaProfileSection` becomes a thin per-profile TRANSLATOR: it maps the
   global, cross-profile maps down to the plain per-task-id `Set`/`Record`
   shape `ConnectorSection` (and `CaptureTaskRow` beneath it) already
   expected — so neither of those two components needed to change their own
   selection API, only what feeds it.

2. **"Visible" is defined by the existing profile filter
   (`captura-profile-filter`), not "every profile that exists".** The button's
   live count, select-all, select-none, and the click itself all act on
   `allTasksAcrossProfiles(visible)` — the profiles the filter currently
   shows — never the full unfiltered set. A scope note
   (`captura-batch-scope-note`) names the active filter whenever it narrows
   the set, so the count can never silently mean something other than what
   the owner can see. The underlying ticked Set is still seeded once from
   EVERY profile's default-due tasks (so toggling the filter never discards a
   tick made on a now-hidden profile), and select-all/select-none only ever
   add/remove VISIBLE keys — a filtered-out profile's ticks are read-only from
   the filtered view, never touched by it.

3. **Cross-profile selection is keyed by `selectionKey(profileId, taskId) =
   "${profileId}:${taskId}"`, never a bare `CaptureTask.id`.** `CaptureTask.id`
   is a hash of portal + normalized filters (see its own type doc) — it is
   "stable for the same profile + filters", NOT globally unique across
   profiles. Two different profiles with identical scope/filters on the same
   portal section legitimately produce the SAME task id (confirmed:
   `capture_task_run`'s own primary key is the pair `(profile_id, task_id)`,
   for exactly this reason). A page-level ticked `Set<string>` that used bare
   task ids would silently conflate two different profiles' tasks the moment
   two profiles shared a filter shape. `buildGlobalCaptureBatchPlan` /
   `capGlobalCaptureBatchPlan` (`dashboard/lib/captura-tasks.ts`) are the
   cross-profile counterparts of D-113's original `buildCaptureBatchPlan` /
   `capCaptureBatchPlan` — the global builder REUSES the original verbatim
   over a keyed id space (never re-implements the selection/ordering logic);
   the cap function mirrors the original's slicing semantics directly
   (`entries` in place of `taskIds`) and additionally reports WHICH profiles
   lost entries to `MAX_QUEUE_ENTRIES` (`droppedProfileIds`), since the
   button spanning profiles means the cap can now bite mid-profile — a bare
   dropped-count no longer tells the owner where to click again.

4. **Per-task selection is exposed via an ALWAYS-VISIBLE compact checklist on
   `ConnectorSection`, never gated behind `expanded`.** This was the owner's
   second, independent complaint ("los checkbox están dentro del desplegable…
   ponlo fuera") and is orthogonal to (1)-(3) above — it would have been a bug
   even in the original per-profile design. `ConnectorSection` renders one
   compact row per task (checkbox + label + a muted/"hecho" cue) immediately
   after its header, unconditionally; the full per-task detail (execute
   button, loosened-constraint flags, exact last-run time) stays behind
   `expanded` as before, but carries NO checkbox of its own —
   `CaptureTaskRow` was stripped of its `checked`/`onToggle` props entirely,
   so there is exactly one checkbox per task on the page, never two
   out-of-sync copies. This is what makes the common case — "everything due
   is already ticked, press one button" — cost zero expansions, and deviating
   from the default (tick a muted task back in, untick a due one) cost zero
   expansions too.

**Alternatives rejected** (per-task checklist shape, issue #559's own "design
notes" invited weighing these):

- *A tri-state checkbox on the collapsed connector header* that
  reflects/toggles all its tasks at once, with per-task boxes only inside the
  expanded body. Rejected: it satisfies "tick without expanding" only at
  connector granularity — the owner explicitly still wants to force a single
  grayed task back in or skip a single due one ("con los checks me apaño")
  without dragging its whole connector along. A tri-state control can be
  added later as a convenience layered ON TOP of the per-task checklist this
  decision keeps; it is not a replacement for it.
- *A compact per-connector selection summary* ("5/7 seleccionadas") that
  expands into checkboxes only when the owner wants to deviate. Rejected for
  the same reason — it re-introduces an expand step for the exact case (fine
  per-task control) the owner asked for, just gated on "deviating" instead of
  "viewing detail". The always-visible checklist costs a little more vertical
  space per connector but never requires a click to reach a checkbox.
- *Keep selection keyed by bare task id, relying on real profiles rarely
  sharing identical filters.* Rejected outright — "rarely" is exactly the
  kind of latent bug this project's own `capture_task_run` schema (keyed on
  the PAIR since day one, D-048) already anticipated. A composite key costs
  nothing and removes the failure mode entirely rather than betting against
  it.

**Rationale**: The owner's ask was specific and was answered before #556 was
written — the fix is to build exactly that, not to renegotiate it. Keeping
D-113's transport untouched (fragment carrier, cap mechanism, D-112 handoff)
while relocating ownership and re-keying selection is the smallest change that
corrects both complaints (global control, checkbox reachability) without
touching the parts of #556/#558 that were never in question.

**See**: issue #559 (the correction, quoting the owner verbatim);
[D-113](D-113-capturar-todo-batch-queue-piggyback.md) (the transport this
decision's plan-builders feed — its own "Amended" section cross-links back
here); D-112 (the extension-side queue, untouched); D-043 (concurrency/pacing,
untouched); D-048 (the task model + staleness window this reuses verbatim,
and the `(profile_id, task_id)` primary key that already anticipated non-global
task-id uniqueness); D-045 (execution vs. setup placement — unaffected).
`dashboard/lib/captura-tasks.ts` (`selectionKey`, `ProfileTask`,
`allTasksAcrossProfiles`, `defaultTickedSelectionKeys`,
`buildGlobalCaptureBatchPlan`, `capGlobalCaptureBatchPlan`),
`dashboard/components/captura/CapturaProfiles.tsx` (owns `ticked`,
`runOverrides`, `onCapturarTodo`, the scope note),
`dashboard/components/captura/CapturaProfileSection.tsx` (the per-profile
translator), `dashboard/components/captura/ConnectorSection.tsx` (the
always-visible checklist), `dashboard/components/captura/CaptureTaskRow.tsx`
(checkbox removed); `dashboard/e2e/captura-tasks.spec.ts` (two seeded
profiles, tickable-while-collapsed, filter-scoped count).
