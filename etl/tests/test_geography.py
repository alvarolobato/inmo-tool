"""Unit tests for etl.connectors.geography (issue #71, expanded #169).

Issue #169 replaced the old 4-entry `CITY_CENTROIDS` dict with a vendored
~8,248-municipality gazetteer (etl/connectors/geodata/es_places.csv). Some
of the original tests below encoded assumptions that only held because the
gazetteer was tiny (e.g. "the Getafe test point resolves to Madrid" — true
only because Getafe itself wasn't a known place; with a real gazetteer it
correctly resolves to Getafe, its own entry). Updated accordingly, with the
reasoning kept inline so nobody mistakes these updates for silently
loosening what's being tested.
"""

from __future__ import annotations

import pytest

from etl.connectors import geography
from etl.connectors.base import ConnectorScope
from etl.connectors.fotocasa import _resolve_geography as _fotocasa_resolve_geography
from etl.connectors.geography import (
    PLACES,
    Place,
    UnresolvableGeographyError,
    _haversine_km,
    nearest_city,
    nearest_place,
    resolve_place,
    unresolvable_scope_key,
)
from etl.connectors.milanuncios import (
    _resolve_geography as _milanuncios_resolve_geography,
)
from etl.connectors.servihabitat import (
    _resolve_geography as _servihabitat_resolve_geography,
)
from etl.connectors.solvia import _resolve_geography as _solvia_resolve_geography
from etl.connectors.vivantial import _resolve_geography as _vivantial_resolve_geography


class TestNearestCity:
    def test_exact_centroid_matches_its_own_city(self):
        assert nearest_city((37.3891, -5.9845)) == "sevilla"

    def test_a_few_km_off_still_resolves_to_the_right_city(self):
        # ~2km north of Sevilla's centroid — well within a search profile's
        # radius being centered slightly off the exact city-center point.
        assert nearest_city((37.407, -5.9845)) == "sevilla"

    def test_far_from_every_known_city_returns_none(self):
        # Lisbon — nowhere near any Spanish municipality, even against the
        # full ~8,248-place gazetteer (issue #169) rather than the original
        # 4-entry table. Confirms expanding coverage didn't also expand the
        # match radius into a neighbouring country.
        assert nearest_city((38.7223, -9.1393)) is None

    def test_picks_the_actually_nearest_place_not_a_bigger_far_one(self):
        # Roughly between Valencia city and Barcelona. Under the old
        # 4-centroid table this matched "valencia" (the nearest of only 4
        # candidates); with the real gazetteer (issue #169) a smaller,
        # genuinely closer coastal municipality wins instead — which is the
        # *correct* behaviour a real gazetteer is supposed to produce, not
        # a regression. This test now asserts the property that matters
        # ("nearest, not first/biggest"), not a specific place name that
        # would be an artifact of exactly which small towns GeoNames
        # happens to carry.
        place = nearest_place((39.6, 0.0), radius_km=100)
        assert place is not None
        assert place.province == "Valencia"
        assert place.name != "barcelona"


