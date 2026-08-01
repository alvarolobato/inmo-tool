# Agent-efficiency skill

**Lightweight.** Apply only when it clearly fits.

## Purpose

Improve future sessions by recording when **lack of a skill or guidance in AGENTS.md** made the agent work harder than necessary. Not every session should produce an issue -- only when there is an **obvious need** and the agent had to **do considerable figuring out** to complete the task.

## When to create an issue

- During or at the end of a session, note where you struggled (e.g. unclear docs, no skill for a domain, scattered info).
- If the gap is clear and fixing it would help future agents (e.g. a new skill or an AGENTS.md section), **create one GitHub issue** with label **`agent-efficiency`** describing the improvement.

**Do not** create an issue every session. **Do** create one when:
- The task touched a domain that has no skill or no clear guidance.
- You had to search the codebase, guess, or infer a lot to do something that a short skill or AGENTS.md update could have made straightforward.

## Issue format

- **Title:** Short improvement (e.g. "Skill: SOAP parameter mapping" or "AGENTS.md: document stock table structure").
- **Body:** What was missing, what you had to figure out, and what to add (new skill in `docs/skills/`, new section in AGENTS.md, or link to existing doc). Keep it concise.
- **Label:** `agent-efficiency`

```bash
gh issue create --title "Skill: ..." --body "..." --label "agent-efficiency"
```

## Self-learning and documentation (do this)

When you solve a non-obvious problem or discover a gotcha:

1. **Capture the problem** briefly (what failed, error or behavior).
2. **Document the solution** in the right place:
   - Data access, SQL, SOAP -> the relevant skill in `docs/skills/`
   - AI workflow, rules, skills -> AGENTS.md or the relevant skill
   - User-facing setup -> README.md
3. **Update cross-references** so the next agent or maintainer can find it.

Apply this every time you fix something non-obvious -- do not skip. It keeps the codebase and docs from drifting.
