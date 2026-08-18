# LLM batching & call-consolidation plan (round 2 after PR #536)

*Written 2026-08-18 by a fresh-context Fable design pass, against `main` plus the merged PR #536 work (D-102..D-105). Companion to [llm-cost-optimization.md](llm-cost-optimization.md); this plan covers the structural follow-ups: F-1, F-2, F-3, F-6, F-7 interactions, plus multi-property batching and the eligibility questions the owner raised.*

All € / $ figures below are the CLI's notional list price (D-102 caveat: under OAuth this is a comparison metric, not an invoice). Token estimates use ~3.6 chars/token for the Spanish prompts.

---

## 1. Verification findings

### 1.1 The eligibility gate the owner asked for already exists — confirmed, with live-data evidence

The claim "LLM only runs on properties that already matched a profile's non-LLM filters" is **correct for the scheduled path**, which is the only path that runs unattended:

- `assessmentEligibleClause` (`dashboard/lib/ai-assessment/eligibility.ts:67`) requires an `EXISTS` on `profile_listing_state.matched = true` joined to a non-archived `search_profile`, plus an active described listing from a non-disabled source.
- `selectPropertiesNeedingAssessment` (`dashboard/lib/ai-assessment/batch.ts:164`) composes exactly that clause with `missingCurrentVerdictClause` (`eligibility.ts:110`), `ORDER BY p.created_at ASC` (`batch.ts:179`).
- `materializeProfile` (`dashboard/lib/filtering/materialize.ts:58`) sets `matched` from `buildScopeWhereClause(profile.scope)` (`materialize.ts:64`), which includes the Haversine geography filter.

**Live numbers (demo stack DB, 2026-08-18):** 9,563 properties ingested; only **1,918** are assessment-eligible (matched by ≥1 of the 5 active profiles with a readable active listing) — an **80% reduction** the gate is already delivering. Of those, ~94 are still pending on the three selection flows. The gate works and the backlog is nearly drained; **the dominant future cost events are prompt-version bumps**, not new ingest — `ai_assessment` shows redflags has been through five versions (v2/v3/v4/v6/v8 with 199/249/14/402/1,855 rows), each reopening the full pool. That is why F-7 (pre-bump cost preview) and bump-batching are load-bearing in this plan.

### 1.2 The real gaps in the owner's question — (a), (b), (c)

**(a) On-demand POST routes have no eligibility check — confirmed, but it is not a hole worth plugging with a hard gate.** `POST /api/properties/[id]/assessments/condition/route.ts` (and its five siblings) call `assessPropertyCondition` directly with no `assessmentEligibleClause`. However: (i) the routes are admin-credential gated; (ii) **they have zero UI callers** — grep of `dashboard/components` and `dashboard/app` (non-API) finds none; they are curl/operator-only, and `?force=1` on them is the *documented* D-104 unpark escape hatch (`condition/route.ts:127`); (iii) they are already protected by the budget, breaker, kill switch, and failure ledger. A hard 403-if-unmatched would break the operator's ability to probe an arbitrary property and buys nothing an unattended path could exploit. **Recommendation: no hard gate.** Optionally add an advisory `"eligible": false` field to the POST response (one EXISTS query) so an operator poking an unmatched property knows the scheduler will never refresh it.

**(b) The D-067 chicken-and-egg is structurally real but currently affects zero properties.** The loop exists: `scope-query.ts:260/264` filter `extractFallbackExpr("m2_built") >= min` — when both `property.m2_built` and the extract row are NULL, the comparison is NULL → the property is **excluded**; same for rooms/bathrooms/floor-exclusion. (`requires_elevator` deliberately passes unknowns via `IS NOT FALSE`, `scope-query.ts:294`.) An excluded property never matches → never assessed → `extract` never fills the field → never matches. **But**: all 5 active profiles' scopes constrain only `geography`, `price_max/min`, and `property_types` — none of which extract can fill (extract's fields are m²/rooms/bathrooms/floor/elevator, `extract.ts:108`) — and every profile has empty `hard_exclusions`. So today the trap **cannot spring**. It arms itself the day the owner adds a rooms/m² constraint to any profile. Second latent gap found while verifying: **an extract row landing never triggers re-materialization** — D-046's staleness reconciler anchors on `MAX(GREATEST(last_seen_at, first_seen_at))` of *listings* (`etl/materialize_reconciler.py:36`), not on `ai_assessment.generated_at`, so even a filled field only flips `matched` on the next listing-driven materialize. Resolution proposal in §3 Phase 4 — deliberately deferred because it is dead code until a profile uses those fields.