class TestNearestPlaceReturnsProvince:
    """Issue #169: some connectors (Solvia's provincia/municipio path,
    Servihabitat's per-province sitemap) need the resolved place's province,
    not just its municipality name.

    Issue #177 (Opus review, M2): every coordinate below used to be copied
    straight out of the gazetteer's OWN row for that municipality — a test
    that can only prove `nearest_place` agrees with itself, not that it
    resolves a REAL point in that town correctly. Replaced with
    independently-sourced coordinates (a real landmark/plaza per town,
    verified against a source that isn't the GeoNames dump this repo's
    gazetteer is itself built from — Wikipedia infoboxes, tourist-office
    pages, or the coordinates the task/PR reviewer measured by hand — not
    latitude/longitude aggregator sites that turned out to just resell the
    identical GeoNames row verbatim). This is exactly what caught the real
    M2 regression: the old self-referential "mijas" coordinate
    (36.53507, -4.67355, the pre-#177 ADM3 admin-reference point) started
    resolving to "fuengirola" once the gazetteer coordinate fix (PR #177)
    moved Mijas's own recorded point ~7.5km closer to the real town —
    invisible under the old test because it only ever compared the
    gazetteer to itself.
    """

    def test_costa_del_sol_towns_resolve_to_malaga_province(self):
        # The owner's stated v1 markets (issue #169 course-correction).
        # Independently-sourced landmark coordinates (issue #177, M2) —
        # each verified to differ from this gazetteer's own row for that
        # town (i.e. not merely round-tripped through a GeoNames reseller).
        for name, coords in {
            # Plaza de la Constitución (Wikipedia).
            "malaga": (36.7211, -4.4220),
            # Wikipedia infobox (36°31'0"N 4°53'0"W) — distinct from this
            # gazetteer's own row (36.51543, -4.88583).
            "marbella": (36.51667, -4.88333),
            # Plaza San Francisco, ~120m from Plaza de las Flores.
            "estepona": (36.42643, -5.1465),
            # Wikipedia infobox (36°32'30"N 4°37'30"W) — distinct from this
            # gazetteer's own row (36.53998, -4.62473).
            "fuengirola": (36.54167, -4.625),
            # Plaza Costa del Sol.
            "torremolinos": (36.62462, -4.49988),
            # NOTE: kept as a general municipality-area coordinate (not a
            # single landmark pin) — Benalmádena's real municipality spans
            # a coastal strip immediately adjacent to Torremolinos, and
            # every independently-sourced landmark-level coordinate found
            # for it (OSM wiki, Wikidata) lands close enough to that
            # boundary that population-weighted resolution (issue #177, M3)
            # picks Torremolinos instead — a genuine geographic-boundary
            # ambiguity, not a gazetteer-coordinate bug like Mijas's was.
            "benalmadena": (36.58975, -4.54213),
            # Mijas PUEBLO (the actual historic hill town), not the
            # gazetteer's own point — the exact M2 regression case named in
            # the PR review.
            "mijas": (36.59556, -4.63722),
        }.items():
            place = nearest_place(coords)
            assert place is not None, f"{name} did not resolve to any place"
            assert place.name == name
            assert place.province == "Malaga"

    def test_sevilla_metro_belt_resolves_to_sevilla_province(self):
        # Independently-sourced landmark coordinates (issue #177, M2).
        for name, coords in {
            "sevilla": (37.388218, -5.995534),  # Plaza Nueva (Wikidata).
            # The task/PR reviewer's own measured Dos Hermanas centroid —
            # also the exact point of the Dos Hermanas regression case (see
            # TestDosHermanasRegression below).
            "dos hermanas": (37.283689, -5.9226718),
            "alcala de guadaira": (37.333940, -5.849137),  # Plaza del Duque.
            "tomares": (37.375855, -6.045006),
        }.items():
            place = nearest_place(coords)
            assert place is not None, f"{name} did not resolve to any place"
            assert place.name == name
            assert place.province == "Sevilla"


