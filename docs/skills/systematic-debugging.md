# Skill: Systematic Debugging

> Adapted from [ChrisWiles/claude-code-showcase](https://github.com/ChrisWiles/claude-code-showcase). Applied to this project's specific debugging challenges (4D SQL, ETL pipeline, WrenAI, Dashboard App).

**Use when**: Investigating bugs, fixing test failures, troubleshooting unexpected behavior, or debugging the ETL/WrenAI/Dashboard pipeline.

## Core Principle

**NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.**

Never apply symptom-focused patches that mask underlying problems. Understand WHY something fails before attempting to fix it.

## The Four-Phase Framework

### Phase 1: Root Cause Investigation

Before touching any code:

1. **Read error messages thoroughly** — Every word matters
2. **Reproduce the issue consistently** — If you can't reproduce it, you can't verify a fix
3. **Examine recent changes** — What changed before this started failing?
4. **Gather diagnostic evidence** — Logs, stack traces, state dumps
5. **Trace data flow** — Follow the call chain to find where bad values originate

**Root Cause Tracing Technique:**
```
1. Observe the symptom - Where does the error manifest?
2. Find immediate cause - Which code directly produces the error?
3. Ask "What called this?" - Map the call chain upward
4. Keep tracing up - Follow invalid data backward through the stack
5. Find original trigger - Where did the problem actually start?
```

**Key principle:** Never fix problems solely where errors appear — always trace to the original trigger.

### Phase 2: Pattern Analysis

1. **Locate working examples** — Find similar code that works correctly
2. **Compare implementations completely** — Don't just skim
3. **Identify differences** — What's different between working and broken?
4. **Understand dependencies** — What does this code depend on?

### Phase 3: Hypothesis and Testing

Apply the scientific method:

1. **Formulate ONE clear hypothesis** — "The error occurs because X"
2. **Design minimal test** — Change ONE variable at a time
3. **Predict the outcome** — What should happen if hypothesis is correct?
4. **Run the test** — Execute and observe
5. **Verify results** — Did it behave as predicted?
6. **Iterate or proceed** — Refine hypothesis if wrong, implement if right

### Phase 4: Implementation

1. **Create failing test case** — Captures the bug behavior
2. **Implement single fix** — Address root cause, not symptoms
3. **Verify test passes** — Confirms fix works
4. **Run full test suite** — Ensure no regressions
5. **If fix fails, STOP** — Re-evaluate hypothesis

**Critical rule:** If THREE or more fixes fail consecutively, STOP. This signals architectural problems requiring discussion, not more patches.

---

## Project-Specific Debugging Playbooks

### ETL Sync Failures

```
Symptom: "FAILED duration_ms=X: <error>"
│
├── "Failed to parse statement"
│   → 4D SQL syntax issue
│   → Check: Does 4D use <> instead of !=?
│   → Check: Column name case-sensitive? (use original 4D casing)
│   → Check: Does column exist? Run: ps sql query "SELECT COLUMN_NAME FROM _USER_COLUMNS WHERE TABLE_NAME='X'"
│
├── "Failed to execute statement"
│   → Column doesn't exist or type incompatible
│   → Check: Run the exact SELECT with LIMIT 1 in the CLI
│   → Check: Is there a type-0 column? Filter via get_queryable_columns()
│
├── "UniqueViolation: duplicate key"
│   → NUMERIC precision issue (PKs rounded)
│   → Check: Is the column NUMERIC(20,3)? Was it (20,2)?
│   → Check: Are n_albaran/n_factura actually unique? (They're NOT)
│
├── "cannot truncate a table referenced in a foreign key constraint"
│   → FK blocks TRUNCATE
│   → Fix: Use TRUNCATE ... CASCADE
│
└── OOM / container killed
    → Table too large for single fetch (>2M rows)
    → Fix: Progressive sync by partition key (e.g., by store for Exportaciones)
```

### WrenAI Query Failures

```
Symptom: Question returns "no database schema available"
│
├── Check qdrant Document collection: are points > 0?
│   → If 0: recreate_index may have wiped it. Set recreate_index: false.
│   → Re-deploy: mutation { deploy(force: true) }
│
├── Check AI service is running (not in restart loop)
│   → docker compose logs wren-ai-service | grep -v "no port"
│   → If "Timeout: wren-ui did not start": SHOULD_FORCE_DEPLOY is set. Remove it.
│
└── Check MDL hash matches between wren-ui and AI service

Symptom: "Request timed out: 30 seconds"
│
└── LLM call too slow (27 tables in context)
    → Increase engine_timeout in wren-config.yaml (120s recommended)

Symptom: "AuthenticationError: No cookie auth credentials found"
│
└── OPENROUTER_API_KEY not passed to container
    → Check: docker compose exec -T wren-ai-service env | grep OPENROUTER
    → Fix: Add OPENROUTER_API_KEY to wren-ai-service environment in docker-compose.yml

Symptom: "No field named lv.entrada"
│
└── LLM referenced a column on the wrong table
    → entrada is on ps_ventas, NOT ps_lineas_ventas
    → Fix: Add/improve instruction listing exact columns per table
```

### Dashboard App Failures

```
Symptom: LLM returns text instead of JSON spec
│
└── Prompt doesn't constrain output format strongly enough
    → Fix: Improve system prompt with explicit JSON format requirement
    → Add: "ALWAYS return valid JSON. NEVER return explanatory text."

Symptom: Widget shows error badge
│
├── Check the widget's SQL in browser DevTools (Network tab)
├── Run the SQL manually: docker compose exec -T postgres psql -U postgres -d powershop -c "..."
│   → If syntax error: LLM generated bad SQL. Add SQL pair as example.
│   → If no data: date range issue (fecha_creacion filtering)
│   → If column not found: LLM used wrong column name. Add instruction.
│
└── Check /api/query response for error details

Symptom: Dashboard generation timeout
│
└── OpenRouter LLM call took too long
    → Check: Is the prompt too large? (context window limit)
    → Fix: Reduce SQL pairs in context (sample, don't include all 52)
```

---

## Red Flags — Process Violations

Stop immediately if you catch yourself thinking:

- "Quick fix for now, investigate later"
- "One more fix attempt" (after multiple failures)
- "This should work" (without understanding why)
- "Let me just try..." (without hypothesis)

## Warning Signs of Deeper Problems

**Consecutive fixes revealing new problems in different areas** indicates architectural issues:

- Stop patching
- Document what you've found
- Record a binding rule in `DECISIONS.md` + a `docs/decisions/D-NN-<slug>.md` file with the finding
- Create a GitHub issue with label `agent-efficiency`
- Consider if the design needs rethinking

## Debugging Checklist

Before claiming a bug is fixed:

- [ ] Root cause identified and documented
- [ ] Hypothesis formed and tested
- [ ] Fix addresses root cause, not symptoms
- [ ] Failing test created that reproduces bug
- [ ] Test now passes with fix
- [ ] Full test suite passes
- [ ] No "quick fix" rationalization used
- [ ] Fix is minimal and focused
- [ ] Gotcha documented in relevant skill file (data-access.md, dashboard-app.md)
- [ ] `DECISIONS.md` + `docs/decisions/D-NN-*.md` updated if architectural

## Integration with Other Skills

- **testing-patterns**: Write test that reproduces the bug before fixing
- **data-access**: Check gotchas list — the bug may already be documented
- **agent-efficiency**: If the fix required significant investigation, create an issue to improve docs
