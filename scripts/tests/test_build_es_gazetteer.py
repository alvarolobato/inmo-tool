"""Unit tests for scripts/build-es-gazetteer.py (PR #177 round 3, must-fix 2
and must-fix 4).

The module lives at a hyphenated filename (a deliberate standalone,
stdlib-only regeneration tool — see its own docstring), so it can't be
imported with a normal `import` statement; loaded via importlib below,
same technique the module's own docstring assumes a maintainer would use
to run it by hand.

Round-2 review found the shipped gazetteer had two real, measured bugs that
542 passing tests never caught:

- must-fix 2: `_pick_coordinate` broke ties between same-tier coordinate
  candidates by raw GeoNames dump row order (`min()` is stable), not by
  which candidate is actually closer to the municipality's own ADM3
  reference point — non-deterministic under dump reordering, and directly
  responsible for shipped errors up to 158.8km (Arboli) and 52.1km
  (L'Ametlla del Valles). It also let a wrongly-named, but higher-tier,
  same-admin3 settlement (a real but different place, e.g. Talayuela's
  admin3 also carrying "Pueblonuevo de Miramontes") win over a
  correctly-named lower-tier candidate purely on tier rank.
- must-fix 4: GeoNames' own `asciiname` column is occasionally internally
  inconsistent for the exact same accented `name` (a diaeresis
  transliteration glitch — 15 real admin3 codes measured, e.g. Güevéjar's
  ADM3 row asciinames itself "Gueevejar", its PPLA3 row "Guevejar"), which
  under the original (name, province)-keyed dedup let one real municipality
  split into two gazetteer rows, one of them a name no connector's
  `_CITY_SLUGS`-equivalent table will ever hold.

Each test below is written to demonstrate its fix is load-bearing: the
"before" behaviour is reproduced inline (a literal `min(candidates,
key=lambda r: _COORD_PRIORITY[r[5]])`, or a `(row[0], row[3])` dedup key)
so a regression back to it fails these tests without needing to check out
an old commit.
"""

from __future__ import annotations

import csv
import importlib.util
from pathlib import Path

import pytest

_MODULE_PATH = Path(__file__).resolve().parents[1] / "build-es-gazetteer.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("build_es_gazetteer", _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gaz = _load_module()


def _write_dump(path: Path, rows: list[tuple]) -> None:
    """Write GeoNames-format rows (15 tab-separated columns; only the ones
    the build script reads need to be meaningful — the rest are padded
    empty) to `path`."""
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f, delimiter="\t")
        for row in rows:
            writer.writerow(row)


def _geoname_row(
    geonameid: str,
    name: str,
    asciiname: str,
    lat: str,
    lon: str,
    feature_code: str,
    admin2: str,
    admin3: str,
    population: str = "0",
) -> tuple:
    # Columns: 0 geonameid, 1 name, 2 asciiname, 3 alternatenames, 4 lat,
    # 5 lon, 6 feature class, 7 feature code, 8 country code, 9 cc2,
    # 10 admin1, 11 admin2, 12 admin3, 13 admin4, 14 population.
    return (
        geonameid,
        name,
        asciiname,
        "",
        lat,
        lon,
        "P",
        feature_code,
        "ES",
        "",
        "99",
        admin2,
        admin3,
        "",
        population,
    )


def _write_admin2(path: Path, mapping: dict[str, str]) -> None:
    """mapping: admin2 code -> province name. Format matches
    `_load_province_names`'s parser: "ES.<admin1>.<admin2>\\tName\\t...".
    """
    with path.open("w", encoding="utf-8") as f:
        for admin2, province in mapping.items():
            f.write(f"ES.99.{admin2}\t{province}\t{province}\t0\n")