class TestNearestCityRadiusBounding:
    """Issue #71 review finding: a profile's own radius_km must tighten the
    match, not just the fixed _MAX_MATCH_DISTANCE_KM ceiling. Issue #169
    note: with the expanded gazetteer, the point this test uses (~13km south
    of Madrid, roughly Getafe's real-world offset) now resolves to Getafe
    ITSELF at every radius, because Getafe is a real gazetteer entry now —
    which is exactly the outcome this whole test class exists to want
    ("don't misattribute a nearby town to a bigger neighbour"). The
    surviving, still-meaningful assertion is that a small radius does not
    reach all the way to the much-more-distant Madrid centroid, tested with
    a point that genuinely has no gazetteer entry of its own nearby.
    """

    # Open countryside roughly equidistant between small villages, tuned to
    # be within the old 40km ceiling of Madrid's centroid (40.4168,
    # -3.7038) but not within a tight radius of any single known place.
    _REMOTE_COUNTRYSIDE_NEAR_MADRID = (40.05, -3.95)

    def test_wide_radius_reaches_a_known_place(self):
        # A wide-enough radius (30km) does reach at least the nearest real
        # gazetteer entry from this remote point.
        assert (
            nearest_city(self._REMOTE_COUNTRYSIDE_NEAR_MADRID, radius_km=30) is not None
        )

    def test_tight_radius_refuses_to_match_anything_far_away(self):
        # 1km is tighter than the distance to literally every gazetteer
        # entry from this deliberately-chosen empty-countryside point.
        assert nearest_city(self._REMOTE_COUNTRYSIDE_NEAR_MADRID, radius_km=1) is None

    def test_getafe_resolves_to_itself_not_to_madrid(self):
        # The scenario the pre-#169 version of this test was actually
        # guarding against ("don't misattribute Getafe to Madrid just
        # because Madrid is within the fixed ceiling"): with a real
        # gazetteer, Getafe resolves to Getafe, correctly, regardless of
        # radius — there is no longer a "which of two named cities does
        # this ambiguous point belong to" question at all.
        near_getafe = (40.305, -3.7038)
        for radius_km in (None, 0, 5, 20):
            place = nearest_place(near_getafe, radius_km=radius_km)
            assert place is not None
            assert place.name == "getafe", (
                f"radius_km={radius_km}: expected getafe, got {place}"
            )

    def test_non_positive_radius_is_ignored_not_treated_as_zero_tolerance(self):
        # A malformed/zero radius shouldn't make every match impossible —
        # fall back to the ceiling alone, same as radius_km=None.
        assert nearest_city(
            self._REMOTE_COUNTRYSIDE_NEAR_MADRID, radius_km=0
        ) == nearest_city(self._REMOTE_COUNTRYSIDE_NEAR_MADRID)


class TestResolvePlace:
    """Issue #169: `resolve_place` is the shared, must-not-be-silent half of
    every connector's `_resolve_geography`."""

    def test_none_center_resolves_to_none_not_a_failure(self):
        # Nothing to resolve at all — a legitimate no-op, matching
        # scope_key()'s "None means no coverage" contract in base.py.
        scope = ConnectorScope(center=None)
        assert resolve_place(scope) is None

    def test_known_center_resolves_to_a_place(self):
        scope = ConnectorScope(center=(36.51543, -4.88583), radius_km=10)  # Marbella
        place = resolve_place(scope)
        assert isinstance(place, Place)
        assert place.name == "marbella"

    def test_unresolvable_center_raises_not_returns_none(self):
        # Lisbon: a real center point, but not a place resolve_place can
        # identify. This is the core issue #169 fix — this must RAISE, not
        # silently return None the way every connector's discover() used to
        # treat identically to "zero listings found here".
        scope = ConnectorScope(center=(38.7223, -9.1393), radius_km=10)
        with pytest.raises(UnresolvableGeographyError):
            resolve_place(scope)


class TestUnresolvableScopeKey:
    def test_never_none_and_never_collides_with_a_real_key(self):
        scope = ConnectorScope(center=(38.7223, -9.1393), radius_km=10)
        key = unresolvable_scope_key(scope)
        assert key is not None
        assert key.startswith("unresolvable-geography:")

    def test_same_scope_produces_the_same_key(self):
        # Two profiles resolving to the identical unresolvable scope should
        # still dedupe against each other in the orchestrator's
        # seen_scope_keys tracking, same as any other scope_key.
        scope_a = ConnectorScope(center=(38.7223, -9.1393), radius_km=10)
        scope_b = ConnectorScope(center=(38.7223, -9.1393), radius_km=10)
        assert unresolvable_scope_key(scope_a) == unresolvable_scope_key(scope_b)


