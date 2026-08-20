---
id: D-127
title: Tri-state alerts filter — "sin alertas" excludes unassessed candidates
date: 2026-08-20
group: Product / candidate feed
rule: "The alerts filter's negative (\"sin alertas\") is the SAME UNION predicate as the positive, compared via equality against a tri-state param (never a second predicate); a candidate with no ai_assessment rows is EXCLUDED from BOTH values, consistent with D-059."
---

# D-127: Tri-state alerts filter — "sin alertas" excludes unassessed candidates

*Decided: 2026-08-20*

**Context**: #466 shipped a one-way "Con alertas" toggle (`alerts=1` — keep
only candidates with ≥1 red flag OR ≥1 warn-tone occupancy caveat). The owner
asked for a third state: "no filtra, con alertas, sin alertas" (#593) — he can
currently ask for only flagged candidates but never for only clean ones, the
more useful half when working through unproblematic stock.

The negative case has a real ambiguity `lib/candidates.ts` already documents
per-axis for every other assessment filter (D-059): a property with no
`ai_assessment` rows at all has no alert AND no evidence of being clean.
Should "sin alertas" include it?

**Decision**: No. `hasAlerts: false` ("sin alertas") is implemented as the
literal negation of the SAME bracketed UNION expression the positive value
reads — never a second, independently-written predicate (mirrors the `isVpo`
equality form exactly). **Both axes must survive an unassessed row as SQL
NULL for that exclusion to actually hold on both sides of the filter**:

```sql
(
  (CASE WHEN ranked.redflag_types IS NULL THEN NULL
        ELSE cardinality(ranked.redflag_types) > 0 END)
  OR ranked.caveats && $6::text[]
) = $24::boolean
```

- **TRUE** ("con alertas") whenever either ASSESSED axis has qualifying
  evidence.
- **FALSE** ("sin alertas") only once BOTH axes were actually assessed and
  neither found anything.
- **NULL** (excluded from BOTH `true` and `false`) whenever EITHER axis was
  never assessed and the other found no evidence — SQL's three-valued logic
  does this automatically via `NULL = $24::boolean -> NULL`, with no
  special-cased branch needed.

A never-(fully-)assessed property is therefore excluded from both partitions,
exactly as every other D-059 hard filter treats an unassessed axis: "unknown,
never a false pass." The UI label says so — "Sin alertas (evaluadas)" on the
active chip, and a tooltip on the segmented control ("Propiedades evaluadas
sin alertas — no incluye las que aún no se han evaluado") — so the state
never reads as a "verified clean" guarantee it doesn't have.

**Incident (PR #597 review, B1)**: the first cut of this predicate reused
`cardinality(COALESCE(ranked.redflag_types, '{}')) > 0` — `COALESCE`d, so a
never-assessed redflags axis silently read as "0 flags" (an assessed,
factual zero) rather than NULL (unknown). `caveats` was never `COALESCE`d, so
only THAT axis got the D-059 exclusion; a property whose occupancy axis was
checked-clean but whose redflags axis had never run was served under "sin
alertas" while its label claimed otherwise. Verified live: 6 of 1576 rows
under `hasAlerts=false` on the demo DB had no redflags assessment. Fixed by
dropping the `COALESCE` and gating the redflags side on an explicit `CASE ...
IS NULL THEN NULL` instead — the two axes are now symmetric. The integration
fixture (`lib/__tests__/candidates.integration.test.ts`) now seeds both
mixed shapes (occupancy-assessed/redflags-never, and its mirror) so this
asymmetry cannot regress silently again.

**Alternatives rejected**:
- *Treat "sin alertas" as the literal complement over ALL candidates*
  (including never-assessed ones, since they trivially have "0 red flags").
  Rejected: it would let a totally unassessed property masquerade as
  confirmed-clean, and it would break the derive-from-one-predicate
  requirement — the equality trick that makes the negative provably the same
  rule as the positive stops working once "unassessed" needs a special-cased
  branch to fold into the negative bucket.
- *A second, hand-written "IS clean" predicate.* Rejected outright — this is
  exactly the two-definitions-of-one-state-machine class of bug #590's
  freshness fix taught the project to avoid (`getConnectorFreshness()`
  vs. `listConnectors()` disagreeing because they shared a state machine but
  not its inputs).

**Rationale**: One expression, one truth table, both filter values read off
it — there is no way for "con alertas" and "sin alertas" to drift apart post
this change, by construction. Consistency with D-059's existing unassessed
handling means an agent extending any other hard filter doesn't need to
re-derive the "what about unassessed?" answer from scratch.

**See**: `dashboard/lib/candidates.ts` (`hasAlerts` param + the `$24`
predicate comment carries the full truth table), `dashboard/lib/
candidate-filters.ts` (`alerts: "" | "1" | "0"`), `dashboard/components/
candidates/CandidateFilterBar.tsx` (segmented control + chip label),
`dashboard/lib/__tests__/candidates.integration.test.ts` ("hasAlerts:false
('sin alertas') is the true complement..." — the DB-backed test asserting
the two partitions sum to the unfiltered assessed total), issue #593,
[D-059](D-059-distress-condition-below-market-filters.md).