class TestFoldAscii:
    """must-fix 4: canonical NFKD-based ascii folding, replacing trust in
    GeoNames' own (occasionally inconsistent) `asciiname` column."""

    @pytest.mark.parametrize(
        "accented,expected",
        [
            ("Güevéjar", "Guevejar"),
            ("Nigüelas", "Niguelas"),
            ("Agüimes", "Aguimes"),
            ("Sigüenza", "Siguenza"),
            ("Antigüedad", "Antiguedad"),
            ("Málaga", "Malaga"),
            ("Oñati", "Onati"),
        ],
    )
    def test_strips_diacritics_to_the_correct_modern_name(self, accented, expected):
        assert gaz._fold_ascii(accented) == expected

    def test_never_produces_the_doubled_vowel_artifact(self):
        # The actual bug shape found in the live dump: GeoNames' own
        # asciiname for the ADM3 row was "Gueevejar" (an extra "e" after
        # the diaeresis) while the PPLA3 row for the SAME accented name
        # was correctly "Guevejar". Our own fold must never reproduce that,
        # regardless of which row it's computed from.
        assert gaz._fold_ascii("Güevéjar") != "Gueevejar"


class TestNameTokens:
    """must-fix 2: the name-plausibility filter `_pick_coordinate` uses to
    reject a same-admin3 candidate that is a real but differently-named
    place, not the municipality itself."""

    def test_identical_names_overlap(self):
        assert gaz._name_tokens("Talayuela") & gaz._name_tokens("talayuela")

    def test_stopwords_alone_do_not_create_a_false_match(self):
        # "Cabañas de la Sagra" and "Cabañas de Yepes" are different, real
        # municipalities that merely share "cabanas" and the stopword "de" —
        # only the real place-name token should count.
        a = gaz._name_tokens("cabanas de la sagra")
        b = gaz._name_tokens("cabanas de yepes")
        assert a & b == {"cabanas"}

    def test_unrelated_settlement_does_not_match(self):
        # The real Talayuela case: a different-named satellite settlement
        # sharing the same admin3 code must not token-match.
        assert not (
            gaz._name_tokens("talayuela")
            & gaz._name_tokens("pueblonuevo de miramontes")
        )

    def test_fused_municipality_name_matches_a_component_village(self):
        # The real Santiago-Pontones case: the municipality's own fused
        # name should match a candidate named after just one of its two
        # historical component villages.
        assert gaz._name_tokens("santiago-pontones") & gaz._name_tokens("pontones")