class TestGazetteerDataQuality:
    """A wrong or missing centroid is worse than an unresolvable one now
    (issue #169): an unresolvable center fails loudly, but a *wrong*
    coordinate silently resolves to the wrong municipality and no exception
    ever fires. `geodata/README.md` documents a manual escape hatch
    (look the row up on geonames.org by its `geonameid`), but that only
    helps once someone already suspects a specific row — these are cheap,
    mechanical checks that catch a whole *class* of bad row automatically
    on every test run, e.g. if a future `scripts/build-es-gazetteer.py`
    regeneration silently changes the upstream feature-code/admin2 parsing.
    """

    # Mainland Spain + Balearics + Canary Islands, generous on every edge —
    # not a tight fit, just enough to catch "this row is actually in
    # France/Portugal/the ocean" (e.g. a swapped lat/lon column, or an
    # admin2 code from a different country leaking through).
    _SPAIN_LAT_RANGE = (27.0, 44.0)
    _SPAIN_LON_RANGE = (-19.0, 5.0)

    def test_every_row_has_coordinates_inside_spain(self):
        offenders = [
            p
            for p in PLACES
            if not (self._SPAIN_LAT_RANGE[0] <= p.lat <= self._SPAIN_LAT_RANGE[1])
            or not (self._SPAIN_LON_RANGE[0] <= p.lon <= self._SPAIN_LON_RANGE[1])
        ]
        assert offenders == [], (
            f"{len(offenders)} gazetteer row(s) fall outside Spain's "
            f"bounding box (first: {offenders[0]!r}) — a swapped lat/lon "
            "or a parsing regression would silently resolve profiles to "
            "the wrong country instead of raising"
        )

    def test_every_row_has_a_non_empty_province(self):
        # build-es-gazetteer.py's province_names.get(admin2, "") defaults
        # to "" for an unrecognized admin2 code rather than raising — a
        # silent-empty-province row would break every connector keyed by
        # province (Solvia, Servihabitat) without ever surfacing as a
        # gazetteer-build failure.
        offenders = [p.name for p in PLACES if not p.province]
        assert offenders == [], (
            f"{len(offenders)} gazetteer row(s) have an empty province: "
            f"{offenders[:10]!r}"
        )

    def test_no_duplicate_name_province_pairs(self):
        # nearest_place() returning the "wrong" of two same-keyed rows
        # would be silently non-deterministic (dict/list ordering) rather
        # than a visible failure — see geodata/README.md's Sevilla/Seville
        # writeup for the exact real-world case this guards.
        seen: dict[tuple[str, str], Place] = {}
        offenders = []
        for p in PLACES:
            key = (p.name, p.province)
            if key in seen:
                offenders.append(key)
            else:
                seen[key] = p
        assert offenders == [], f"duplicate (name, province) rows: {offenders[:10]!r}"

    def test_known_v1_market_towns_have_the_expected_coordinates(self):
        """Pins a handful of the owner's stated v1-market centroids (plus
        Madrid/Barcelona/Valencia, issue #177 N1) to their real-world
        coordinates (independently-sourced landmarks — see
        TestNearestPlaceReturnsProvince's class docstring for provenance)
        so a future gazetteer regeneration that silently shifts one of
        these — a bad upstream row, a mis-mapped admin2 join, a regression
        in `_pick_coordinate`'s locality-vs-ADM3 preference (issue #177) —
        fails a test instead of just quietly searching the wrong hillside.
        Not exhaustive (8,248 rows can't each be hand-pinned); these are the
        specific towns issue #169's course-correction named, plus Spain's
        three largest cities.

        Tolerance tightened from 15km to 3km (issue #177, N1): 15km was
        loose enough that the PR #177 coordinate-quality bug itself (Madrid
        ADM3 8.27km off, Mijas ADM3 7.47km off) would have stayed GREEN
        against this test even before that fix — a tolerance that wide
        wasn't actually testing "is this coordinate right", only "is it on
        the right continent". 3km is comfortably above every post-fix
        gazetteer-vs-independent-source gap measured below (max ~2.1km,
        Sevilla) while still tight enough to catch a real regression back
        toward an ADM3-reference-point-sized error.
        """
        by_name_province = {(p.name, p.province): p for p in PLACES}
        expected = {
            ("malaga", "Malaga"): (36.7211, -4.4220),  # Plaza de la Constitución
            ("marbella", "Malaga"): (36.51667, -4.88333),  # Wikipedia infobox
            ("estepona", "Malaga"): (36.42643, -5.1465),  # Plaza San Francisco
            ("sevilla", "Sevilla"): (37.388218, -5.995534),  # Plaza Nueva
            ("dos hermanas", "Sevilla"): (37.283689, -5.9226718),  # task-measured
            ("madrid", "Madrid"): (40.4168, -3.7038),  # Puerta del Sol
            ("barcelona", "Barcelona"): (41.387016, 2.170047),  # Plaça de Catalunya
            ("valencia", "Valencia"): (39.47000, -0.37639),  # Wikipedia infobox
        }
        for (name, province), (expected_lat, expected_lon) in expected.items():
            place = by_name_province.get((name, province))
            assert place is not None, f"{name}/{province} missing from gazetteer"
            distance = _haversine_km(
                (place.lat, place.lon), (expected_lat, expected_lon)
            )
            assert distance < 3, (
                f"{name}/{province}: gazetteer coordinate "
                f"({place.lat}, {place.lon}) is {distance:.2f}km from the "
                f"expected centroid — looks like a wrong/mismapped row, or "
                f"a regression back toward an ADM3 admin-reference point "
                f"(issue #177)"
            )