**(c) Timing: safe by construction, no premature-assessment window.** The scheduler doesn't consume a queue — it evaluates `matched = true` **at selection time, in the same SQL query** (`batch.ts:164-181`). A freshly ingested, not-yet-materialized property is simply invisible to it. The failure mode is *delay*, never *assessing before filtering*: ingest fires `notify_materialize_all` (D-044, best-effort, in a `finally`), the D-046 reconciler self-heals a missed notify within ≤120s, and the assessment tick is 900s — so materialization is always ≥1 reconciler pass ahead of selection in practice. The only spend-shaped race is a property assessed while matched then unmatched by a profile edit: sunk cost, verdict stays cached, harmless.

### 1.3 Corrections and facts the plan is built on

- **Measured stable-prompt sizes** (chars, from `system-prompt.ts` template ranges): occupancy 7,537 (~2,100 tok); condition 4,950 (~1,400); redflags 4,139 + trending/dismissed blocks (~1,200+); location 4,024 (~1,120); opportunity 3,265 (~910); extract 2,849 (~790). `DOMAIN_PREAMBLE` (519 chars) and `ASSESSMENT_RULES` (600 chars) are duplicated into every stable prompt.
- **Measured volatile payloads** (live DB, eligible properties): median 1,425 chars of description, p90 2,898, max 17,637; **1.06 active described listings per property** (dedup rarely merges) → volatile ≈ 500–700 tokens. Per-property six-flow total ≈ ~11k input + ~1.5k output ≈ **$0.019** — independently consistent with D-103's end-to-end measurement.
- **F-2 confirmed at source**: the redflags trending and dismissed blocks render **inside the `stable` template** (`system-prompt.ts:890,894`), so any corpus growth re-cooks the flow's cacheable prefix. They are deliberately *not* in the content hash (`redflags.ts:369` — correct, keep that).
- **CLI caching — MEASURED (Phase 0c, see §3): real, but the pre-F-13 shape captured none of it; F-13 has since landed (issue #543).** `stable` and `volatile` used to be **concatenated** and sent as the stdin `## system` section (`llm-client.ts:127`, `cli/claude-code.ts:21-27`); `--system-prompt` carried only the protocol shim. With that shape the cache breakpoint landed at the end of the whole body: a 20,120-char stable block shared between two calls whose tails differ read back **zero** (only a byte-identical repeat hit). F-13 moved the stable block onto `--system-prompt`, where it IS reused across a differing tail on a synthetic block above the cache floor — **$0.0200 → $0.0058, ~71% off the same call** — but a re-probe against the REAL (smaller) per-flow prompts showed **zero measured saving today**: every flow's stable block sits below Haiku 4.5's 4,096-token minimum cacheable prefix. See the "F-13 landed" subsection right after the 0c result below for the full re-measurement. So the cache-ordering items (F-1/F-2) still have no CLI-side value until a stable block crosses that floor (D-B batching or D-A's triage merge); F-13 remains the correctness prerequisite for that to ever pay out.
- **The demo stack has not been redeployed since #536 merged** (at time of writing): older `llm_usage` rows store 0 tokens / $0. Baseline measurement requires the redeploy first (Phase 0).
- **Advisory-lock mechanics constrain the batch design**: `getOrCompute` holds one per-`(property, flow)` session lock on a **dedicated pooled client** (`cache.ts`, `withAdvisoryLock`), and the pool is capped at **5 connections** (`db-write.ts:59`). Naively nesting `withAdvisoryLock` per property in a batch of 5 would exhaust the pool and deadlock against the app's own queries. The batch path must take all its locks **on one client** (a session can hold many advisory locks), in sorted key order.
- **`ASSESSMENT_SELECTION_FLOWS` is still occupancy/condition/redflags only** (`eligibility.ts:47`) — F-9 (add location/opportunity) is confirmed still open, and matters here because merging axes changes what "pending" must mean.
- **`temperature: 0`, `maxOutputTokens: 2048`** on assessment flows (`llm.ts:123-124`); batched calls must scale the output cap.

---

## 2. Design decisions

### D-A. Merge `condition` + `location` + `opportunity` into one multi-axis call ("triage"). Do NOT merge occupancy, redflags, or extract.

**Decision:** One new flow, `triage`, whose prompt asks for all three verdicts over the identical payload and returns `{"condition": {...}, "location": {...}, "opportunity": {...}}`. The three existing parsers (`parseConditionResult`, `parseLocationResult`, `parseOpportunityResult`) are applied to the per-axis sub-objects **unchanged** (they already accept an object; only the JSON.parse/fence-strip step is hoisted). Three per-axis `ai_assessment` rows are written exactly as today — same `assessment_type` values, same result shapes, same `save*Assessment` functions — under bumped per-axis versions (`condition/v3`, `location/v2`, `opportunity/v2`, each documenting "generated by triage/v1"). **Every existing reader keeps working with zero changes**: `loadFlags`, `candidates.ts`, the badges, D-059 filters, and D-067's extract fallback all read latest-row-per-`assessment_type` with no version filter, so they cannot tell a triage-written row from a single-flow row. The GET routes keep working for the same reason. The per-axis POST routes are re-pointed at the triage flow (a POST to `/assessments/condition` runs triage and returns the condition slice — one call now refreshes three axes, which is strictly better for the operator).

**Why these three and not the others:**

| Axis | Merge? | Reason |
|---|---|---|
| condition | ✅ | Short closed-vocabulary classification, no price signal, plain `propertyVolatile` payload |
| location | ✅ | Same payload byte-for-byte, closed vocabulary, evidence-guarded — D-095 is satisfied (it is still the LLM reading the text; D-095 forbids *regex*, not shared calls) |
| opportunity | ✅ | Same payload, two evidence-guarded booleans |
| occupancy | ❌ | Highest-value axis (issue #1 §9) with the subtlest verdict discipline (three sub-axes, `silenceDefault` + `SILENCE_CONFIDENCE_CAP` on ejes 2/3) and the D-012 price signal in payload + `extraHashInput`. Merging risks quality exactly where the owner cares most, for the smallest marginal saving. |
| redflags | ❌ | Open-vocabulary extraction with the trending/dismissed candidate mechanics (D-087, #396/#407) and the D-012 price signal. Extraction and classification in one completion measurably drag on each other's instruction-following; the prompt-version churn history (5 bumps) says this prompt is still evolving. |
| extract | ❌ | Self-gating (`needsExtraction`, skips the LLM entirely for fully-structured properties — merging would force it to run always or complicate the gate); objective "no inventes" discipline that must not share a completion with judgment axes; D-067 depends on its `confidence_per_field` shape. |

D-056 (renovation_severity) and D-087 (redflags vocabulary) are untouched: severity stays a sub-field of the condition slice with the same parser; redflags isn't merged.

**Terreno handling:** condition applies to terrenos; location/opportunity skip them (`locationApplies`/`opportunityApplies`). The triage *code* keeps the skip: for a terreno it requests/parses the condition axis only (a one-line "solo evalúa el eje condition" volatile note, hashed via `extraHashInput` so prompt and hash agree per D-012's discipline) and writes no location/opportunity rows — identical observable behavior to today's skip path.

**Alternatives rejected:** (i) *one combined `ai_assessment` row of type `triage`* — breaks every keyed reader, D-059's per-axis filter columns, and the coverage panel; rejected outright. (ii) *merge all five judgment axes into one call* — see table. (iii) *a single shared `TRIAGE_PROMPT_VERSION` replacing per-axis versions* — would break `missingCurrentVerdictClause`'s per-axis accounting and the stale-badge semantics; per-axis versions bumped in lockstep give the same effect without touching readers.

**Expected saving (merge alone, per property):** replaces 3 calls (≈5,230 input tok + 3 CLI spawns) with 1 call (merged stable ≈2,400 tok + 600 volatile ≈3,000 input). ≈ **2,500 input tokens/property saved (~23% of six-flow input)**, output unchanged, calls 6→4 (typically 5→3 since extract self-gates). ≈ $0.019 → ~$0.016/property. Modest in dollars — the merge's larger value is that it is the vehicle for the N-property prompt shape below.

### D-B. Multi-property batching: write every assessment prompt N-property-capable ONCE; the harness packs cache-miss properties per flow

**The prompt change and the batching change are separated.** The Phase-2 prompt rewrite makes each flow's prompt describe its input as "uno o más inmuebles, cada uno identificado por `property_id`" and its output as a JSON array keyed by echoed id — valid at N=1. Turning batching *on* later changes no prompt text, therefore **no second prompt-version bump and no second backlog reopening**.

**How many properties per call:** input = S + N·V, output = N·O (S = stable prompt, V ≈ 600 tok volatile/property, O ≈ 400–700 tok output/property). Per-property input = S/N + V:

| N | triage input/prop (S≈2,400) | occupancy input/prop (S≈2,100) | marginal saving vs prev step |
|---|---|---|---|
| 1 | 3,000 | 2,700 | — |
| 2 | 1,800 | 1,650 | large |
| 4 | 1,200 | 1,125 | large |
| 5 | 1,080 | 1,020 | small |
| 8 | 900 | 863 | ~180 tok/prop ≈ $0.0002 |
| 16 | 750 | 731 | negligible |

The binding constraints are **not** the context window (Haiku 200K) but: **output tokens** (they don't amortize, and past N≈5 they dominate); **output truncation** (`maxOutputTokens` must scale as `N × 900 + 512`; a truncated batch wastes the whole call); **verdict-quality degradation** (cross-property evidence bleed grows with N); **blast radius** (one bad completion defers N properties one tick).

**Decision: default `dashboard.assessment_flow_batch_size = 4`, hard cap 8.** 4–5 captures ~85% of the achievable input amortization; everything past that is risk for cents.

**Response mapping:** the model must echo each property's integer id. Returned ids must be a subset of requested ids (unknown → dropped + logged); duplicates → first wins + logged; per-axis sub-objects go through the existing per-axis parsers, so evidence-discipline degradation stays per-axis and per-property. **Evidence attribution check**: each axis's `evidence` quote must appear as a substring in *that property's own* listing text, else the axis degrades exactly as an uncited claim does today. This turns the main batching failure mode (cross-property bleed) into the already-tested degrade path instead of a wrong confident verdict.

**Partial/malformed batches:**
- **Valid entry** → save + `clearAssessmentFailures`, as today. Good results from a partially-bad batch are persisted, never re-billed.
- **Missing or invalid entry** → that property is **retried as a single call** (same tick). The single call is today's fully-tested path: if the property is genuinely poisonous, *that* call fails and earns its D-104 strike with the correct key.
- **Whole response unparseable / truncated** → **no strikes for anyone**; all N fall back to single calls. Worst case N+1 calls instead of N.

Net effect on D-104: **the batch path never writes strikes; the ledger is fed exclusively by single calls.**

**Interaction with the #30 cache and its advisory locks:** a new `getOrComputeBatch(flow, propertyIds, ...)`:
1. Per property: load listings, compute per-property `content_hash` (**never** one hash over the batch), check `getLatestAssessment` and the failure ledger; drop hits and parked entries.
2. Acquire the per-`(property, flow)` advisory locks for the remaining misses **on one dedicated client, in sorted key order** (a Postgres session can hold many advisory locks; sorted order prevents deadlock against a concurrent POST-route single call). Mandatory given the `max: 5` pool.
3. Re-check cache under lock, one LLM call for the survivors, per-property save/fallback, release all, then run the single-call fallbacks.

**Interaction with prompt caching:** the volatile block already differs on every call. Only the stable prefix is cacheable; batching leaves it byte-identical and reduces how many times it is **transmitted at all** from N to 1 — which strictly dominates a cache hit (0.1× is still ~10× more than 1/N at N≥4) and works on the CLI path even if `claude -p` gives no cross-invocation reuse.

**Expected end-state saving:** at N=4–5 across occupancy/triage/redflags, per-property input drops ~11k → ~3.8–4.2k tokens; output unchanged (~1.5k, now dominant). ≈ **$0.019 → ~$0.011–0.012/property (~40%)**, plus ~4× fewer CLI spawns per tick.

### D-C. Two supporting changes the batch path needs

- **`LLM_CLI_TRUNCATED` in a batch context must not strike** (it correctly strikes for single calls). In a batch, truncation is a function of N, not of any property's text. Covered by the "batch never strikes" rule; fallback singles use a per-single output cap.
- **`maxOutputTokens`** becomes flow-dependent: single 2,048 (unchanged), batch `min(8192, N × 900 + 512)`.

### D-D. The roadmap cache items (F-1, F-2, F-6)

- **F-1 (flow-major ordering)** — **land it as the batching prerequisite, not for its cache rationale.** Batching requires collecting N properties per flow, i.e. exactly the flow-major restructure. Land it early (pure control flow, no prompt changes, no bumps).
- **F-2 (move trending/dismissed out of the redflags stable block)** — still needed: a stable block that mutates as the corpus grows kills whatever caching the provider does. Keep them **out of the content hash**. Requires the `REDFLAGS_PROMPT_VERSION` bump — rides the Phase-2 bump wave, never ships alone.
- **F-6 (1h cache TTL)** — **diminished, OpenRouter-only.** No TTL knob on `claude -p`. On OpenRouter still ~2.3× cheaper on the stable prefix, but that prefix is by then ~1/4 of the input. Two lines, only if Phase 0 shows OpenRouter in use.

### D-E. The (b) chicken-and-egg resolution — deferred, gated, explicit

When (and only when) an active profile constrains an extract-covered field, add an **extract pre-pass**: a selection predicate — "would match this profile if every extract-covered condition were dropped, AND has a NULL in a constrained field, AND has no current extract row" — feeding `extract` only. Pair with a reconciler tweak so `ai_assessment.generated_at` for extract counts toward materialization staleness. Until then, make the trap *visible*: warn in the profile editor when a scope sets an m²/rooms/bathrooms/floor/elevator constraint. Quantified impact today: **zero properties**.

---

## 3. Implementation plan

Each phase is a self-contained PR (Phase 2 is two PRs). Each follows the D-003 review flow.

### Phase 0 — Trust the meter, measure the cache (S; 3 small PRs, fully parallel; land first)

- **PR 0a — F-5 + F-8:** unify the two rate tables (`lib/llm-usage.ts` vs `lib/llm-health.ts` — export one `DEFAULT_LLM_RATES` from a single module; test that both consumers price a configured cheap model identically). Add the zero-usage canary to `/etl/salud`: count of `llm_provider='cli'` rows in the last 24h with `total_tokens = 0`; render red when nonzero.
- **PR 0b — F-7:** pre-bump cost preview. Given a set of `assessment_type`s, count properties satisfying `assessmentEligibleClause` that would satisfy `missingCurrentVerdictClause` under a *hypothetical* new version, times the recent average per-call cost per flow from `llm_usage` (reuse `projectBacklogCostEur`). **Must merge before Phase 2.**
- **PR 0c — CLI cache probe:** a dev script that measures three shapes against the real `claude` CLI — the stable block concatenated into stdin with a *varying* tail (production's shape), the same prompt byte-identically repeated (control), and the stable block moved onto `--system-prompt` with a varying tail — and prints `cache_read_input_tokens` / `cache_creation_input_tokens` / `total_cost_usd` from the D-102 envelope for each. Tails are nonced per run so no measurement can hit a previous run's cache. Records whether, and under which shape, `claude -p` gives cross-invocation prefix caching. Document the answer here.
- **Operational (no PR):** redeploy the demo stack so post-#536 metering is live.

**Exit criteria:** canary green with real token counts flowing; F-7 preview reproduces the known backlog for current versions; cache-probe result documented.

#### 0c result — MEASURED: CLI prompt caching is real, but today's stdin shape gets none of it

Run 2026-08-18 via `dashboard/scripts/probe-cli-cache.ts` against the real
`claude` CLI (`--model claude-haiku-4-5`, lean mode on). Two earlier versions of
this probe reached two different wrong answers; both mistakes are recorded here
because each is easy to repeat.

- **Wrong answer #1 — "caching works."** The probe sent two *byte-identical*
  prompts and saw a 100% cache read. Real, but irrelevant: an identical prompt
  is the one thing production never sends, because the volatile block differs
  on every call by construction. Caught in review.
- **Wrong answer #2 — "caching does nothing for us."** The follow-up ran at a
  7,920-char prefix (~2,200 tokens) and saw `write=0 read=0` everywhere, which
  looked like "the CLI doesn't cache". That was a size artefact: Haiku 4.5 has a
  **4,096-token minimum cacheable prefix**, and nothing below it caches at all.
- **Third mistake, caught by re-running:** fixed tails meant the second run of
  the probe scored a *whole-prompt* hit against the first run's still-live cache
  entries and reported reuse everywhere. The tails now carry a per-run nonce, so
  every prompt measured below is one the API had provably never seen.

**The measurement.** Identical 20,120-char (~5.8k-token) stable block, above the
model minimum, nonced tails:

| variant | stable block carried in | tail | cache_creation | cache_read | cost |
|---|---|---|---:|---:|---:|
| A1 | stdin (production's shape) | A (new) | 5,825 | 0 | $0.0208 |
| A2 | stdin | B (new) | 5,826 | **0** | $0.0200 |
| B | stdin | byte-identical repeat of A2 | 0 | **5,826** | $0.0102 |
| C1 | `--system-prompt` | A (new) | 254 | 5,498 | $0.0049 |
| C2 | `--system-prompt` | B (new) | 255 | **5,498** | $0.0058 |

Two findings, and the second one is actionable:

1. **In the stdin shape the cache breakpoint sits at the END of the whole body.**
   A2 shares 20,120 identical leading characters with A1 and still reads zero —
   only B, byte-identical, hits. Any per-property difference is a full miss and
   a full re-write. **Today's code gets no prefix reuse whatsoever.**
2. **Move the same block to `--system-prompt` and it gets its own breakpoint
   that survives a differing tail.** C2 read back 5,498 tokens on a prompt never
   sent before, writing only 255 — **$0.0200 → $0.0058, ~71% off the identical
   work.** (C1 read too, off an entry from an earlier probe run: system-prompt
   entries persist across invocations within the TTL, which is the point.)

**What this means for later phases:**

- **F-13 (carry the real domain system prompt via `--system-prompt` instead of
  the stdin `## system` section) is promoted from a tidiness item to the single
  highest-leverage cache change on the default provider** — a measured ~71% cut
  in per-call input cost, applying to every flow, with no prompt-version bump
  and no behaviour change. Filed as its own issue; it is a prerequisite for any
  cache-based justification below. Note the split must keep the flag's contents
  byte-stable per flow, or it degrades to the A2 result.
- **F-1 and F-2 have no CLI-side cache value *until F-13 lands*.** Keep F-1
  regardless — it is the structural prerequisite for batching (D-D already said
  to land it for that reason, not the cache one). F-2 (keeping the redflags
  stable block from mutating as the corpus grows) becomes worth its bump only
  once F-13 makes the block cacheable at all; sequence it after.
- **F-6 (1h TTL) stays OpenRouter-only** — no TTL knob on `claude -p`.
- **D-B (multi-property batching) remains the only win that needs no cache**:
  it cuts how many times the stable prefix is *transmitted*, N → 1, which
  strictly dominates a cache hit and is unaffected by all of the above. It also
  pushes a call further past the 4,096-token floor, so it compounds with F-13
  rather than competing with it.
- **Re-probe after F-13 and after Phase 3**, in that order. The script is kept
  for exactly this.

#### F-13 landed (2026-08-18) — re-probed with the synthetic block AND the real production prompt

F-13 (issue #543) moved the CLI single-shot path's `stable` block onto
`--system-prompt` (as a byte-stable prefix ahead of the protocol shim,
`SINGLE_SHOT_PRINT_ARG` — see `llm-client.ts`'s `buildCliMessages` and
`cli/claude-code.ts`'s `claudeCliSingleShotOnce`), and left `volatile` +
the conversation turns in stdin. Byte-stability per flow is unit-tested
(`lib/__tests__/llm-client.test.ts`, "CLI system-prompt split (F-13)"): two
calls for the same flow with different property payloads produce a
byte-identical `systemPrompt` value with no per-property marker in it.

**Re-run of `scripts/probe-cli-cache.ts`** (synthetic 20,120-char / ~5.8k-token
block, same shape as the original Phase 0c run, new nonce) reproduced the
original result almost exactly, confirming the fix behaves as measured:

| variant | cache_creation | cache_read | cost |
|---|---:|---:|---:|
| A2 (stdin, varying tail — pre-F-13 shape) | 5,880 | 0 | $0.0209 |
| B (stdin, byte-identical control) | 0 | 5,880 | $0.0096 |
| C2 (`--system-prompt`, varying tail — now production's shape) | 255 | 5,498 | $0.0065 |

**Then the real thing: the actual production prompt shape, not the synthetic
probe block.** Built the real `occupancy` stable prompt via
`buildSystemPrompt("occupancy", vars)` (occupancy is the largest of the six
assessment flows) for two different properties, and ran each through the
now-updated `claudeCliSingleShot({ cfg, prompt, systemPrompt: stable })` —
the exact production call shape:

| call | stable block | cache_creation | cache_read | cost |
|---|---:|---:|---:|---:|
| property A (cold) | 9,560 chars (~2,655 tok) | 0 | 0 | $0.0117 |
| property B (different property, same flow) | 9,560 chars (~2,655 tok), byte-identical to A | 0 | 0 | $0.0103 |

**Honest result: zero measured saving today.** `occupancy`'s real stable
prompt (9,560 chars — grown from the 7,537 chars measured at the start of
this plan, still the largest of the six flows) is ~2,655 tokens, below Haiku
4.5's 4,096-token minimum cacheable prefix (the same floor "wrong answer #2"
above hit at ~2,200 tokens). Neither call shows a cache write OR a cache
read — the CLI doesn't even attempt to cache a prefix this size, exactly as
Phase 0c predicted for a below-floor block. The other five flows' stable
prompts are all smaller than occupancy's (condition/redflags/location/
opportunity/extract, per §1.3's per-flow sizes), so none of them cross the
floor either.

**F-13 is still the right, necessary change**, for two reasons independent of
today's zero: (1) it is a correctness prerequisite — the pre-F-13 shape could
never cache regardless of prompt size, since the breakpoint sat at the end of
a body whose tail always varies; a call is now at least *eligible* the moment
its stable block crosses the floor. (2) It compounds with D-B (multi-property
batching, still unimplemented) and D-A (the "triage" axis merge), both of
which grow the stable block — batching N properties' worth of instructions
into one call, or merging condition+location+opportunity into one prompt,
push the stable prefix up toward and past 4,096 tokens, at which point this
change starts paying out exactly as the synthetic probe showed (~71% off the
identical work). Until one of those lands, expect `llm_usage`'s `cli` rows to
show `cache_creation_input_tokens = cache_read_input_tokens = 0` for the
single-shot assessment flows — that is the correct, expected state, not a
regression.

**Re-probe again after D-B or D-A lands** (whichever ships first) — that is
the point at which this section's "zero measured saving" line should flip.

### Phase 1 — Flow-major batch loop (M; 1 PR; parallel with Phase 0)

Restructure `runAssessmentBatch` from property-major to flow-major without changing any observable outcome except call order. Same summary counters, same budget/circuit clean-stop semantics. Keep the once-per-batch trending/dismissed fetch where it is.

**Tests:** existing `batch.test.*` adjusted for call order; a new test pinning that a budget stop mid-flow still returns partial counters and that skip/park/noListings accounting is unchanged.
**Exit criteria:** identical `AssessmentBatchResult` totals on a seeded DB vs the old loop (order-insensitive assertion); no prompt/version diffs anywhere. **This PR must NOT touch prompts.**

### Phase 2 — The one bump wave: triage merge + N-capable prompts + F-2 + F-9 (L; 2 PRs)

**PR 2a — triage flow (condition+location+opportunity):** `buildTriagePrompt` (merged stable, one DOMAIN_PREAMBLE, one ASSESSMENT_RULES, deduplicated axis instructions, output = array keyed by echoed `property_id`, N-capable from day one); `lib/ai-assessment/triage.ts`; `getOrComputeMulti` in `cache.ts` (per-property hash, per-axis hit check, one advisory-lock client holding the three per-axis keys sorted); bumps `condition/v3`, `location/v2`, `opportunity/v2`; **F-9 rides here** (add location+opportunity to `ASSESSMENT_SELECTION_FLOWS`); re-point the three per-axis POST routes at triage; `DEFAULT_BATCH_FLOWS` becomes occupancy / triage / redflags / extract.

**Shadow validation (exit gate, before merge):** run triage in compute-only mode over ~100 already-assessed eligible properties and diff per-axis labels against stored verdicts. Acceptance: ≥95% agreement where stored confidence ≥0.6; every disagreement listed in the PR. Cost ≈ under $1 notional.

**PR 2b — occupancy + redflags N-capable prompts + F-2:** rewrite both prompts to the same N-property array shape (still called with N=1 until Phase 3); per-property volatile carries its own D-012 price-signal string; `extraHashInput` stays per-property. **F-2:** move trending/dismissed into the volatile block, still excluded from the content hash (pin with a test). Bumps `occupancy/v3`, `redflags/v9`. Extract untouched. Same shadow-validation gate.

**Backlog economics (report via F-7 before merging):** ~1,918 eligible × 3 flows ≈ 5,750 calls ≈ **$25–35 notional**, drained over ~2–3 days at default scheduler settings. This replaces three or more separate reopenings.

**Tests:** parser unit tests for the array shape (echoed-id validation, duplicate/unknown/missing ids, per-axis degradation isolation, evidence-substring guard, terreno slice); `getOrComputeMulti` hit/miss/park matrix; DB-backed test that triage rows are indistinguishable to `loadFlags`/`getLatestAssessment`; a pin that D-067's `extractFallbackExpr` output is unaffected.

### Phase 3 — Turn on multi-property batching (M; 1 PR; only after the Phase-2 wave has drained)

**Zero prompt text changes, zero version bumps.** `getOrComputeBatch` per D-B; the flow-major loop collects up to `dashboard.assessment_flow_batch_size` (new key, default 4, max 8, `0`/`1` = singles) miss-properties per flow; `maxOutputTokens = min(8192, N*900+512)` for batches. POST routes keep calling the single-property entry points.

**Tests:** lock-ordering test (concurrent POST single vs batch on overlapping properties — no deadlock, no double LLM call); salvage matrix (whole-batch garbage → N singles, no strikes; one bad entry → N−1 saves + 1 single; truncation → fallback, no strikes); budget-stop mid-batch accounting; a live smoke run comparing per-property cost in `llm_usage` before/after.

**Exit criteria:** measured per-property cost drops ≈30–40% vs the Phase-2 baseline for batched flows; zero increase in `parked`/`errors` over a week.
**Do NOT combine with Phase 2 in one PR:** if verdict quality moves, you must know whether the prompt rewrite or the packing did it.

### Phase 4 — Optional / conditional tail (S each)

F-6 on OpenRouter only if Phase 0c warrants; advisory `eligible` field on POST responses; extract pre-pass + reconciler extension (D-E) when a profile first constrains an extract-covered field, plus the profile-editor warning immediately. F-4/F-10/F-11/F-12/F-14 proceed independently. **F-13 landed (issue #543)** — Phase 0c measured a ~71% per-call input-cost cut on a synthetic above-floor block, making it the highest-value single item here and a prerequisite for F-2's rationale, but the re-probe against REAL per-flow prompts (see the "F-13 landed" subsection above) showed zero measured saving today: every flow's stable block is still below the 4,096-token cache floor. It compounds with batching: once the stable prefix is ALSO transmitted once per N properties (D-B) and/or merged across axes (D-A), it crosses that floor and the two savings multiply. Re-run the 0c probe again after D-B or D-A lands.

---

## 4. Decisions to record (allocate IDs with `scripts/next-decision-id.py` at write time)

1. **Triage multi-axis assessment call** — `condition`+`location`+`opportunity` are assessed in ONE LLM call that writes three per-axis `ai_assessment` rows with per-axis prompt versions via the unchanged per-axis parsers/savers; occupancy, redflags and extract remain separate; every reader keys on `assessment_type` and is unchanged.
2. **N-property assessment batching** — prompts are N-property-capable (array in, id-echoing array out); the harness packs ≤ `dashboard.assessment_flow_batch_size` (default 4, max 8) cache-miss properties per flow-call under one-client sorted advisory locks with per-property content hashes; valid entries save individually, invalid/missing fall back to single calls, and the batch path NEVER writes D-104 strikes.
3. **Prompt-version bumps are batched and previewed** — a bump reopens the whole matched pool, so bumps ship in coordinated waves, never piecemeal, and only after the F-7 cost preview has been run and reported.
4. *(when Phase 4 builds it)* **Extract pre-pass for filter-blocked unknowns.**

---

## 5. What NOT to do

- **Don't merge occupancy or redflags into triage** (yet) — they carry the silence-default discipline and the D-012 hashed price signal; highest quality risk, smallest saving.
- **Don't collapse per-axis `ai_assessment` rows** into one combined row or one combined prompt version. Per-axis rows are the compatibility contract that makes this a non-event downstream.
- **Don't use the Anthropic Message Batches API** — unreachable from this setup (CLI/OAuth has no batches endpoint; OpenRouter doesn't front it) and its up-to-24h latency fights the 15-minute tick.
- **Don't hash the batch as one content hash, and don't strike batch-mates.**
- **Don't justify F-1 or F-2 with CLI prompt caching until a stable block crosses the 4,096-token floor** — measured 2026-08-18: with the stable block concatenated into stdin (the pre-F-13 shape) a varying tail got zero prefix reuse, and nothing caches at all below Haiku 4.5's 4,096-token minimum regardless of shape. F-13 (landed) moved the stable block onto `--system-prompt`, where a synthetic above-floor block IS reused (~71% cheaper) — but every REAL per-flow stable prompt today is still below the floor, so F-1/F-2 remain valueless on the CLI path until D-B or D-A pushes a call's stable block past it. Also: never conclude anything from a probe whose prompts are byte-identical, or repeatable across runs. See the Phase 0c result and the "F-13 landed" subsection.
- **Don't push N past ~8, and don't trim `evidence`/`reasoning` to save output tokens** — the evidence discipline is load-bearing across every parser, D-087, D-095 and the degrade guards.
- **Don't hard-gate the on-demand POST routes on profile eligibility** — they are the operator's probe-and-unpark tool.
- **Don't fold trending/dismissed into the redflags content hash** while moving them to volatile.
- **Don't ship any prompt-version bump outside the Phase-2 wave**, and don't land Phase 2 and Phase 3 in the same PR.
- **Don't bother with cache-TTL tuning on the CLI path** — there is no knob, however the Phase 0c caching question resolves (see §3).
