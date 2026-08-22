"""The connector contract every listing-site connector implements.

See docs/architecture/connectors.md and issue #1 §4. A connector's job is
`discover` (cheap: which external_ids exist for a scope), `fetch_detail`
(expensive: full page fetch for one external_id), and `normalize` (pure:
site-specific fields -> the canonical shape the orchestrator persists).

Task 1.4 implements the first real connector against this contract. This
module intentionally has zero network code and zero real-site knowledge.
"""

from __future__ import annotations

import logging
import re
import string
from abc import ABC, abstractmethod
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any, Literal

logger = logging.getLogger(__name__)

_VALID_OPERATIONS = ("sale", "rent")

# A Spanish "referencia catastral" is exactly 20 alphanumeric characters.
# Gating on the real format matters more here than for any other field:
# issue #140 dropped the UNIQUE constraint on property.cadastral_ref (it
# made the signal structurally unreachable), and with it went the accident
# that used to make mass-collision impossible. A portal publishing a
# placeholder — "N/A", "-", "00000000000000000000", the same dummy string
# on every listing — would now merge unrelated properties at confidence
# 1.000, the one confidence level that bypasses every corroboration rule
# the other signals have. Cheapest place to stop that is before the value
# is ever stored.
_CADASTRAL_REF_RE = re.compile(r"^[0-9A-Z]{20}$")

# Length alone is not enough, and the test for this found it out: a portal
# padding the field with `00000000000000000000` produces twenty
# alphanumeric characters and sails through the pattern above. Requiring
# both a digit and a letter is the cheapest rule that separates real
# references from degenerate padding, and it cannot reject a genuine one:
# every referencia catastral ends in two control characters that are
# letters, and every one carries digits in the parcel/municipality portion
# — for urban and rústica formats alike. A structural position-by-position
# parse would catch more, but risks rejecting valid input, and a wrongly
# rejected reference silently disables signal 1 for that portal, which
# looks exactly like "no duplicates found" and so goes unnoticed.
_HAS_DIGIT_RE = re.compile(r"[0-9]")
_HAS_LETTER_RE = re.compile(r"[A-Z]")


def normalize_cadastral_ref(value: str | None) -> str | None:
    """Upper-case and strip a cadastral reference, or return None if implausible.

    Rejects to None rather than raising, deliberately: an unparseable
    reference is missing enrichment, not a broken listing, and failing the
    whole ingest over it would lose real data to protect an optional field.
    Contrast `operation`, which raises — a wrong sale/rent value is worse
    than no value, because it silently misclassifies the listing.
    """
    if value is None:
        return None
    normalized = re.sub(r"\s+", "", value).upper()
    if not normalized:
        return None
    if (
        not _CADASTRAL_REF_RE.match(normalized)
        or not _HAS_DIGIT_RE.search(normalized)
        or not _HAS_LETTER_RE.search(normalized)
    ):
        logger.warning(
            "Discarding implausible cadastral_ref %r (expected 20 alphanumeric "
            "chars with at least one digit and one letter); it would otherwise "
            "merge unrelated properties at confidence 1.000",
            value,
        )
        return None
    return normalized


# Passed to discover()/fetch_detail() so a connector that makes more than one
# real network request per call (e.g. paginating inside discover()) can
# throttle each individual request, not just the one acquire() the
# orchestrator does around the whole call. Calling this blocks until the
# framework's rate limiter says it's safe to make one more request.
Throttle = Callable[[], None]


@dataclass(frozen=True)
class SearchParam:
    """One resolved parameter a connector's discover() actually uses for a scope
    — for the "Validar filtros" page (issue #478/#491).

    A `SearchPreview.url` is a single opaque string; this is its decomposition
    into the individual, human-labelled inputs that produced it (geography,
    operation, room count, …) plus WHERE each one came from and WHETHER it
    travels in the URL at all. The page renders one chip per param with a
    source badge, so the owner can see exactly what the ETL sends — including
    the honest truth that a profile's price/size/type filters are NOT sent to
    the connector (they are applied downstream by data), which surfaces here as
    params that simply don't exist (or, for a filter a connector *does* honour,
    `in_url=True`).

    Anti-drift contract (same as `SearchPreview.url`): a connector must build
    these from the SAME resolved values / helpers its `discover()` uses — never
    a hand-written parallel description that can silently disagree with what the
    connector really does.

    - `source`: `"profile"` (from the search_profile scope, e.g. geography),
      `"connector_config"` (an operator-set native filter, e.g. rooms),
      `"constant"` (baked into the connector, e.g. operation=venta), or
      `"derived"` (computed from other inputs).
    - `in_url`: True when the value appears in the search URL (so the URL
      grammar can round-trip it); False for a param the connector uses but does
      not encode in the URL.
    - `consumed`: True (default) when the connector's discover() actually APPLIES
      this param. False for a param that is present/inferrable in the URL but
      that discover() does NOT yet act on — e.g. Unicaja's native `precioMax` /
      `numDormitorios` query fields (issue #494), or a Solvia `municipio` an
      owner pins that the sweep does not yet restrict to (issue #495). The UI
      dims a non-consumed chip and explains it, so the page never advertises a
      filter the ETL silently ignores (the BuildingCenter lesson: "no
      server-side filter parameter this connector tried had any effect").
    """

    key: str
    label: str
    value: str | None
    source: Literal["profile", "connector_config", "constant", "derived"]
    in_url: bool
    notes: str | None = None
    consumed: bool = True


def _ecma_pattern_to_python(pattern: str) -> str:
    r"""Rewrite an ECMAScript-canonical regex so Python's `re` accepts it AND so
    it matches the SAME strings the browser's `RegExp` would.

    Grammars are stored in ECMAScript form (so the browser's `RegExp` consumes
    them verbatim — the whole point of publishing the grammar, issue #491), and
    this translates the three constructs that are spelled or behave differently
    on the Python side:

    1. **Named groups** — JS `(?<name>...)` → Python `(?P<name>...)`. Only a
       named-group open (`(?<` followed by a name char) is rewritten; a
       lookbehind (`(?<=` / `(?<!`) is left untouched (and `validate_grammar`
       rejects it anyway).
    2. **Named backreferences** — JS `\k<name>` → Python `(?P=name)` (issue
       #492: Milanuncios' repeated-slug grammar needs `…-\k<geography>` to force
       the two slug halves equal). Both engines support the construct; only the
       spelling differs.
    3. **End anchor** — a lone trailing `$` → `\Z`. Without the `m` flag JS `$`
       matches ONLY the true end of input, whereas Python `$` ALSO matches just
       before a final `\n`. For a URL grammar that difference is a real
       divergence (a pasted URL with a trailing newline would parse in Python
       but not the browser), so the Python anchor is tightened to `\Z`, which is
       exactly "true end of input". `validate_grammar` guarantees there is a
       single trailing `$` and nothing else to translate here.
    """
    pattern = re.sub(r"\(\?<(?=[A-Za-z_])", "(?P<", pattern)
    pattern = re.sub(r"\\k<([A-Za-z_][A-Za-z0-9_]*)>", r"(?P=\1)", pattern)
    if pattern.endswith("$") and not pattern.endswith(r"\$"):
        pattern = pattern[:-1] + r"\Z"
    return pattern


