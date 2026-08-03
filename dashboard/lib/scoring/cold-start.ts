/**
 * The explanation stored on a candidate whose profile has no usable trained
 * model yet (task 3.3, #22).
 *
 * Lives in its own dependency-free module because both sides need it: the
 * server writes it (lib/scoring/explain.ts) and client components read it to
 * recognise it (#152 — CandidateCard suppresses it, CandidateList shows it
 * once as a page-level footer). Importing it from `explain.ts` would drag
 * `features.ts` → `lib/db-write` → `pg` into the browser bundle and fail the
 * build with "Can't resolve 'dns'/'tls'".
 *
 * Recognising the cold-start state by comparing against this exact string is
 * a deliberate, if blunt, choice: `profile_listing_state.score_kind` is the
 * durable marker, but `lib/candidates.ts` doesn't expose it to the client
 * yet. If a future change makes the UI branch on more than this one state,
 * surface `score_kind` in `CandidateRow` and switch on that instead.
 */
export const COLD_START_EXPLANATION =
  "Sin personalizar todavía — acepta o rechaza algún candidato en este perfil para que el modelo empiece a aprender tus preferencias.";