class TestPopulationWeightedResolution:
    """Issue #177 (Opus review of #169), M3: plain nearest-neighbour is
    population-blind, so a point genuinely inside a big city can resolve to
    a much smaller, unrelated neighbouring municipality whose centroid
    happens to be marginally closer — and that smaller municipality is
    typically NOT in any connector's own `_CITY_SLUGS`-equivalent coverage
    table, so the scope silently reads as "no coverage" even though the
    point is squarely inside a city every connector DOES cover (Barcelona,
    Valencia, Madrid are all in every connector's table).

    Every coordinate here is independently-sourced (a real neighbourhood/
    landmark, not the gazetteer's own row for the winning OR losing
    municipality — see TestNearestPlaceReturnsProvince's docstring for the
    general provenance approach), and the pre-fix "wrong" answer for each
    is a real case measured against the live gazetteer during the PR #177
    review, not a hypothetical.
    """

    def test_barcelona_sant_marti_resolves_to_barcelona_not_a_small_neighbour(self):
        # Sant Martí metro station, Barcelona (independently-sourced —
        # latitude.to). Pre-fix, this resolved to "sant adria de besos"
        # (pop 34,482) — a real, separate municipality bordering Barcelona
        # to the north — instead of "barcelona" (pop 1,620,943), even
        # though the point is inside Barcelona's own city limits.
        place = nearest_place((41.4172, 2.1923))
        assert place is not None
        assert place.name == "barcelona"
        assert place.province == "Barcelona"

    def test_valencia_benimaclet_resolves_to_valencia_not_a_small_neighbour(self):
        # Benimaclet, a neighbourhood inside the city of Valencia
        # (independently-sourced — Wikipedia infobox for the Benimaclet
        # suburb article). Pre-fix, this resolved to "alboraya" (pop
        # 23,228) — a real, separate municipality immediately north of
        # Valencia — instead of "valencia" (pop 797,028).
        place = nearest_place((39.48715, -0.35662))
        assert place is not None
        assert place.name == "valencia"
        assert place.province == "Valencia"

    def test_madrid_vallecas_resolves_to_madrid_not_a_small_neighbour(self):
        # Vallecas Stadium, in Madrid's Puente de Vallecas district
        # (independently-sourced — Wikipedia infobox). Named in the PR
        # #177 review as one of the real cases a population-blind
        # nearest-neighbour gets wrong (Coslada, pop 81,860, is a real
        # separate municipality east of Madrid).
        place = nearest_place((40.39194, -3.65889))
        assert place is not None
        assert place.name == "madrid"
        assert place.province == "Madrid"

    def test_without_population_weighting_sant_marti_would_misresolve(
        self, monkeypatch
    ):
        """Proves the population bias is actually load-bearing for the
        Sant Martí case above, not just an artifact of the PR #177
        coordinate-quality fix alone: with the weight zeroed out (plain
        haversine nearest-neighbour, the pre-#177-M3 behaviour), the exact
        same point resolves to the wrong, smaller municipality."""
        monkeypatch.setattr(geography, "_POPULATION_WEIGHT_KM", 0.0)
        place = nearest_place((41.4172, 2.1923))
        assert place is not None
        assert place.name == "sant adria de besos", (
            "test assumption stale — the unweighted nearest place for this "
            "point is no longer sant adria de besos; re-verify the "
            "population-weighting fix is still doing real work here"
        )

    def test_without_population_weighting_benimaclet_would_misresolve(
        self, monkeypatch
    ):
        """Same proof as above, for the Valencia/Benimaclet case."""
        monkeypatch.setattr(geography, "_POPULATION_WEIGHT_KM", 0.0)
        place = nearest_place((39.48715, -0.35662))
        assert place is not None
        assert place.name == "alboraya", (
            "test assumption stale — the unweighted nearest place for this "
            "point is no longer alboraya; re-verify the population-"
            "weighting fix is still doing real work here"
        )

    def test_getafe_still_beats_madrid_despite_populations_weighting(self):
        """The population bias must not overcorrect: Getafe (pop 180,747)
        is its own real, distinct, genuinely-closer municipality and must
        still beat Madrid (pop 3,233,527) at a point centered on Getafe,
        even though Madrid's much larger population credit is exactly the
        kind of thing that could wrongly swallow a smaller close neighbour
        if the weighting constant were too large. Independently-sourced —
        Getafe's general coordinate (geodatos.net), not the gazetteer's own
        row."""
        place = nearest_place((40.30472, -3.73111))
        assert place is not None
        assert place.name == "getafe"

    def test_distant_small_town_still_beats_a_far_away_big_city(self):
        """The population bias is bounded: it can change which of several
        NEARBY places wins, but a big city's credit is far too small to
        reach out and beat a genuinely local match many tens of km away.
        Same point/assertion as TestNearestCity's
        test_picks_the_actually_nearest_place_not_a_bigger_far_one, kept
        here to make explicit that population weighting doesn't regress it."""
        place = nearest_place((39.6, 0.0), radius_km=100)
        assert place is not None
        assert place.province == "Valencia"
        assert place.name != "barcelona"