@dataclass(frozen=True)
class SearchUrlGrammar:
    """A declarative, invertible description of a connector's search URL —
    issue #491.

    Two halves that round-trip:
    - `build_template`: a `str.format` template with `{placeholder}` slots, e.g.
      `https://www.pisos.com/venta/pisos-{geography}/`. `build(params)` fills it.
    - `parse_pattern`: an anchored, ECMAScript-canonical regex whose NAMED GROUPS
      are exactly the template placeholders, e.g.
      `^https?://(?:www\\.)?pisos\\.com/venta/pisos-(?<geography>[^/]+)/?$`.
      `parse(url)` returns the named groups, or None when the URL doesn't match.

    Published verbatim to `connector_registry.search_url_grammar` by
    `sync_connector_registry`, so the dashboard infers params from an
    owner-edited URL IN THE BROWSER using the same grammar — one implementation,
    zero per-connector TypeScript. `parse_pattern` is stored in ECMAScript form
    so the browser's `RegExp` uses it directly; the Python side translates it
    with `_ecma_pattern_to_python`.

    `params` carries per-placeholder metadata (label, source) mirroring the
    `SearchParam` fields, so the UI can label the inferred groups without a
    second source of truth.

    `reject_reasons` (issue #493) makes a URL the connector's OWN portal serves
    but that `discover()` could never open — a robots.txt-forbidden shape — a
    HARD, reasoned block rather than a silent no-match. Each entry is
    `{"pattern": <ECMAScript regex fragment>, "reason": <message key>}`; the
    first whose `pattern` matches `url` is that URL's rejection (see
    `rejection()`). Unlike `parse_pattern` a reject pattern matches a forbidden
    FRAGMENT (e.g. `…?minPrice=` — any query string), so it is start-anchored
    (`^`, portal-scoped) but must NOT use the end anchor `$`. The dashboard reads
    the same list (one implementation, no per-connector TypeScript) to explain
    WHY a pasted URL is unusable and to block saving it — distinct from a plain
    unparseable URL, which is kept verbatim.
    """

    build_template: str
    parse_pattern: str
    params: dict[str, dict] = field(default_factory=dict)
    reject_reasons: tuple[dict[str, str], ...] = ()

    def placeholders(self) -> set[str]:
        """The `{name}` slots in `build_template`."""
        return {
            field_name
            for _, field_name, _, _ in string.Formatter().parse(self.build_template)
            if field_name
        }

    def group_names(self) -> set[str]:
        """The named capture groups in `parse_pattern`."""
        return set(re.compile(_ecma_pattern_to_python(self.parse_pattern)).groupindex)

    def build(self, params: Mapping[str, str]) -> str:
        """Fill `build_template` from `params` (extra keys are ignored)."""
        return self.build_template.format(**params)

    def parse(self, url: str) -> dict[str, str] | None:
        """Return the named groups `parse_pattern` extracts from `url`, or None
        when it doesn't match (an owner-edited URL the grammar can't invert)."""
        compiled = re.compile(_ecma_pattern_to_python(self.parse_pattern))
        match = compiled.match(url)
        if match is None:
            return None
        return dict(match.groupdict())

    def rejection(self, url: str) -> str | None:
        """Return the reject-reason KEY of the first `reject_reasons` pattern
        that matches `url`, or None (issue #493).

        A rejected URL is one this portal serves but `discover()` could never
        open (a robots.txt-forbidden shape) — the caller must BLOCK saving it
        with the reason, distinct from a plain no-match (`parse` returns None →
        kept verbatim). Rejection takes precedence over `parse`: a URL that both
        parses and is rejected is still rejected (e.g. a bare-geography slug
        parses to a geography group yet is robots-disallowed)."""
        for entry in self.reject_reasons:
            pattern = _ecma_pattern_to_python(entry["pattern"])
            if re.compile(pattern).search(url):
                return entry["reason"]
        return None


def _assert_ecma_portable(name: str, pattern: str, what: str) -> None:
    r"""Shared-subset portability checks common to `parse_pattern` and every
    reject-reason pattern (issues #492/#493): no inline flags, no lookbehind, no
    shorthand classes (`\d \w \s` and negations), no Python-only group spellings.
    Each of these would make the SAME stored pattern accept different URLs — or
    fail to compile — in the browser's `RegExp`. `what` names the offending
    pattern in the error so a reject pattern's failure is distinguishable from
    the parse pattern's."""
    if re.search(r"\(\?[aiLmsux]", pattern):
        raise ValueError(
            f"{name}: grammar {what} uses inline flags — not ECMAScript-safe"
        )
    if "(?<=" in pattern or "(?<!" in pattern:
        raise ValueError(
            f"{name}: grammar {what} uses lookbehind — outside the "
            "shared regex subset (issue #491)"
        )
    shorthand = re.search(r"\\[dDwWsS]", pattern)
    if shorthand:
        raise ValueError(
            f"{name}: grammar {what} uses the shorthand class "
            f"{shorthand.group(0)!r} — it means different things in Python "
            "(Unicode) and JS RegExp (ASCII); use an explicit char class "
            "([0-9], [^/], …) from the shared subset (issue #492)"
        )
    if "(?P<" in pattern or "(?P=" in pattern:
        raise ValueError(
            f"{name}: grammar {what} uses a Python-only group spelling "
            "((?P<…>/(?P=…)) — store it in ECMAScript form ((?<name>…) / "
            "\\k<name>); the Python side translates it (issue #492)"
        )


