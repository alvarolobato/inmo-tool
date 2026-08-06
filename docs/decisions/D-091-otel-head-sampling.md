---
id: D-091
title: Restore OTel trace sampling as SDK head sampling, not a collector processor
date: 2026-08-06
group: Plumbing / process
rule: Trace sampling is head sampling at the SDK — `OTEL_TRACES_SAMPLER=parentbased_traceidratio` + `OTEL_TRACES_SAMPLER_ARG` (default 0.1) on etl/dashboard — because the pinned elastic-agent:8.16.0 collector can't compile `tail_sampling`. Don't re-add the collector processor without switching to an image that compiles it.
---

# D-091: Restore OTel trace sampling as SDK head sampling

*Decided: 2026-08-06*

**Context**: Task 1.6 (#14, PR #51) removed the `tail_sampling` processor from
`otel/otelcol-config.yaml` because the pinned
`docker.elastic.co/elastic-agent/elastic-agent:8.16.0` OTel collector build does
not compile it in — the container logged `unknown type: tail_sampling` and never
became healthy, and because the processor was referenced inside a pipeline (not
just an extension) it blocked the collector from starting *at all*, which in turn
blocked `etl` and `dashboard` (both `depends_on: otel-collector: service_healthy`).
That unblocked the stack but left every trace exported unsampled
(`OTEL_TRACES_SAMPLER=parentbased_always_on`). Issue #52 tracked restoring
sampling once a compatible approach was chosen.

**Decision**: Restore sampling at the SDK level via head sampling rather than
swapping the collector image. The `etl` and `dashboard` services set
`OTEL_TRACES_SAMPLER=parentbased_traceidratio` and
`OTEL_TRACES_SAMPLER_ARG=0.1` (both overridable via env; default 10%). The
collector config keeps no sampling processor. `parentbased_traceidratio` is a
deterministic, trace-ID-based decision, so a whole trace is kept or dropped
together and child spans honor the root's decision. Local dev can keep every
trace with `OTEL_TRACES_SAMPLER_ARG=1.0` or `OTEL_TRACES_SAMPLER=parentbased_always_on`.

**Alternatives rejected**:
- *Swap to an OTel distribution that compiles `tail_sampling`* (e.g.
  `otel/opentelemetry-collector-contrib`): higher risk. It would change the
  exporter/processor set the current Elastic-tuned config relies on
  (`otlphttp/elasticsearch`, `elastictrace`, the Elastic file exporter defaults)
  and re-validate a whole new image against the stack — disproportionate for a
  Phase 1 local-dev/file-sink deployment with no cost pressure. Left as a future
  option if the smarter "keep 100% of errors / >5s traces" policy becomes needed.
- *Leave `parentbased_always_on`*: exports every trace with no volume control;
  the regression #52 exists to fix.
- *`elastictrace` processor*: it's an APM span-enrichment processor, not a
  sampler — not a substitute.

**Rationale**: Lowest-risk change that actually works with the *current* pinned
images — no image change, so the collector's verified-healthy startup is
untouched (the whole caution behind #52 was a config that broke startup). It
restores configurable trace-volume control with a sensible 10% default and a
clear env knob. The only capability not restored is tail sampling's ability to
preferentially keep error/slow traces, since head sampling decides before a
trace's outcome/duration is known — acceptable for Phase 1, documented for the
production revisit.

**See**: `otel/otelcol-config.yaml` (processors + traces pipeline comments),
`docker-compose.yml` (etl/dashboard `OTEL_TRACES_SAMPLER*` env), `.env.example`,
issue #52, #14, PR #51.
