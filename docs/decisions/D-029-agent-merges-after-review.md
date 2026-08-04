---
id: D-029
title: The coordinating agent merges its own PRs once an Opus review has passed
date: 2026-08-04
---

# D-029: The coordinating agent merges its own PRs once an Opus review has passed

*Decided: 2026-08-04*

**Context**: [D-002](D-002-humans-approve-merges.md) required a human to review
and merge every PR, and said so with an explicit expiry condition: "until the
owner decides trust is established for a specific category of change." On
2026-08-04 the owner decided, in those terms: *"you merge the PRs, opus review
for PR fable for fases."*

The bottleneck was real and measurable. Work was arriving faster than it could
be merged: three PRs sat open simultaneously (#224, #225, #226) with nothing
wrong with any of them, each blocking review of the next change to the same
files, while the owner's actual scarce attention was being spent on merge
button clicks rather than on the decisions only they can make (which portals to
pursue, whether a data trade-off is acceptable, what to build next).

The review discipline that made D-002 valuable is not being dropped — it is
being moved off the owner's critical path and onto an agent that does it from a
clean context.

**Decision**: The coordinating agent merges a PR once a **fresh-context Opus
review** has returned APPROVE or APPROVE WITH NITS. Phase boundaries get a
**Fable** cross-task review as well, per [D-003](D-003-review-policy.md)'s
existing cadence.

The agent does **not** merge, and escalates to the owner instead, when:

- a review returns CHANGES REQUIRED and the agent disagrees with it — an agent
  overruling its own reviewer is exactly the failure mode this replaces;
- the change is irreversible or outward-facing (a destructive migration, a
  published artifact, anything that leaves the machine);
- the owner has explicitly reserved that decision, which they have done
  repeatedly and specifically (Milanuncios' fate, which REO portals to pursue,
  whether to unblock the chat feature);
- the PR touches `.github/workflows/` — that is blocked by
  [D-004](D-004-no-worker-workflows.md) for a different reason and is
  unaffected by this decision.

**Alternatives rejected**:

- *Keep D-002 as-is.* The owner has explicitly withdrawn it. Continuing to
  block on human merges after being told not to would be substituting the
  agent's risk judgement for the owner's on the owner's own tool.
- *Merge without any review.* The review is what makes this safe. This repo's
  characteristic defect is the silent failure — a check that cannot fail, a
  test that passes by not running, a plausible-looking wrong answer — and those
  are found by a reviewer who re-derives the problem from a clean context, not
  by the author who already believes the code is right. Two such defects
  (PR #220 merging only 3 of its files; the `api-auth-coverage` guard whose
  branch was unsatisfiable) were caught by exactly this mechanism.
- *Self-review in the same context.* Worthless for this defect class. The
  author's context contains the assumptions that produced the bug.

**Rationale**: D-002's condition was met on its own terms. What made it right
was never "a human must click merge" but "something independent must check the
work before it lands" — and a clean-context Opus reviewer satisfies that better
than a human skimming a large diff, because it actually runs the tests, does
the mutation checks, and re-derives the claims. The owner's attention is the
genuinely scarce resource and is better spent on the judgement calls the agent
should not be making at all.

**See**: [D-002](D-002-humans-approve-merges.md) (superseded by this),
[D-003](D-003-review-policy.md) (review cadence, unchanged),
[D-004](D-004-no-worker-workflows.md) (workflow files, unaffected),
AGENTS.md § How work runs in this repo.
