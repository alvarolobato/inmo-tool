# Skill: Systematic Debugging

> Adapted from [ChrisWiles/claude-code-showcase](https://github.com/ChrisWiles/claude-code-showcase). Applied to this project's connector/dedup/scoring pipeline and Dashboard App.

**Use when**: Investigating bugs, fixing test failures, troubleshooting unexpected behavior, or debugging the connector/dedup/dashboard pipeline.

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

**Reset for this project.** The playbooks that lived here (4D SQL parsing errors, WrenAI qdrant/deploy failures, PowerShop dashboard widget SQL errors) were tied to systems this repo no longer has (see issue #9). Real playbooks belong here once real failure patterns emerge from the connector/dedup/scoring pipeline and the new Dashboard App — add them as you hit and solve non-obvious failures, per [agent-efficiency.md](agent-efficiency.md), rather than inventing speculative ones now. Likely first candidates once Phase 1 lands: connector rate-limit/circuit-breaker trips (task 1.3, #11), dedup false-positive/false-negative merges (task 2.2, #16).

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
- [ ] Gotcha documented in the relevant skill file (add one under `docs/skills/` if none fits yet)
- [ ] `DECISIONS.md` + `docs/decisions/D-NN-*.md` updated if architectural

## Integration with Other Skills

- **testing-patterns**: Write test that reproduces the bug before fixing
- Check whichever domain skill doc under `docs/skills/` covers the area — the bug may already be documented as a gotcha
- **agent-efficiency**: If the fix required significant investigation, create an issue to improve docs