class TestPickCoordinateTieBreak:
    """must-fix 2: distance-to-ADM3-point tie-break, replacing the old
    `min(candidates, key=lambda r: _COORD_PRIORITY[r[5]])` (stable-sort,
    so ties silently resolved to file order)."""

    def _admin_row(self, name="l'ametlla del valles", lat="41.67863", lon="2.25072"):
        # (name, lat, lon, province, population, feature_code, geonameid, admin3)
        return (name, lat, lon, "Barcelona", "8190", "ADM3", "6356043", "08005")

    def test_picks_the_closer_same_tier_candidate_regardless_of_list_order(self):
        # The real L'Ametlla del Valles case: two identically-named PPL
        # candidates for the same admin3, ~65km apart; the correct one
        # (close to the ADM3 point) must win regardless of which comes
        # first in the candidate list (i.e. regardless of raw dump order).
        close = (
            "l'ametlla del valles",
            "41.66667",
            "2.26667",
            "Barcelona",
            "7319",
            "PPL",
            "3120006",
            "08005",
        )
        far = (
            "l'ametlla del valles",
            "42.05",
            "1.86667",
            "Barcelona",
            "0",
            "PPL",
            "3120005",
            "08005",
        )
        admin_row = self._admin_row()

        result_close_first = gaz._pick_coordinate(admin_row, {"08005": [close, far]})
        result_far_first = gaz._pick_coordinate(admin_row, {"08005": [far, close]})
        assert result_close_first == result_far_first, (
            "result must not depend on candidate list order"
        )
        assert result_close_first[0] == close[1]
        assert result_close_first[1] == close[2]

    def test_old_stable_min_by_priority_alone_was_order_dependent(self):
        """Demonstrates the bug this replaces: the OLD selection rule
        (`min` by `_COORD_PRIORITY` alone, no distance tie-break) picks
        whichever same-tier candidate is FIRST in the list — i.e. it is
        order-dependent, which is exactly what made gazetteer regeneration
        non-deterministic under dump reordering. If this test ever starts
        failing, it means `_COORD_PRIORITY`-only selection has stopped
        being order-dependent, which would be surprising on its own."""
        close = (
            "l'ametlla del valles",
            "41.66667",
            "2.26667",
            "Barcelona",
            "7319",
            "PPL",
            "3120006",
            "08005",
        )
        far = (
            "l'ametlla del valles",
            "42.05",
            "1.86667",
            "Barcelona",
            "0",
            "PPL",
            "3120005",
            "08005",
        )

        def old_buggy_pick(candidates):
            return min(candidates, key=lambda r: gaz._COORD_PRIORITY[r[5]])

        assert old_buggy_pick([close, far]) != old_buggy_pick([far, close]), (
            "the old rule's order-dependence is what must-fix 2 eliminates"
        )

    def test_rejects_a_higher_tier_candidate_with_a_mismatched_name(self):
        # The real Talayuela case: a PPLA3 candidate ("Pueblonuevo de
        # Miramontes") outranks a PPL candidate by tier, but is a
        # different, real settlement — the name filter must reject it and
        # fall through to the correctly-named PPL candidate instead.
        wrong_name_higher_tier = (
            "pueblonuevo de miramontes",
            "40.0606",
            "-5.37832",
            "Caceres",
            "0",
            "PPLA3",
            "8063157",
            "10180",
        )
        correct_name_lower_tier = (
            "talayuela",
            "39.98701",
            "-5.60982",
            "Caceres",
            "7345",
            "PPL",
            "2510689",
            "10180",
        )
        admin_row = (
            "talayuela",
            "39.99374",
            "-5.6075",
            "Caceres",
            "8303",
            "ADM3",
            "6356875",
            "10180",
        )

        result = gaz._pick_coordinate(
            admin_row,
            {"10180": [wrong_name_higher_tier, correct_name_lower_tier]},
        )
        assert result[3] == correct_name_lower_tier[6], (
            "must pick the correctly-named PPL candidate, not the "
            "higher-tier but wrongly-named PPLA3 one"
        )

    def test_falls_back_to_adm3_point_when_no_candidate_name_matches(self):
        admin_row = (
            "talayuela",
            "39.99374",
            "-5.6075",
            "Caceres",
            "8303",
            "ADM3",
            "6356875",
            "10180",
        )
        only_mismatched = (
            "pueblonuevo de miramontes",
            "40.0606",
            "-5.37832",
            "Caceres",
            "0",
            "PPLA3",
            "8063157",
            "10180",
        )
        lat, lon, feature_code, geonameid = gaz._pick_coordinate(
            admin_row, {"10180": [only_mismatched]}
        )
        assert (lat, lon, feature_code, geonameid) == (
            "39.99374",
            "-5.6075",
            "ADM3",
            "6356875",
        )

    def test_falls_back_to_adm3_point_when_matching_candidate_is_implausibly_far(
        self,
    ):
        # The real Ourol case: a same-admin3, same-NAME candidate whose own
        # coordinate is a GeoNames data error relative to a municipio this
        # small — 76km apart, far beyond any plausible municipio diameter.
        admin_row = (
            "ourol",
            "43.55647",
            "-7.66187",
            "Lugo",
            "1142",
            "ADM3",
            "6359198",
            "27038",
        )
        implausible = (
            "ourol",
            "42.87013",
            "-7.61447",
            "Lugo",
            "1328",
            "PPL",
            "3114745",
            "27038",
        )
        lat, lon, feature_code, geonameid = gaz._pick_coordinate(
            admin_row, {"27038": [implausible]}
        )
        assert (lat, lon, feature_code, geonameid) == (
            "43.55647",
            "-7.66187",
            "ADM3",
            "6359198",
        ), "an implausibly-distant same-name candidate must not override the ADM3 point"