class TestDosHermanasRegression:
    """The real-world regression case measured on the live demo (issue
    #177 PR description): a profile centered on Dos Hermanas at a 7km
    radius returned ZERO candidates from 238 ingested properties, because
    every connector's own coverage-resolution snapped the point to
    "sevilla" (~13km away) instead of "dos hermanas" (~0.2km away) — the
    profile's own 7km filter then correctly excluded every Sevilla-scoped
    result, but the crawl itself had already fetched the wrong town.

    Coordinate is the task-measured real Dos Hermanas centroid
    (37.283689, -5.9226718) — independently sourced, not copied from this
    gazetteer's own row (also cross-checked against
    TestNearestPlaceReturnsProvince and test_known_v1_market_towns_have_
    the_expected_coordinates above, which pin the same point for a
    different purpose)."""

    _DOS_HERMANAS_REAL_CENTER = (37.283689, -5.9226718)
    _PROFILE_RADIUS_KM = 7.0

    def test_dos_hermanas_at_7km_radius_resolves_to_dos_hermanas_not_sevilla(self):
        scope = ConnectorScope(
            center=self._DOS_HERMANAS_REAL_CENTER, radius_km=self._PROFILE_RADIUS_KM
        )
        place = resolve_place(scope)
        assert place is not None, (
            "a 7km-radius profile centered on a real, gazetteer-covered "
            "town must resolve to something, not raise as unresolvable"
        )
        assert place.name == "dos hermanas"
        assert place.province == "Sevilla"
        # Locks in the PR #177 coordinate-quality fix specifically (not
        # just "resolves to the right name", which the pre-#177 ADM3 row
        # already happened to do by a comfortable margin in this repo's
        # gazetteer — the production case's much worse "13km away, snapped
        # to Sevilla" outcome traces to the ORIGINAL pre-#169 4-entry
        # CITY_CENTROIDS dict, not this gazetteer's row): the resolved
        # point must be genuinely close to the real town, not just closER
        # than Sevilla. Pre-#177 (ADM3 reference point), this gazetteer's
        # own "dos hermanas" row was 4.8km from this real center; post-fix
        # it's ~0.18km.
        distance_from_real = _haversine_km(
            (place.lat, place.lon), self._DOS_HERMANAS_REAL_CENTER
        )
        assert distance_from_real < 1.0, (
            f"gazetteer 'dos hermanas' coordinate is {distance_from_real:.2f}km "
            "from the real town center — looks like a regression back "
            "toward an ADM3 admin-reference point (issue #177)"
        )

    def test_sevilla_centroid_is_too_far_for_the_7km_radius_to_reach(self):
        """Confirms the actual mechanism of the pre-fix bug: Sevilla's own
        centroid is genuinely outside a 7km radius from the real Dos
        Hermanas point, so a correct implementation MUST prefer Dos
        Hermanas — there is no legitimate reading under which Sevilla was
        ever the right answer for this scope."""
        sevilla = next(p for p in PLACES if p.name == "sevilla")
        distance = _haversine_km(
            self._DOS_HERMANAS_REAL_CENTER, (sevilla.lat, sevilla.lon)
        )
        assert distance > self._PROFILE_RADIUS_KM, (
            f"test assumption stale — Sevilla is only {distance:.1f}km from "
            "the real Dos Hermanas point, no longer outside the profile's "
            "own 7km radius"
        )

    def test_fotocasa_resolves_dos_hermanas_scope_to_its_own_slug(self):
        """The connector-level half of the same regression: Fotocasa's own
        `_resolve_geography` (which every real crawl actually calls) must
        land on "dos-hermanas", not silently fall through to Sevilla's
        slug or to None."""
        scope = ConnectorScope(
            center=self._DOS_HERMANAS_REAL_CENTER, radius_km=self._PROFILE_RADIUS_KM
        )
        assert _fotocasa_resolve_geography(scope) == "dos-hermanas"


