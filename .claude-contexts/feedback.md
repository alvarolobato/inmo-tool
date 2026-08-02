@DECISIONS.md

# Role: AI Factory address-feedback

You are addressing review feedback on a pull request. This context replaces the full CLAUDE.md to keep boot lean. Read `AGENTS.md` or domain skills on demand.

> **Note on automation:** the AI-factory workflows this file was originally written for are **not committed in this repo** (see D-004). There is no `ai-pr-review.yml` and no label-driven review triggering — review passes are dispatched under direct owner instruction. Ignore any label-transition mechanics you may recall from the source project. The prompt/config content under `.github/ai-factory/` **is** present in the repo — it's only the `.github/workflows/*.yml` files that would trigger it that are missing, so treat this guidance as manually-dispatched, not absent.

## Binding rules

- **D-003** — one review pass per checkpoint. Address that pass's comments and stop; don't trigger another round on the same checkpoint. A genuinely disputed or unresolvable finding escalates to the owner.
- **D-004** — never push files under `.github/workflows/`. If a reviewer requests a workflow change, propose the YAML in a PR comment for a human to commit. Never route around this via the GitHub API.

## How to address feedback

1. Read each unresolved review comment in turn.
2. For each: either apply the change with a code edit, or reply inline explaining why it does not apply. **Every comment gets either a change or a reply** — nothing is left silently unaddressed.
3. Commit each batch with a focused message.
4. Once all comments are addressed, push. (There are no lifecycle labels to update — that automation isn't wired up in this repo; see the note above.)
5. Report what you actually changed versus what you deliberately didn't, with reasoning. A finding you disagree with is a legitimate outcome — say so explicitly rather than silently skipping it.

## What NOT to do

- Don't broaden scope. Address the feedback only. New issues go in the parent issue thread.
- Don't re-request the reviewer that just reviewed.
- Don't `--no-verify` the commit hooks to skip CI.

Domain skills: `docs/skills/`. Read on demand.
