# inmo-tool

An AI-powered real-estate deal-sourcing and scoring platform. It crawls listing sites, deduplicates properties across sources, lets an investor run several independent search profiles (investment theses) over the same data, learns per-profile preferences from feedback, and uses AI to assess things a listing's structured fields won't tell you (occupancy, condition, red flags).

**Status**: early scaffolding. This repo was bootstrapped from [powershop-analytics](https://github.com/alvarolobato/powershop-analytics) (a data-pipeline + AI-dashboard project with a similar shape: external source → Postgres mirror → AI-driven UI) and is being built out phase by phase — see [issue #1](https://github.com/alvarolobato/inmo-tool/issues/1) for the full functional spec and the phase/task issue tree it links to.

## Development

```bash
git clone https://github.com/alvarolobato/inmo-tool.git
cd inmo-tool

# Configure credentials (single file shared across worktrees)
ps setup                 # creates ~/.config/inmo-tool/.env from .env.example + symlinks it in
ps setup check           # verify Docker, .env, Postgres reachability

# Start the local stack
ps stack up
ps stack status

# Try it: run the first connector and inspect what it found
ps connector run fotocasa
ps connector status
ps db tables
```

No production deployment exists yet — this is local-dev only until there's a real target. `docs/decisions/` (index: [DECISIONS.md](DECISIONS.md)) records the binding technical decisions as they're made; `docs/decisions/archive/` holds the source project's decision history for context on where the AI-factory tooling and Docker/CI conventions came from.

## For contributors

- [AGENTS.md](AGENTS.md) — AI development guide (start here)
- [ARCHITECTURE.md](ARCHITECTURE.md) — system shape
- [docs/skills/skills.md](docs/skills/skills.md) — domain-specific guides
- [issue #1](https://github.com/alvarolobato/inmo-tool/issues/1) — the functional spec everything else implements