def validate_grammar(connector: type[Connector] | Connector) -> None:
    r"""Assert a connector's `search_url_grammar` is a safe, self-consistent,
    ECMAScript-compatible grammar (issue #491). No-op when the connector has no
    grammar. Raises ValueError with a specific reason otherwise.

    Checks:
    1. No inline flags (`(?i)`, `(?m):`, …) — ECMAScript has none, so the same
       pattern must not rely on them (parity with the browser would break).
    2. No lookbehind (`(?<=` / `(?<!`) — kept out of the shared subset (the
       issue's "sin lookbehind variable"), and never needed for a URL grammar.
    3. No shorthand classes `\d \w \s` (and negations) — issue #492: these mean
       DIFFERENT things in Python (Unicode by default) and JS `RegExp` (ASCII),
       so the same pattern would accept different URLs on the two sides. The
       shared subset uses explicit classes (`[0-9]`, `[^/]`, …), which are
       identical everywhere. Fail fast rather than diverge silently.
    4. No Python-only group spellings (`(?P<…>` / `(?P=…)`) in the stored
       ECMAScript source — a hand-written Python named group/backreference would
       compile here but be a syntax error in the browser's `RegExp`. The
       canonical spellings are `(?<name>…)` and `\k<name>` (issue #492).
    5. Fully anchored with a single trailing `$` — the parse must bind the whole
       URL, and the `$`→`\Z` translation in `_ecma_pattern_to_python` is only
       sound for a lone trailing anchor; a stray `$` elsewhere would stay `$` on
       the Python side and diverge from JS on a trailing newline (issue #492).
    6. The pattern compiles (after the named-group/backreference translation).
    7. Its named groups are EXACTLY the build template's placeholders — so
       `build(parse(url)) == url` can round-trip and neither half carries a
       parameter the other doesn't. (A `\k<name>` backreference is NOT a group,
       so a repeated-slug grammar still has one `geography` group == one
       `{geography}` placeholder.)
    8. Every `reject_reasons` entry (issue #493) is a `{pattern, reason}` mapping
       whose pattern passes the same shared-subset checks (1–4), is start-anchored
       (`^`, so it only matches this portal), uses NO end anchor `$` (a reject
       pattern matches a forbidden fragment, not the whole URL, so the `$`→`\Z`
       translation never applies to it), and compiles.
    """
    grammar = connector.search_url_grammar
    if grammar is None:
        return
    name = getattr(connector, "name", connector.__class__.__name__)
    ecma = grammar.parse_pattern
    _assert_ecma_portable(name, ecma, "parse_pattern")
    if not ecma.startswith("^") or not ecma.endswith("$"):
        raise ValueError(
            f"{name}: grammar parse_pattern must be fully anchored (^…$) (issue #492)"
        )
    unescaped_dollars = [m.start() for m in re.finditer(r"(?<!\\)\$", ecma)]
    if unescaped_dollars != [len(ecma) - 1]:
        raise ValueError(
            f"{name}: grammar parse_pattern must contain exactly one unescaped "
            "`$`, as the final anchor — a `$` elsewhere diverges between Python "
            "and JS on a trailing newline (issue #492)"
        )
    try:
        compiled = re.compile(_ecma_pattern_to_python(ecma))
    except re.error as exc:
        raise ValueError(
            f"{name}: grammar parse_pattern does not compile: {exc}"
        ) from exc
    groups = set(compiled.groupindex)
    placeholders = grammar.placeholders()
    if groups != placeholders:
        raise ValueError(
            f"{name}: grammar named groups {sorted(groups)} != build template "
            f"placeholders {sorted(placeholders)}"
        )
    for i, entry in enumerate(grammar.reject_reasons):
        what = f"reject_reasons[{i}].pattern"
        if not isinstance(entry, Mapping):
            # ValueError (not TypeError) for consistency: every validate_grammar
            # failure is a ValueError describing an invalid grammar, and callers
            # / tests catch that one type.
            raise ValueError(  # noqa: TRY004
                f"{name}: grammar reject_reasons[{i}] must be a mapping with "
                "'pattern' and 'reason' keys (issue #493)"
            )
        rp = entry.get("pattern")
        reason = entry.get("reason")
        if not isinstance(rp, str) or not rp:
            raise ValueError(
                f"{name}: grammar reject_reasons[{i}] has no 'pattern' string (issue #493)"
            )
        if not isinstance(reason, str) or not reason:
            raise ValueError(
                f"{name}: grammar reject_reasons[{i}] has no 'reason' key string (issue #493)"
            )
        _assert_ecma_portable(name, rp, what)
        if not rp.startswith("^"):
            raise ValueError(
                f"{name}: grammar {what} must be start-anchored (^) so it only "
                "matches this portal's URLs (issue #493)"
            )
        if re.search(r"(?<!\\)\$", rp):
            raise ValueError(
                f"{name}: grammar {what} must not use the end anchor `$` — a "
                "reject pattern matches a forbidden URL fragment, not the whole "
                "URL, and a `$` would diverge between Python and JS on a "
                "trailing newline (issue #493)"
            )
        try:
            re.compile(_ecma_pattern_to_python(rp))
        except re.error as exc:
            raise ValueError(f"{name}: grammar {what} does not compile: {exc}") from exc


@dataclass(frozen=True)
class SearchPreview:
    """What discover() will actually execute for a scope — for the "Validar
    filtros" page (issue #478 P4).

    A pure, offline description of the search a connector would run for a
    given profile scope: the entry URL (or endpoint) it hits, what KIND of
    request that is, whether the connector can accept an owner-pinned URL as
    its recall source, and an honest note when there is nothing to tune.

    `search_previews()` builds these by REUSING the same `_search_url()` /
    module constants `discover()` uses, so a preview can never drift from what
    the connector actually does (that's the per-connector pytest contract).

    - `url` is None when the scope resolves to no geography this connector
      covers (a degraded row the page renders with `notes`).
    - `tunable` mirrors `supports_search_override` semantics for the page: a
      connector with a real, host-scoped search URL the owner could pin. The
      sitemap/API connectors whose recall is national/complete are `tunable
      = False` with a note explaining the filtering is by data, not by URL.
    """

    label: str
    url: str | None
    kind: Literal["search_page", "sitemap", "api"]
    tunable: bool
    notes: str | None = None
    # The resolved parameters this preview's URL is built from (issue #491) —
    # geography, operation, room count, … each with its source and whether it
    # travels in the URL. Additive with a default `()` so no existing connector
    # or test needs updating; a connector populates it from the SAME resolved
    # values `discover()`/`_search_url()` use (the anti-drift contract that
    # binds `url`). Serialised into the existing `connector_search_preview
    # .previews` JSONB by `dataclasses.asdict` — no migration.
    params: tuple[SearchParam, ...] = ()


