---
id: D-150
title: Config-driven capture-HTML retention allowlist, independent of calibration state
date: 2026-08-21
group: Data / connectors
rule: "`etl.retain_capture_html_for` (CSV connector names, default empty) forces `_process_one` to retain `extension_capture.html` for a named connector regardless of `raw_extra.selectors_calibrated` (D-146's existing rule stays additive/unchanged). Off by default; an operator turns it on/off purely via config, no code change."
---

# D-150: Config-driven capture-HTML retention allowlist, independent of calibration state

*Decided: 2026-08-21*

**Context**: Issue #654 (browser-side full-gallery capture for Idealista,
follow-up to #625/D-145) needs a real Idealista **detail**-page HTML sample
to design against — Idealista's per-listing gallery preview is truncated to
3 photos server-side, and the fix (triggering the site's own full-gallery
view before the extension snapshots `outerHTML`) can only be calibrated
against real markup. None exists: `etl/capture.py`'s `_process_one` nulls
`extension_capture.html` once a *calibrated* connector's parse reaches
`done` (D-146), and Idealista is calibrated, so every real capture is
purged immediately after processing.

D-146's mechanism (`raw_extra.selectors_calibrated is False`) exists for
exactly this shape of problem, but it is keyed on calibration state, which
is a property of the connector's own code, not an operator's ad-hoc
diagnostic intent — flipping it for Idealista would mean lying about
Idealista's calibration status (or literally decalibrating it, discarding a
working connector's `_SELECTORS_CALIBRATED = True`) just to get one
throwaway sample.

**Decision**: Add a second, independent, config-driven retention path:
`etl.retain_capture_html_for` (env `ETL_RETAIN_CAPTURE_HTML_FOR`), a
comma-separated list of connector names, default empty (no retention). In
`_process_one`, `retain_html` becomes `True` when *either* D-146's existing
calibration check *or* `connector.name` appears in this list (normalized:
stripped, lowercased, empty entries dropped). `photo_urls`/normal
processing are untouched — this only controls whether the raw HTML column
is kept after a `done` row, purely for the owner to open one Idealista
capture, inspect the gallery-expand control's real DOM, and hand it to
issue #654.

This is a **temporary, reversible, config-only** knob:
- **Enable for Idealista**: in `/admin/config`, "ETL" section, set
  `etl.retain_capture_html_for` = `idealista`, save, then restart the ETL
  container. The captured HTML for the next Idealista capture(s) survives
  processing instead of being nulled.
- **Turn off again**: clear that same value in `/admin/config`, save, and
  restart. New captures resume the pre-existing nulling behaviour
  immediately — nothing to clean up in code, no migration.
- **Do not set `ETL_RETAIN_CAPTURE_HTML_FOR` as an environment variable** —
  see [D-151](D-151-config-yaml-canonical-for-etl-tunables.md). This
  paragraph originally read "set `ETL_RETAIN_CAPTURE_HTML_FOR=idealista` in
  `~/.config/inmo-tool/.env` (or `config.yaml`'s …)", which is wrong twice
  over: the `etl` service's compose `environment:` block is a bootstrap-only
  allowlist that deliberately carries no `etl.*` tunable, so the env var
  never reaches the container; and wiring it in would leave the admin UI —
  which runs in the dashboard container and would not see the var — showing
  a value etl ignores, making the turn-off step above a **silent no-op** for
  a knob whose whole point is being reversible. config.yaml is the only
  route.
- Existing rows already holding retained HTML are **not** auto-purged when
  the flag turns off (no code touches historical rows) — the owner deletes
  them by hand (`UPDATE extension_capture SET html = NULL WHERE ...`) once
  the sample has been extracted, since `html` is large (~358 KB/capture)
  and this repo holds no scraped-listing content in committed files, only
  in a throwaway local/dev DB.

**Alternatives rejected**:
- *Force `raw_extra.selectors_calibrated = False` for Idealista* — rejected:
  conflates "this connector's parser is untrustworthy" (D-146's actual
  meaning, read by other code/tests) with "an operator wants a one-off
  diagnostic sample"; also silently changes behaviour anywhere else that
  reads the calibration flag.
- *One-off manual SQL flip / debug flag hardcoded to `idealista`* —
  rejected: not visible, not reversible via config, and the task explicitly
  asked for something obvious and reversible an operator drives without a
  code change.
- *Retain HTML for every connector unconditionally* — rejected: this is a
  diagnostic tool for one connector under active investigation, not a
  standing policy; the column is large and most connectors are calibrated
  and trusted.

**Rationale**: Keeps D-146's calibration-triggered retention exactly as
before (still the right default for a connector that's never been
calibrated), while giving the owner a narrow, named, temporary lever for
the one connector under live investigation — on by one env var, off by
removing it, with no code change either direction.

**See**: [D-151](D-151-config-yaml-canonical-for-etl-tunables.md) (corrects
this record's operator instructions: config.yaml only, never the env var),
issue #654, issue #625, D-145 (root-cause investigation),
D-146 (Hipoges calibration-triggered retention this is additive to),
D-111 (Hipoges "unvalidated until a real capture" pattern this mirrors),
`etl/capture.py` (`_process_one`), `etl/config.py`
(`retain_capture_html_for`), `config/schema.yaml`
(`etl.retain_capture_html_for`).
