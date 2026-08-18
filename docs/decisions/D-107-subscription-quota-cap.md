---
id: D-107
title: The LLM cap is percentage-of-subscription-quota, fed by a host-side poller
date: 2026-08-18
group: AI layer
rule: `dashboard.llm_quota_stop_pct` (0 = off) stops LLM calls when the account's consumption reaches N% of ANY window the CLI reports (session or weekly), read for free from `claude -p "/usage"` by a HOST-side poller (`scripts/claude-quota-poller.sh` → `POST /api/etl/llm-quota`) because only credential-file auth can see it. An absent or stale reading is UNKNOWN: it never blocks and never counts as 0%.
---

# D-107: The LLM cap is percentage-of-subscription-quota

*Decided: 2026-08-18*

**Context**: [D-102](D-102-llm-usage-metered-and-capped.md) made the daily budget apply to every provider, but on a Max subscription that budget is denominated in a number that does not exist: the CLI's `total_cost_usd` is a **notional list price**, not money billed. Asked how to cap spend, the owner put it exactly right — "there is no real money, just usage" — and asked to stop at 80% of the session or weekly limit.

My first answer was that this could not be built: I had checked for a `usage` subcommand and for quota fields in the response envelope, found neither, and proposed a token-allowance proxy the owner would have to calibrate by hand. **That was wrong**, and the owner pushed back. `claude -p "/usage" --output-format json` returns the real numbers:

```
Current session: 11% used · resets Aug 18 at 4:59am (Europe/Madrid)
Current week (all models): 12% used · resets Aug 21 at 12pm (Europe/Madrid)
Current week (Fable): 8% used · resets Aug 21 at 12pm (Europe/Madrid)
```

Measured: `total_cost_usd: 0`, zero input/output tokens, `num_turns: 0`, ~2.6 s. It is a metadata command, not a model call — **polling it does not consume the quota it reports**.

Two constraints found while verifying, both of which shape the design:

- **Our own flags break it.** `--disable-slash-commands` (D-103) makes it answer *"/usage isn't available in this environment."* The probe must be its own invocation without the lean flags — safe, since it sends no untrusted content and generates nothing.
- **Only credential-file auth sees it.** Isolated by running the host's newer CLI with the container's `CLAUDE_CODE_OAUTH_TOKEN`: it returns a local session-cost summary, not the quota view. It is the auth mode, not the CLI version. **The dashboard container therefore cannot read the quota at all.**

**Decision**:

- `dashboard.llm_quota_stop_pct` (default **0** = off) is compared against the **highest** window the CLI reports, not just the weekly one — the session window is what bites first during a burst, and a cap that ignored it would let one through. Blocking is inclusive (`>=`), enforced at the same two seams as the kill switch (D-105) so it cannot be bypassed.
- The reading is produced **host-side** by `scripts/claude-quota-poller.sh` and pushed to `POST /api/etl/llm-quota`, mirroring the launchd credential sync ([D-025](archive/D-025-oauth-single-refresher.md)) — the same "only the host has these credentials" shape. The poller detects the container-auth output explicitly and says so, rather than posting something the API will reject.
- Stored in `llm_quota_reading` (one row per reading, newest wins) because it originates outside the dashboard process, must survive a restart, and `/etl/salud` will want the history.
- **Unknown is neither blocked nor zero.** A missing reading, or one older than `dashboard.llm_quota_max_age_seconds` (default 1800), allows the call — a dead poller must not take the product down — but is reported as `reason: "unknown"` so a UI can say "cap not enforced: no recent reading" instead of implying it is active. Silently treating unknown as 0% would let it spend freely while blind; silently blocking would make a poller outage look like an outage of the product.
- Any error reading the snapshot **fails open**, for the same reason.

**Alternatives rejected**:

- *A dollar cap on `total_cost_usd`.* Halts real work on imaginary spend under a subscription.
- *A token-allowance proxy the owner calibrates.* What I proposed before testing the slash command. Strictly worse now: it needs manual calibration, drifts, and measures only the dashboard's own consumption rather than the account's.
- *Reverse-engineering the HTTP endpoint behind `/usage`.* Undocumented, and it would break silently. The CLI is the supported interface.
- *Having the dashboard container run the probe itself.* Verified impossible under its current auth. Mounting the credentials file in would remove the host component but touches D-025's single-refresher rule; left as a follow-up rather than done casually.

**Rationale**: The owner asked for a cap in the only unit that means anything on their plan. It turned out to be readable, for free, and the honest cost of that is one host-side component we already have a precedent for.

**Caveat worth keeping in view**: the reading is **per account**, so it includes the owner's own Claude Code sessions, not just the dashboard's. For a cap whose job is to stop the dashboard eating a shared quota, that is the correct denominator — but it does mean a heavy day of interactive work can pause the dashboard.

**See**: `dashboard/lib/llm-quota.ts`, `dashboard/lib/db/llm-quota.ts`, `dashboard/lib/llm-enabled.ts` (`assertQuotaAvailable`), `dashboard/app/api/etl/llm-quota/route.ts`, `scripts/claude-quota-poller.sh`, `etl/schema/init.sql` (`llm_quota_reading`), [D-102](D-102-llm-usage-metered-and-capped.md), [D-105](D-105-llm-master-kill-switch.md).