@dataclass(frozen=True)
class ConnectorScope:
    """What a connector should look for.

    Issue #71 closes the gap this docstring used to describe as aspirational:
    the orchestrator now derives scope from the union of active
    `search_profile` rows (`etl.orchestrator._active_profile_scopes`) instead
    of a hand-written literal. `search_profile.scope.geography` is a
    radius-from-a-point (`{center: [lat, lon], radius_km}`, see
    `dashboard/lib/profiles-schema.ts`), so that's the shape carried here too
    — `center`/`radius_km`, not a free-text city slug.

    Deliberately NOT a shared slug registry mapping (lat, lon) -> a site's
    URL-path slug: different sites encode geography completely differently
    (Fotocasa uses a hyphenated city slug, Milanuncios its own path segment;
    a future Idealista/pisos.com connector may use neither), and a shared
    registry would need updating every time a new site connector is added.
    Each connector already owns its own site-specific URL/query construction
    (that's the whole point of the `discover`/`fetch_detail`/`normalize`
    split per `docs/architecture/connectors.md`) — so translating a
    (center, radius_km) point into whatever geography encoding a given site
    needs is that connector's own job, not this module's. `geography` is
    kept as a free-text escape hatch for tests/manual construction that want
    to bypass point-based translation entirely.
    """

    geography: str = ""
    center: tuple[float, float] | None = None  # (lat, lon)
    radius_km: float | None = None
    property_types: tuple[str, ...] = field(default_factory=tuple)
    # Issue #99: the one native site filter confirmed real via live
    # verification (Fotocasa's rooms-count URL path segment genuinely
    # narrows results, not just an SEO alias — see
    # docs/architecture/connectors.md). Named `rooms`, not `min_rooms`:
    # live verification (a real fetch of `.../2-habitaciones/l`, 31
    # results) showed every result had exactly 2 rooms, none 3+ — this is
    # an EXACT-match filter on Fotocasa's side, not a minimum, and calling
    # it `min_rooms` would actively mislead a caller into expecting 2+.
    # Carried on the scope itself, not a separate parameter, so it flows
    # through the same discover()/scope_key() path as center/radius_km. A
    # connector that doesn't support filtering by room count simply
    # ignores this field — it is not part of this class's identity
    # contract the way center/radius_km are (issue #96/#71's
    # coverage-resolution logic never looks at it).
    rooms: int | None = None
    # Issue #478 P5 (D-101): an owner-pinned search URL that IS this
    # (profile × connector)'s recall source — the URL discover() hits as its
    # entry page instead of the one it would build from center/radius. Set by
    # the orchestrator (`_scopes_for_connector`) from `profile_connector_filter`
    # for a connector that declares `supports_search_override`; None for every
    # other scope. Verbatim — never re-substituted (the owner tuned it by hand;
    # it is the strongest "owner-confirmed" signal, tier 0 over D-051).
    #
    # Carried on the scope itself, same precedent as `rooms` above, so it flows
    # through the identical discover()/scope_key() path. Crucially it IS part of
    # this scope's identity here: `scope_key()` incorporates it, so an override
    # scope is never deduped against the twin (non-override) scope derived from
    # the same geography — both run, and the pinned URL is that profile's recall
    # source. A connector WITHOUT `supports_search_override` simply ignores this
    # field (no error) — the orchestrator never sets it for such a connector.
    override_url: str | None = None
    # Issue #530: the set of search_profile ids that produced this scope —
    # informational attribution ONLY, never part of the identity contract
    # (exactly like `rooms` above; #96/#71's coverage-resolution logic and
    # `scope_key()` must never look at it). Its sole purpose is to make each
    # recorded geography-scope outcome attributable back to the profile(s) it
    # came from so a (connector × profile) view of data quality is possible
    # (enables #531/#532). A scope shared by N profiles carries N ids (the
    # ordered, deduped union — dedup for actual fetching is unchanged, the
    # scope is still crawled once, it just now names both profiles); a
    # manual/test scope or an unattributed override carries `()`. It must
    # NEVER enter `scope_key()` — doing so would change D-101's
    # override-vs-derived dedup guarantee for every connector at once.
    profile_ids: tuple[int, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class RawListing:
    """The unparsed result of fetch_detail — whatever the site actually returned.

    `raw` holds the connector's native representation (parsed HTML fields,
    a JSON API response, whatever) prior to normalization. Keeping it
    separate from CanonicalListingVersion means a normalize() bug never
    loses the original fetch — replay/backfill just needs raw, not a new
    network call.
    """

    external_id: str
    source: str
    raw: dict[str, Any]


@dataclass(frozen=True)
class CanonicalListingVersion:
    """Site-agnostic listing fields, ready to upsert into `property`/`listing`.

    Field set mirrors the `property`/`listing` columns from
    etl/schema/init.sql (Phase 1.2, issue #10) directly — the orchestrator
    maps this 1:1 onto those tables. Anything a source doesn't publish is
    None; anything the schema doesn't have a column for goes in `raw_extra`
    rather than being silently dropped (issue #1 §4).
    """

    external_id: str
    source: str
    url: str | None
    listing_kind: str | None  # 'particular' | 'agency' | None if undetermined
    status: str  # 'active' | 'reserved' | 'sold' | 'withdrawn' | 'expired'
    current_price: Decimal | None
    description: str | None
    photo_urls: tuple[str, ...]
    contact_raw: str | None
    # property-level fields (each new external_id gets its own singleton
    # `property` row at ingest time per issue #10 — see
    # docs/architecture/data-model.md)
    address: str | None
    lat: Decimal | None
    lon: Decimal | None
    property_type: str | None
    m2_built: Decimal | None
    m2_useful: Decimal | None
    rooms: int | None
    bathrooms: int | None
    floor: str | None
    has_elevator: bool | None
    year_built: int | None
    energy_rating: str | None
    raw_extra: dict[str, Any] = field(default_factory=dict)
    # Schema superset vs. property_web_scraper's field model (issue #76).
    # Defaulted (unlike the fields above) so existing connectors/tests don't
    # need updating just to add this dataclass shape — populating these from
    # real connector data is the Fotocasa/Milanuncios retrofit issues' job
    # (#77/#78), not this one.
    city: str | None = None
    province: str | None = None
    postal_code: str | None = None
    m2_plot: Decimal | None = None
    features: tuple[str, ...] = field(default_factory=tuple)
    # 'sale' | 'rent' — listing-level, not property-level (see
    # etl/schema/init.sql's `listing.operation`). None (not defaulted to
    # 'sale') so the orchestrator's UPDATE-path COALESCE can tell "connector
    # didn't say" apart from "connector said sale" and fall through to the
    # existing DB value on re-visit instead of overwriting a real 'rent' back
    # to 'sale' every time a connector that doesn't set this re-fetches a
    # listing. INSERT path defaults an unset value to 'sale' explicitly.
    operation: Literal["sale", "rent"] | None = None
    # Seller/agency-assigned reference code (issue #72), e.g. Fotocasa's
    # "Referencia: NS603" — a dedup signal, not a unique key (see
    # etl/schema/init.sql's column comment). Defaulted None for the same
    # reason as the other superset fields above: existing connectors/tests
    # don't need updating for this dataclass shape to gain the field.
    reference_code: str | None = None
    # Spanish cadastral reference (`referencia catastral`) — property-level,
    # unlike reference_code above, and the dedup engine's *definitive*
    # signal rather than a probabilistic one (issue #1 §6 signal 1). Only
    # servicer/REO portals tend to publish it: they hold the asset and so
    # have the registry data, whereas a consumer portal re-listing someone
    # else's property does not. Solvia publishes it on every listing;
    # Vivantial and Servihabitat were both checked and do not (issue #140).
    # Not unique in the schema — see init.sql's column comment for why.
    cadastral_ref: str | None = None

    def __post_init__(self) -> None:
        if self.operation is not None and self.operation not in _VALID_OPERATIONS:
            raise ValueError(
                f"CanonicalListingVersion.operation must be one of "
                f"{_VALID_OPERATIONS} or None, got {self.operation!r}"
            )
        # Centralised here rather than per-connector so every connector in
        # the #132 servicer batch inherits the guard automatically — those
        # are exactly the portals that publish a cadastral reference, and
        # so exactly the ones that could publish a placeholder instead.
        # frozen=True, hence object.__setattr__.
        object.__setattr__(
            self, "cadastral_ref", normalize_cadastral_ref(self.cadastral_ref)
        )


class ConnectorError(Exception):
    """Raised by a connector's discover/fetch_detail/normalize on failure.

    The orchestrator counts these (and any other exception) toward the
    circuit breaker's error rate — connectors don't need to know the
    breaker exists, they just raise on failure like any other code.

    A plain `ConnectorError` is a FATAL failure (network error, invalid JSON,
    an HTML structure that genuinely changed). For site-side rate-throttling
    that should be treated as a clean "waited for budget" backoff rather than
    an error state, raise `SoftBlockError` instead — see below and D-047.
    """


class SoftBlockError(ConnectorError):
    """A connector hit the site's own rate-throttling / bot-mitigation wall
    (issue #270, D-047): an HTTP 200 whose listing payload is withheld, a
    CAPTCHA interstitial, or an equivalent "come back later" response.

    This is NOT a bug and NOT a sign the connector is broken — it's the site
    telling us we've spent this run's budget. Subclasses `ConnectorError` so
    existing `except ConnectorError` handlers keep working, but the
    orchestrator classifies it distinctly: it trips the circuit breaker only
    at the looser soft-block threshold, and a breaker/discover stop caused by
    it is recorded as a CLEAN run outcome (status stays 'ok', with an
    informational notice) rather than 'failed'/'circuit_open'. The failed
    fetch is still counted in `error_count` — reducing those genuine failures
    is tracked separately (issue #291). See etl.connectors.circuit_breaker and
    etl.orchestrator.
    """


# HTTP statuses a detail fetch returns when the listing itself no longer
# exists at the source — it was removed/withdrawn between the discover()
# sweep that surfaced its id and this run's detail fetch. 410 Gone is the
# explicit signal; 404 is what most listing sites actually return for a
# since-removed detail page. Kept here (not in a connector) so every
# connector classifies the same statuses, and as a bare int set so this
# module keeps its deliberate zero-`requests`-import property (see the
# module docstring) — each connector extracts the status from its own
# already-caught HTTPError and checks membership. See issue #291.
LISTING_GONE_HTTP_STATUSES = frozenset({404, 410})


class ListingUnavailableError(ConnectorError):
    """fetch_detail found that a discovered listing no longer exists at the
    source (an HTTP status in `LISTING_GONE_HTTP_STATUSES`).

    A real classifieds site turns inventory over constantly: a listing
    present in a discover() search page is routinely removed by the seller
    (or expires) in the minutes before this run's detail fetch reaches it.
    That is expected churn, not a fetch/parse failure an operator should
    chase — but before issue #291 every connector wrapped a 404 into a
    plain ConnectorError, so a handful of just-removed listings inflated
    `connector_run_results.error_count` on essentially every fotocasa /
    milanuncios scope run (the persistent `errors=7..10` the issue reports).

    A distinct subclass lets `etl.orchestrator.run_connector` treat this as
    a clean skip — not counted toward `error_count` — while still a
    ConnectorError, so a mass of them (the detail-URL shape broke, so
    *every* fetch 404s) still trips the shared circuit breaker rather than
    silently fetching nothing. Connectors raise it only for the unambiguous
    HTTP-gone case; a 200-with-no-payload page stays a generic
    ConnectorError, because that is the soft-block signature and must never
    be reclassified as "listing gone". See issue #291 and issue #66.
    """


@dataclass(frozen=True)
class RetiredNoticeFacts:
    """Everything a portal's own "this advert is retired" notice STATES,
    parsed out of it (issue #691's hardening of D-159).

    `retired_page_signature` answers one question — "is this page the
    portal's retired-advert notice?" — and answers it with a prose citation.
    That is all the stale-verification pass needs, because it already knows
    which listing it asked about: it fetched that one URL itself.

    The CAPTURE path does not have that luxury. The page arrives from a
    browser the pipeline does not control, and a portal's notice page is
    generic chrome — near enough the same shell for every dead advert. A
    bare "yes, some advert is gone" is therefore not enough to withdraw a
    specific row: the notice has to be shown to be about *this* listing.
    Real notices carry exactly what that needs — the advert's own reference
    number, the date the advertiser took it down, and its headline
    price/size/rooms — so this structure exposes them, and the caller (the
    half of the system that has database access) does the corroborating.

    Every field except `citation` is optional, and `None` means "the notice
    did not state it" — never "it stated zero". A caller must treat an
    absent field as *no information* and fall back to what it would have
    done without it; treating absence as a mismatch would turn a reworded
    notice into a silent, permanent loss of the only evidence channel a
    capture-only portal has.

    `stated_price` / `stated_m2` / `stated_rooms` are what the NOTICE says:
    a plain-rendered-text parse of facts the pipeline already holds from a
    proper structured capture. They exist to be recorded as evidence, and
    (size/rooms only) to be corroborated against the stored row — never to
    be written back onto it. Price is deliberately NOT corroboration
    material: a seller can legitimately reprice before delisting, so a price
    that disagrees is not a reason to doubt the notice. See D-159.
    """

    # Prose citation of what the page said, persisted verbatim into
    # `listing_status_event.evidence`. Always present: a facts object exists
    # only when the notice was positively identified.
    citation: str
    # The advert's own reference/id as printed on the notice ("Referencia
    # del anuncio: 900000001"), verbatim digits.
    reference: str | None = None
    # The date the notice says the advertiser withdrew the advert. Already
    # sanity-checked by the connector that parsed it — a connector leaves
    # this None rather than hand on a date it does not believe.
    delisted_on: date | None = None
    # The advert's headline figures AS PRINTED ON THE NOTICE.
    stated_price: Decimal | None = None
    stated_m2: Decimal | None = None
    stated_rooms: int | None = None


@dataclass(frozen=True)
class VerificationOutcome:
    """The result of re-reading ONE already-known listing to obtain evidence
    about whether it still exists at the source (issue #643).

    The whole point of the stale-verification pass is that elapsed time is
    evidence of NON-OBSERVATION, not of absence: it may nominate a listing
    for a second look, but only the source's own answer may change the
    listing's status. So this type deliberately has exactly two states —
    both of them *positive* findings — and there is no third "probably
    gone" value:

    * ``gone``  — the source positively said the listing is not there:
      an HTTP status in `LISTING_GONE_HTTP_STATUSES` (surfaced as
      `ListingUnavailableError`, D-049), or a per-connector
      `retired_page_signature` match on a 200 that is unambiguously the
      site's own "este anuncio ya no está disponible" page.
    * ``alive`` — the source served the listing's real detail page and the
      connector parsed it.

    Everything else — a soft block (D-047), a timeout, a 5xx, an
    unparseable or empty 200 — is NOT a `VerificationOutcome` at all: the
    connector raises (`SoftBlockError` / `ConnectorError`), the orchestrator
    records the attempt, and **nothing about the listing changes**. Absence
    of evidence never becomes evidence of absence.

    `evidence` is the human-readable citation persisted to
    `listing_status_event.evidence` when a withdrawal is recorded, so an
    operator (and a future reviewer) can always answer "what did we actually
    observe?" without re-deriving it. `canonical`, when present, is the
    freshly-normalized listing the verification fetch already produced —
    the orchestrator upserts it, so an alive verification self-heals the
    listing's data (price, photos, timestamps) rather than merely bumping a
    clock.
    """

    state: Literal["gone", "alive"]
    evidence: str
    canonical: CanonicalListingVersion | None = None


class Connector(ABC):
    """Base class every site connector subclasses.

    Class attributes (not instance state) configure the shared rate
    limiter/circuit breaker the orchestrator wraps around every connector
    — a connector never rate-limits or trips its own breaker, that's the
    framework's job (issue #11), so every connector gets it for free.

    There is deliberately no `max_concurrency`-style knob here: the
    orchestrator runs connectors sequentially, one at a time, in Phase 1 —
    an attribute implying concurrent execution exists would be a knob that
    does nothing. Add it back, wired to a real concurrent runner, if/when a
    later phase actually needs to fetch multiple listings in parallel.
    """

    name: str
    rate_limit_per_minute: int = 30
    # Circuit breaker: abort the run if this fraction of the *most recent*
    # `circuit_breaker_window` attempts fail, once at least
    # `circuit_breaker_min_attempts` attempts have happened (avoids tripping
    # on e.g. 1 failure out of 2 early attempts). See
    # docs/architecture/connectors.md for why the window is rolling, not
    # cumulative-since-run-start.
    circuit_breaker_error_rate: float = 0.30
    circuit_breaker_min_attempts: int = 10
    circuit_breaker_window: int = 20
    # Issue #270 (D-047): the looser rolling-window error-rate at which
    # SOFT-BLOCK errors (site rate-throttling, `SoftBlockError`) trip the
    # breaker — kept separate from `circuit_breaker_error_rate`, which gates
    # genuine FATAL errors. None (the default) means "trip soft-blocks exactly
    # like fatal errors", a conservative no-op that changes no connector's trip
    # timing unless it opts in. A connector whose soft-block is TRANSIENT
    # (Fotocasa: a throttle burst mid-sweep that clears) raises this so a burst
    # doesn't trip the breaker and abandon the connector's other scopes for the
    # run; one whose block is a long hard lockout (Milanuncios) leaves it None
    # and trips promptly. Either way the trip is recorded as a clean
    # "waited for budget" stop, not an error. Must be >= circuit_breaker_error_rate.
    circuit_breaker_soft_block_error_rate: float | None = None

    # Whether discover() sees the connector's *entire* active inventory for
    # its scope on every sweep, or only some subset of it (e.g. one search-
    # results page out of hundreds, when robots.txt or the source disallows
    # pagination). This gates withdrawal detection (issue #12 EC-5,
    # etl.orchestrator._reconcile_missed_discoveries): a listing missing
    # from a *partial* sweep tells you nothing about whether it's still
    # active — it may simply have scored below the cutoff of whatever
    # subset this sweep covered, especially under a relevance/recency sort
    # rather than a stable one. Treating that as "3 misses -> withdrawn"
    # would corrupt exactly the signal issue #1 §10 calls out as valuable
    # (real withdrawals, relistings-at-a-lower-price). Default True (most
    # connectors should aim for full coverage); a connector that can't
    # achieve it (like Fotocasa, page-1-only per its own docstring) must
    # override this to False and accept that its listings never
    # auto-transition to withdrawn from absence alone.
    discovers_full_inventory: bool = True

    # Issue #100 (connector management UI): declarative metadata the
    # dashboard reads via connector_registry, so the UI renders what a
    # connector can actually do rather than assuming every connector is
    # configurable the same way.
    #
    # supports_discovery=False means discover() never runs for this
    # connector under any scope (Idealista — capture-only, issue #75,
    # scope_key() always returns None). Geography/filter controls for such
    # a connector would be controls that silently do nothing, so the UI
    # renders it as capture-only instead.
    supports_discovery: bool = True

    # Native site-filter keys this connector genuinely honours in
    # discover(), consumed as `ConnectorScope` fields set from
    # connector_config.filters. The UI renders one control per key here and
    # nothing at all for an empty tuple — deliberately opt-in, so a filter
    # dimension that hasn't been live-verified for a site (issue #99
    # confirmed only Fotocasa's room count; price/property-type and
    # Milanuncios' equivalent remain unconfirmed per
    # docs/architecture/connectors.md) can never ship as a control that
    # looks functional but isn't.
    supported_filters: tuple[str, ...] = ()

    # Issue #478 (Validar filtros): the host suffix an owner-pinned search URL
    # must fall under for this connector, published to `connector_registry` by
    # sync_connector_registry() so the dashboard's PUT
    # /api/profiles/[id]/connector-filters route can validate a pinned URL's
    # host server-side (never client-claimed — #476). None means this connector
    # does not accept a pinned URL at all: the capture-only portals (their
    # override lives on the TS side) and the non-tunable sitemap/API connectors
    # (cimenta2/vivantial/buildingcenter/escogecasa — national/complete recall,
    # nothing to pin) leave it None.
    override_host_suffix: str | None = None

    # Issue #515 (uniform "Abrir"): the connector's public home/base page — the
    # portal's browseable landing page the dashboard opens when a row has NO
    # derived/pinned search URL yet, so "Abrir" is never a dead button (the owner
    # can reach the portal, navigate and hand a search URL back). Published to
    # `connector_registry.home_url` by sync_connector_registry() and read by the
    # Validar-filtros ETL rows.
    #
    # This is a PROPERTY, not a bare class attribute, so it defaults to
    # `https://www.{override_host_suffix}` for the many connectors that already
    # declare a host suffix — no per-connector boilerplate. A subclass may shadow
    # it with a plain class attribute string (which wins over this property in the
    # MRO): the four structural connectors whose `override_host_suffix` is None by
    # design (cimenta2/vivantial/buildingcenter/escogecasa) set an explicit value
    # so their rows still open the portal. A connector with neither a host suffix
    # nor an explicit `home_url` reports None — its row stays without a portal link
    # (should be none in the fleet after #515).
    @property
    def home_url(self) -> str | None:
        if self.override_host_suffix:
            return f"https://www.{self.override_host_suffix}"
        return None

    # Whether discover() actually CONSUMES a pinned `ConnectorScope.override_url`
    # as its entry URL. False for every connector in Phase 4 — the page can save
    # a pin against `override_host_suffix`, but the recall wiring
    # (`scope.override_url` → discover()) lands per-connector in Phase 5. Kept
    # distinct from `override_host_suffix` so a connector can advertise "you may
    # pin a URL here" before its discover() honours it.
    supports_search_override: bool = False

    # Issue #491: a declarative, invertible grammar for this connector's search
    # URL (build template + parse regex). Published to
    # `connector_registry.search_url_grammar` by sync_connector_registry so the
    # dashboard can infer params from an owner-edited URL in the browser — one
    # generic implementation, no per-connector TypeScript. None (the default)
    # means "no grammar published": the page still shows this connector's params
    # (from search_previews) but cannot re-infer them from an edited URL. A
    # grammar must satisfy `validate_grammar` and stay pinned to `_search_url()`
    # by a per-connector round-trip pytest contract.
    search_url_grammar: SearchUrlGrammar | None = None

    def search_previews(self, scope: ConnectorScope) -> list[SearchPreview]:
        """What discover() would execute for `scope`, for the Validar filtros page.

        Pure and offline — resolves geography against the local gazetteer and
        reuses the connector's own `_search_url()`/constants, issuing no network
        request. Default `[]` means "no ETL preview" (the capture-only portals,
        whose preview is produced on the TypeScript side). Every HTTP connector
        overrides this (issue #478 P4).
        """
        return []

    # Issue #143 (fetch-budget / skip-if-seen): minimum seconds between two
    # real fetch_detail() calls for the same already-known external_id.
    # 0 (default) preserves the original behaviour every connector had
    # before this — fetch_detail() runs for every discovered id, every run,
    # unconditionally. Skip-if-seen is opt-in per connector, not a global
    # switch: a 200k-listing bank-portal connector and a 3-req/min
    # Fotocasa have completely different fetch economics, and a connector
    # that hasn't been shown to need it shouldn't take on the staleness
    # risk for free. Override upward only with a real reason (see
    # fotocasa.py, the first connector to set this non-zero) — and see
    # etl.orchestrator._should_skip_fetch for the full policy, which never
    # skips a listing that has never been fetched, is missing its price,
    # or that has an unconfirmed price observation (a
    # listing_price_history row newer than last_fetched_at — recorded from
    # `discovered_prices` below; re-anchored per issue #432 / D-098),
    # regardless of this window.
    #
    # Operator-overridable per connector via `connector_config
    # .min_refetch_interval_seconds` (NULL = no override, use this
    # class-attribute default) — see etl.orchestrator._scopes_for_connector.
    min_refetch_interval_seconds: int = 0

    # Issue #628/#629 (Opus review, B4): does fetch_detail() do real work to
    # backfill `listing.reference_code` for an already-captured listing
    # (a real request, not just re-parsing a stash) when it is still NULL?
    # False (default) preserves every existing connector's behaviour.
    # `etl.orchestrator._should_skip_fetch` reads this: when True AND the
    # stored reference_code is NULL, the #435 unchanged-list-price skip
    # (D-099) and the staleness window are both bypassed so the backfill
    # actually gets a chance to run — without this, a connector whose
    # `discovered_prices()` also participates in #435 (pisos does) would
    # otherwise skip every already-known listing forever on unchanged
    # price, permanently NULL despite fetch_detail() now being able to
    # populate it (the exact gap a live production check found: 331/331
    # existing pisos listings, all D-099-skip-eligible, never re-fetched).
    # Keeps forcing a real fetch every run for as long as reference_code
    # stays NULL — no separate "already tried, give up" bit. Simple, and
    # bounded in practice for the connector this landed for (pisos:
    # roughly 300 listings, moderate rate limit). A listing that
    # genuinely has no published reference stays NULL forever and gets
    # re-tried forever; revisit with a give-up counter if that cost ever
    # matters for a larger connector.
    backfills_missing_reference_code: bool = False

    # Issue #643: may the orchestrator's stale-verification pass re-read this
    # connector's already-known listings to find out whether they are still
    # there? OFF by default, and opting in is a deliberate per-connector act,
    # because the pass is the ONLY mechanism in the codebase allowed to
    # withdraw a listing on a single observation — everything else needs
    # `_WITHDRAWAL_THRESHOLD` consecutive misses of a full-inventory sweep.
    #
    # Two hard preconditions before setting this True:
    #
    # 1. `verify_listing()` must obtain its answer from a REAL request for
    #    THIS listing. A connector whose `fetch_detail()` reads a stash that
    #    `discover()` filled earlier in the same run (fotocasa_rental, pisos)
    #    raises `ListingUnavailableError` for "not in the last discover()
    #    payload" — which during verification would mean "we never looked",
    #    not "it is gone", and would mass-withdraw live inventory. Such a
    #    connector must either override `verify_listing()` with a real
    #    stored-URL fetch (pisos does) or stay opted out (fotocasa_rental).
    # 2. A 200 that is NOT the listing's real page must never reach
    #    `normalize()` as if it were: the connector's own soft-block
    #    detection has to raise `SoftBlockError`/`ConnectorError` first
    #    (fotocasa/milanuncios both do, via their `__initial_props__`
    #    marker check).
    #
    # Deliberately NOT set for capture-only portals (`supports_discovery =
    # False`: idealista/aliseda/altamira/hipoges) — background fetching them
    # is what D-081/D-026/D-027 exist to prevent; their evidence path is
    # issue #645, not this one.
    supports_stale_verification: bool = False

    # Issue #643 (PR #685 review, M2): this connector's own ceiling on how
    # many stale listings the verification pass may re-read per run, or None
    # to accept the global `etl.stale_verification_budget_per_run`. Same
    # pattern as `rate_limit_per_minute`: a plain class attribute, set by the
    # connector that measured its own limit.
    #
    # Applied as a `min()` against the global budget, never as a replacement —
    # so setting the global to 0 still stops every connector dead, which is
    # the operator's kill switch and must not be overridable from code.
    #
    # It exists because the global budget is one number for portals with very
    # different tolerances. Verification is extra detail traffic appended to
    # every hourly run, and on a portal that walls after a handful of detail
    # fetches the resulting soft block OUTLIVES the run: D-070's "spend only
    # what real work left over" posture protects THIS run, but a 60-minute
    # lockout poisons the next run's `discover()` too. Milanuncios is the
    # measured case (D-017/#179: ~5 successful fetches, then 60+ minutes).
    stale_verification_budget_per_run: int | None = None

    def retired_page_signature(
        self, html: str, final_url: str | None = None
    ) -> str | None:
        """A POSITIVELY identified "this listing was retired" marker, or None.

        Issue #643. Some portals answer a request for a removed listing with
        an HTTP 200 carrying their own "anuncio caducado / ya no está
        disponible" page, or redirect to a not-found landing page while
        keeping a 200. When a connector can recognise that page *by a marker
        the site itself puts there*, this returns a short Spanish citation of
        what was seen — which becomes `listing_status_event.evidence`.

        Default: None — "I have no reliable way to tell". That is the honest
        answer for most portals and it costs nothing: an HTTP 404/410 (D-049)
        already proves absence on its own, so a connector without a signature
        still verifies correctly, just via the status code alone.

        **Never invent one.** A false positive here marks a live listing
        withdrawn, which is precisely the failure the whole design is built
        to avoid. In particular an unparseable, empty or unexpected 200 is
        NOT a retired page — that is the soft-block signature (D-047), and
        conflating the two would let a rate-throttle wall wipe a source's
        inventory. Return None and let the listing stay unverified.

        `final_url` is the URL the request actually landed on after
        redirects, when the connector has it — some portals express "not
        found" as a redirect to a search page rather than as page content
        (fotocasa's `?propertyNotFound`, observed live 2026-08-22).
        """
        return None

    def retired_notice_facts(
        self, html: str, final_url: str | None = None
    ) -> RetiredNoticeFacts | None:
        """The STRUCTURED sibling of `retired_page_signature` — the same
        identification, plus whatever the notice states about the advert it
        replaced (issue #691, D-159).

        Default: None, i.e. "I recognise no notice, or I parse no facts out
        of the one I recognise". Overriding this is optional and changes
        nothing for a connector that does not: `retired_page_signature`
        remains the contract the stale-verification pass calls, and every
        connector that implements only that one keeps working unchanged.

        A connector that DOES override it should implement the recognition
        here once and make `retired_page_signature` return
        `facts.citation`, so the two can never disagree about whether a page
        is a notice.

        This exists because the capture path (`etl/capture.py`) needs to
        corroborate a notice against the specific listing being captured
        before it will withdraw anything, and the checks it wants split
        across two places that know different things: the connector holds
        the page, the caller holds the database. Returning parsed facts
        rather than a string keeps the DB out of the connector — see
        `RetiredNoticeFacts`.
        """
        return None

    def verify_listing(
        self, external_id: str, url: str | None, throttle: Throttle
    ) -> VerificationOutcome:
        """Re-read ONE already-known listing and report what the source said.

        Issue #643, the evidence half of "time nominates, evidence decides".
        Called by `etl.orchestrator.verify_stale_listings` for connectors
        that set `supports_stale_verification = True`, at most
        `etl.stale_verification_budget_per_run` times per connector per run,
        always through the connector's own shared rate limiter and circuit
        breaker.

        Contract:

        * return `VerificationOutcome("gone", ...)` only on a positive
          removal signal;
        * return `VerificationOutcome("alive", ..., canonical)` when the real
          detail page came back and normalized;
        * raise `ListingUnavailableError` (D-049) for HTTP 404/410 — the
          orchestrator maps it to `gone` with the exception text as evidence;
        * raise `SoftBlockError` for a rate-throttle wall and
          `ConnectorError` for anything else indeterminate. Both mean "no
          evidence": the orchestrator changes nothing about the listing.

        `url` is the listing's stored `listing.url`, for connectors whose
        detail page can't be addressed from `external_id` alone. It may be
        None; a connector that needs it must raise `ConnectorError` rather
        than guess.

        Default: `NotImplementedError`, guarding the opt-in — a connector
        that flips `supports_stale_verification` without implementing this
        fails loudly on the first attempt instead of silently doing nothing.
        """
        raise NotImplementedError(
            f"{type(self).__name__} does not implement verify_listing(); "
            "set supports_stale_verification = False or implement it "
            "(see Connector.verify_listing, issue #643)"
        )

    def verify_via_fetch_detail(
        self, external_id: str, throttle: Throttle
    ) -> VerificationOutcome:
        """`verify_listing` for connectors whose `fetch_detail()` is self-sufficient.

        Issue #643. Reuses the connector's own detail path verbatim — same
        URL construction, same headers, same soft-block detection, same
        `normalize()` — so verification can never disagree with the fetch
        loop about what a page means, and an alive listing comes back fully
        refreshed rather than merely re-timestamped.

        Only safe for a connector whose `fetch_detail(external_id)` makes a
        real request for that id without depending on state a `discover()`
        call left behind this run — see `supports_stale_verification`'s
        precondition 1 for the connectors this excludes.

        The retired-page check runs BEFORE `normalize()` on purpose: a
        not-found landing page can still parse into a plausible-looking
        (but wrong) canonical listing, so it must be intercepted while the
        raw page is still identifiable as such.

        That check reads `raw.raw["html"]`, which is a real coupling: a
        connector whose `fetch_detail()` returns a parsed payload with no
        `html` key (milanuncios returns `{"url", "props"}`) would hand
        `retired_page_signature` an empty string forever, and a signature
        keyed on page content would silently never fire. Harmless while the
        connector has no signature — but silent, and a silent never-fires is
        exactly what PR #685's review caught. So it is checked, and a
        connector that overrides `retired_page_signature` without exposing
        HTML raises instead: `ConnectorError` means "no evidence", so the
        orchestrator changes nothing about the listing and logs the reason.
        """
        raw = self.fetch_detail(external_id, throttle=throttle)
        payload = raw.raw if isinstance(raw.raw, dict) else {}
        html = payload.get("html")
        final_url = payload.get("url")
        # Either override counts: a connector may implement the recognition
        # in `retired_notice_facts` and let `retired_page_signature` delegate
        # to it (idealista does), in which case the class attribute for the
        # latter would still look inherited on a subclass that only supplied
        # the former.
        has_own_signature = (
            type(self).retired_page_signature is not Connector.retired_page_signature
            or type(self).retired_notice_facts is not Connector.retired_notice_facts
        )
        if has_own_signature and not isinstance(html, str):
            raise ConnectorError(
                f"{type(self).__name__} overrides retired_page_signature() but "
                f"its fetch_detail() payload for external_id={external_id} "
                f"carries no 'html' key (keys: {sorted(payload)}) — the "
                "signature would silently never fire. Either return the page "
                "HTML from fetch_detail() or override verify_listing() "
                "(issue #643)."
            )
        signature = self.retired_page_signature(
            html if isinstance(html, str) else "",
            final_url if isinstance(final_url, str) else None,
        )
        if signature is not None:
            return VerificationOutcome("gone", signature)
        canonical = self.normalize(raw)
        where = final_url if isinstance(final_url, str) and final_url else external_id
        return VerificationOutcome(
            "alive",
            f"HTTP 200 con ficha completa y parseable en {where}",
            canonical,
        )

    def discovered_prices(self) -> dict[str, Decimal]:
        """Prices observed as a side effect of the most recent discover() call.

        Issue #143: skip-if-seen's one hard requirement is that it must not
        be able to silently stop detecting a real price change (the
        product's core signal — see issue #1 §10 and docs/skills/
        connectors.md). Some sites embed each result's price in the very
        page discover() already fetches to find external_ids (Fotocasa's
        search-results JSON — confirmed live, see fotocasa.py); reading it
        there is free (no second request) and lets the orchestrator force
        a re-fetch the moment a discovered price disagrees with what's
        stored, even for a listing that would otherwise look "fresh
        enough" under `min_refetch_interval_seconds`.

        Default: empty dict, meaning "no discovery-time price signal" —
        NEVER a promise that a listing's price is unchanged. A connector
        must only override this once it has verified (against a real
        fetched page, not assumed from a reference mapping or an older
        connector's shape) that the field it would read here is both
        present and reliable — see docs/skills/connectors.md for a
        worked example of a connector that investigated this and could
        NOT confirm it (Milanuncios), and left this at the default rather
        than guess.

        Called by the orchestrator immediately after discover() returns,
        before any fetch_detail() calls for that same scope — a connector
        that overrides this should stash whatever price data it parsed
        out of discover()'s own request on `self` during discover(), and
        return it here. Keyed by the same external_id strings discover()
        returned.
        """
        return {}

    def scope_key(self, scope: ConnectorScope) -> str | None:
        """Return a string identifying what this scope actually resolves to.

        The orchestrator uses this to dedupe crawling within one run: two
        scopes that resolve to the same key hit the identical target, so
        the second is skipped rather than redundantly re-crawled (issue
        #71 — two active search profiles with different exact centers can
        easily resolve to the same city). It's also used to detect a scope
        this connector has no coverage for at all: return `None` for a
        scope that can't be resolved to anything real, and the orchestrator
        skips it as unresolvable (logged, not treated as a failure) rather
        than calling `discover()` and making the connector raise for a
        target it was never going to be able to look at.

        Default: no site-specific geography resolution, so every distinct
        `(geography, center, radius_km)` combination is its own key and
        `None` is never returned — every scope is treated as both unique
        and resolvable. Override when a connector translates `scope.center`
        into a site-specific geography (see fotocasa.py/milanuncios.py's
        `_resolve_geography`, which their `scope_key` override delegates
        to directly).

        Issue #478 P5 (D-101): a scope carrying an owner-pinned
        `override_url` MUST resolve to a key that includes it — the default
        appends `f"override:{override_url}"` when present — so the override
        scope is never deduped by the orchestrator against the twin
        (non-override) scope derived from the same geography. A connector
        that overrides this method and supports pinned URLs must do the same
        (see pisos/habitaclia/milanuncios).
        """
        if scope.geography:
            base = f"geography:{scope.geography}"
        else:
            base = f"raw:{scope.center}:{scope.radius_km}"
        if scope.override_url:
            return f"{base}|override:{scope.override_url}"
        return base

    @abstractmethod
    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        """Return external_ids that exist for this scope. Cheap; no full fetch.

        Call `throttle()` before each real network request this method
        makes. The orchestrator also calls it once before invoking
        `discover` at all, which is sufficient for a connector that issues
        a single request here — a connector that paginates internally
        (multiple requests within one `discover` call) must call `throttle`
        again before each of those, since the orchestrator has no visibility
        inside this method to do it for you.
        """

    @abstractmethod
    def fetch_detail(self, external_id: str, throttle: Throttle) -> RawListing:
        """Fetch and return the full raw listing for one external_id.

        Call `throttle()` before the request if this method's own single
        request isn't already covered by the orchestrator's per-call
        acquire — see `discover`'s docstring for the same reasoning. For a
        connector that makes exactly one request per `fetch_detail` call,
        the orchestrator's own acquire is enough and calling `throttle`
        again here is harmless (rate limiting an already-throttled call
        just costs a possible tiny extra wait, never incorrectness).
        """

    @abstractmethod
    def normalize(self, raw: RawListing) -> CanonicalListingVersion:
        """Map a RawListing to the canonical, storage-ready shape."""