class TestBuildEndToEnd:
    """must-fix 4: `build()`'s admin3-keyed existence dedup + canonical
    ascii folding, exercised through the full CSV-reading pipeline with
    small synthetic dumps (not the full live GeoNames dump — see
    scripts/build-es-gazetteer.py's own docstring for how to regenerate
    against a real one)."""

    def test_ascii_fold_inconsistency_produces_one_row_not_two(self, tmp_path):
        """The real Güevéjar case: ADM3's own GeoNames asciiname
        ("Gueevejar") disagrees with PPLA3's ("Guevejar") for the identical
        accented name and admin3 code. The OLD (name, province)-keyed dedup
        let both survive as separate gazetteer rows (verified: the shipped
        pre-fix CSV had both `gueevejar` and `guevejar` rows at the
        IDENTICAL coordinate, differing only in population — and
        `nearest_place`'s population credit deterministically picked
        whichever had the higher reported population, which was the
        mangled one in every measured case). Admin3-keyed dedup plus
        recomputing the ascii name via `_fold_ascii` must produce exactly
        ONE row, with the correct folded name.
        """
        dump = tmp_path / "ES.txt"
        admin2 = tmp_path / "admin2Codes.txt"
        _write_admin2(admin2, {"GR": "Granada"})
        _write_dump(
            dump,
            [
                _geoname_row(
                    "2516865",
                    "Güevéjar",
                    "Guevejar",
                    "37.25759",
                    "-3.59691",
                    "PPLA3",
                    "GR",
                    "18095",
                    "1943",
                ),
                _geoname_row(
                    "6357714",
                    "Güevéjar",
                    "Gueevejar",
                    "37.25731",
                    "-3.60004",
                    "ADM3",
                    "GR",
                    "18095",
                    "2565",
                ),
            ],
        )
        rows = gaz.build(str(dump), str(admin2))
        names = [r[0] for r in rows]
        assert names.count("guevejar") + names.count("gueevejar") == 1, (
            f"expected exactly one Guevejar-family row, got {names!r} — "
            "the ascii-fold artifact split one municipality into two rows"
        )
        assert "gueevejar" not in names, (
            "the surviving row must use the correctly-folded name, not the "
            "GeoNames asciiname artifact"
        )
        assert "guevejar" in names

    def test_dedup_key_is_admin3_not_name_province(self, tmp_path):
        """Two rows that would have collided under the OLD (name, province)
        key (because they now compute the SAME folded name) but carry
        DIFFERENT admin3 codes must remain two separate real municipalities
        — admin3-keying must not merge genuinely different places that
        happen to share a name in the same province."""
        dump = tmp_path / "ES.txt"
        admin2 = tmp_path / "admin2Codes.txt"
        _write_admin2(admin2, {"C": "Coruna"})
        _write_dump(
            dump,
            [
                _geoname_row(
                    "1",
                    "Cabanas",
                    "Cabanas",
                    "43.42931",
                    "-8.13401",
                    "ADM3",
                    "C",
                    "15015",
                    "100",
                ),
                _geoname_row(
                    "2",
                    "Cabanas",
                    "Cabanas",
                    "43.6",
                    "-7.7",
                    "ADM3",
                    "C",
                    "27038",
                    "200",
                ),
            ],
        )
        rows = gaz.build(str(dump), str(admin2))
        assert len(rows) == 2, (
            "two different admin3 codes must survive as two rows even "
            "though they share a (name, province) key"
        )

    def test_regeneration_is_order_independent(self, tmp_path):
        """must-fix 2's determinism claim, exercised end-to-end: feeding
        the same rows in reverse order must produce byte-identical output."""
        dump = tmp_path / "ES.txt"
        admin2 = tmp_path / "admin2Codes.txt"
        _write_admin2(admin2, {"T": "Tarragona"})
        rows_in = [
            _geoname_row(
                "3129797",
                "Arboli",
                "Arboli",
                "41.23333",
                "-0.95",
                "PPL",
                "T",
                "43015",
                "0",
            ),
            _geoname_row(
                "12217659",
                "Arboli",
                "Arboli",
                "41.24223",
                "0.94873",
                "PPL",
                "T",
                "43015",
                "0",
            ),
            _geoname_row(
                "6361258",
                "Arboli",
                "Arboli",
                "41.23899",
                "0.96372",
                "ADM3",
                "T",
                "43015",
                "129",
            ),
        ]
        _write_dump(dump, rows_in)
        forward = gaz.build(str(dump), str(admin2))
        _write_dump(dump, list(reversed(rows_in)))
        backward = gaz.build(str(dump), str(admin2))
        assert forward == backward
        # And it must pick the CLOSE candidate (12217659, ~1.3km from the
        # ADM3 point), not the far one (3129797, ~160km away via the
        # longitude sign/magnitude error) — the real Arboli bug.
        assert forward[0][6] == "12217659"
