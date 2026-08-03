# D-007 — Keep the knowledge-corpus machinery; test the empty state, don't delete it

**Status:** accepted
**Date:** 2026-08-03
**Task:** issue #158

## Decision

`dashboard/lib/knowledge.ts` and `dashboard/scripts/build-knowledge.ts` (the
build machinery driven by `docs/knowledge-sources.yml`, ported from the
archived source project) stay in the codebase even though the corpus they
compile is currently empty. They are **not** dead code:

- `lib/llm-context/system-prompt.ts`'s `buildSchemaContext()` imports
  `SCHEMA`/`RELATIONSHIPS` and uses them for the `chat` flow's system prompt.
- `lib/llm-context/formatters.ts` provides the formatting functions consumed
  above.
- `npm run build:knowledge` (wired into `package.json`'s `prebuild`) is a
  real, documented command.

The emptiness itself is intentional and already handled: `buildSchemaContext()`
degrades to an explicit "discover the schema with `list_tables`/`describe_table`"
instruction rather than emitting a hollow `## PostgreSQL Schema` heading when
`SCHEMA`/`RELATIONSHIPS` are both `[]`. `docs/knowledge-sources.yml` states
this in its header comment: task 1.1 (#9) deleted the PowerShop retail corpus
these files used to hold, and Phase 4 (#5) owns authoring a real-estate
replacement — not before.

`dashboard/lib/__tests__/knowledge.test.ts` and
`dashboard/scripts/__tests__/build-knowledge.test.ts` were rewritten (not
deleted) to test:

1. **A generic shape contract** — invariants any future entry must satisfy
   (non-empty instruction text, `SELECT`/`FROM` in SQL pairs, alias + key
   columns on schema tables, `MANY_TO_ONE` relationship type). These hold
   vacuously today (no entries to check) and start enforcing for real the
   moment Phase 4 adds content, without needing a rewrite at that point.
2. **The build mechanism itself**, via fixture Markdown/JSON fed directly to
   the exported parse/extract/emit functions in `build-knowledge.ts` — proves
   the marker-section parser, JSON-array extractor, SQL-pair extractor, and
   TS emitters (including the backtick/`${}` escaping in `emitSqlPairs`)
   still work, independent of what corpus (if any) currently exists.
3. **One explicit assertion of today's state** — `INSTRUCTIONS`/`SQL_PAIRS`/
   `SCHEMA`/`RELATIONSHIPS` all equal `[]`, and `knowledge-sources.yml`'s
   `sources` list is `[]` — so the intentional current state is visible
   rather than implicit, and a real regression (an entry silently dropped
   from a populated corpus) is still caught.

`build-knowledge.ts`'s pure functions (`parseMarkdownSections`,
`extractJsonArray`, `extractSqlPairs`, `emitInstructions`, `emitSqlPairs`,
`emitSchema`, `emitRelationships`, plus the `Instruction`/`SqlPair`/
`TableSchema`/`Relationship` types) were exported for this purpose. The
script's `main()` call at module scope was changed from unconditional to
guarded (`if (process.argv[1] === fileURLToPath(import.meta.url))`) so
importing these functions in a test does not trigger the disk-writing build
as a module-load side effect. Verified this doesn't change runtime behavior:
`npm run build:knowledge` produces byte-identical output before and after.

## Alternatives rejected

- **Author the real-estate corpus now, as part of this fix.** Out of scope:
  this is Phase 4 (#5) work — property/listing join paths, occupancy/
  condition business rules, SQL-pair examples — none of which exists yet in
  this codebase and shouldn't be invented ad hoc to make a test-fix issue's
  diff bigger.
- **Delete `knowledge.ts`/`build-knowledge.ts` and their call sites.** Rejected
  because the call sites are real and current (`system-prompt.ts`,
  `formatters.ts`), not leftover imports nobody reads. Deleting live,
  correctly-functioning fallback logic to make a test suite quiet would be
  exactly the failure mode issue #158 warns against: "deleting the tests
  while leaving the code is the wrong repair — it hides dead code behind a
  now-quiet suite" (inverted here: it would hide *live* code behind a
  deleted suite).
- **Hardcode a new fixed minimum count/domain content in the tests** (mirroring
  the old `>= 40 instructions` / `ps_ventas` pattern but with real-estate
  numbers). Rejected: there is no real content to assert yet, so any number
  chosen now would be invented, and — per the same failure mode this issue
  exists to fix — would itself go stale and false-fail the instant Phase 4
  adds a different amount of content than guessed here.

## See also

- `docs/knowledge-sources.yml` (manifest header comment)
- `dashboard/lib/llm-context/system-prompt.ts` `buildSchemaContext()`
- Issue #158 (this fix), #9 (task 1.1, corpus deletion), #5 (Phase 4, corpus
  authoring)
