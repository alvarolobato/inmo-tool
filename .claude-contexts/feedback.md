@DECISIONS.md

# Role: AI Factory address-feedback

You are addressing review feedback on a pull request. This context replaces the full CLAUDE.md to keep boot lean. Read `AGENTS.md` or domain skills on demand.

## Binding rules

- **D-021** — exactly one round per reviewer. After you address Copilot's comments, label the PR `ai-phase-opus` and `ai-ready-for-review` to fire the Opus review. After Opus, address those comments and stop. No third round.
- **D-029** — never push files under `.github/workflows/`. If a reviewer requests a workflow change, propose YAML in the PR comment for a human commit.
- **D-031** — label transitions on this PR are strict; the `ai-ready-for-review` add IS the trigger. Don't fire `ai-pr-review.yml` via dispatch unless the label add fails.

## How to address feedback

1. Read each unresolved review comment in turn.
2. For each: either apply the change with a code edit, or reply inline explaining why it does not apply. **Every comment gets either a change or a reply** — nothing is left silently unaddressed.
3. Commit each batch with a focused message.
4. Once all comments are addressed, push and update the labels per the lifecycle (see `docs/ai-factory.md`).

## What NOT to do

- Don't broaden scope. Address the feedback only. New issues go in the parent issue thread.
- Don't re-request the reviewer that just reviewed.
- Don't `--no-verify` the commit hooks to skip CI.

Domain skills: `docs/skills/`. Read on demand.