class TestDefaultProfileGeographyResolvesOnEveryConnector:
    """Issue #177 (Opus review), M1: the Dashboard App's own new-profile
    default geography (`dashboard/components/profiles/ProfileForm.tsx`'s
    `DEFAULT_VALUES.scope.geography` — Puerta del Sol, [40.4168, -3.7038],
    radius_km=5) used to hard-fail every one of the five connectors: the
    pre-#177 Madrid gazetteer row was 8.26km away (an ADM3 administrative
    reference point, not the real Puerta del Sol), and `nearest_place`'s
    bound is `min(40, radius_km)` = 5km for this profile — farther than
    that row, so `resolve_place` raised `UnresolvableGeographyError` for
    every connector on a brand-new, never-touched, out-of-the-box profile.

    This class is a straight regression guard for that exact scenario. If
    `ProfileForm.tsx`'s default ever changes, update the coordinates below
    to match — this test intentionally hardcodes them rather than trying
    to parse the TypeScript file from a Python test.
    """

    # Must match dashboard/components/profiles/ProfileForm.tsx's
    # DEFAULT_VALUES exactly.
    _DEFAULT_CENTER = (40.4168, -3.7038)
    _DEFAULT_RADIUS_KM = 5.0

    def _scope(self) -> ConnectorScope:
        return ConnectorScope(
            center=self._DEFAULT_CENTER, radius_km=self._DEFAULT_RADIUS_KM
        )

    def test_default_geography_resolves_to_madrid(self):
        place = resolve_place(self._scope())
        assert place is not None, (
            "the app's own default new-profile geography must resolve to "
            "a real place — a brand-new, never-touched profile must not "
            "hard-fail every connector out of the box"
        )
        assert place.name == "madrid"
        assert place.province == "Madrid"

    def test_default_geography_resolves_on_fotocasa(self):
        assert _fotocasa_resolve_geography(self._scope()) == "madrid-capital"

    def test_default_geography_resolves_on_milanuncios(self):
        assert _milanuncios_resolve_geography(self._scope()) == "madrid"

    def test_default_geography_resolves_on_vivantial(self):
        assert _vivantial_resolve_geography(self._scope()) == "madrid"

    def test_default_geography_resolves_on_solvia(self):
        assert _solvia_resolve_geography(self._scope()) == ("madrid", "madrid")

    def test_default_geography_resolves_on_servihabitat(self):
        assert _servihabitat_resolve_geography(self._scope()) == "madrid"
