/**
 * The explanation stored on a candidate whose profile has no usable trained
 * model yet (task 3.3, #22).
 *
 * Lives in its own dependency-free module because both sides need it: the
 * server writes it (lib/scoring/explain.ts) and CandidateList reads it to
 * render the page-level cold-start footer (#152). Importing it from
 * `explain.ts` would drag `features.ts` → `lib/db-write` → `pg` into the
 * browser bundle and fail the build with "Can't resolve 'dns'/'tls'".
 *
 * The UI does NOT detect the cold-start state by comparing
 * `rank_explanation` against this string — `CandidateRow.score_kind`
 * (surfaced from `profile_listing_state.score_kind`) is the durable marker
 * `CandidateCard`/`CandidateList` switch on (#152 review, must-fix "also
 * fix" list). A previous version compared strings; that broke silently the
 * moment this constant's text changed, because the comparison target is
 * itself *persisted* on already-written rows. This export exists purely to
 * supply the display copy, not to identify the state.
 */
export const COLD_START_EXPLANATION =
  "Sin personalizar todavía — acepta o rechaza algún candidato en este perfil para que el modelo empiece a aprender tus preferencias.";
