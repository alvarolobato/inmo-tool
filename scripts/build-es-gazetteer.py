#!/usr/bin/env python3
"""Regenerate etl/connectors/geodata/es_places.csv from GeoNames' raw dump.

Issue #169: `geography.py` used to hard-code four city centroids (Madrid,
Sevilla, Barcelona, Valencia) in a Python dict. The owner rejected a bigger
hand-curated table too ("why do you need to do anything ad-hoc per area?")
-- the fix is a real, data-driven gazetteer of Spanish municipalities, not a
longer manually-typed list. This script builds that gazetteer from GeoNames'
free, CC-BY-4.0-licensed country dump, so re-running it (e.g. when GeoNames
refreshes its data, or municipality boundaries change) is a mechanical
download-and-run, not a re-curation exercise.

Source data (fetch fresh before running):
    https://download.geonames.org/export/dump/ES.zip        -> ES.txt
    https://download.geonames.org/export/dump/admin2Codes.txt

License: CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/) --
attribution requirement satisfied by geodata/README.md.

Usage:
    curl -O https://download.geonames.org/export/dump/ES.zip
    unzip ES.zip ES.txt
    curl -O https://download.geonames.org/export/dump/admin2Codes.txt
    python3 scripts/build-es-gazetteer.py ES.txt admin2Codes.txt \\
        etl/connectors/geodata/es_places.csv

Feature codes that define WHICH municipalities exist (see
https://www.geonames.org/export/codes.html) -- unchanged by the PR #177
coordinate-quality fix below, which only touches which POINT a kept
municipality is recorded at, never which municipalities are kept:
    ADM3   third-order administrative division -- Spain's "municipio" level;
           ~8124 of Spain's ~8131 municipios have one.
    PPLC   capital of the country (Madrid).
    PPLA   seat of a first-order admin division (Comunidad Autonoma
           capital, e.g. Sevilla for Andalucia) -- some of these have NO
           separate ADM3 record (Sevilla is one), so PPLA must be unioned
           in, not just ADM3, or the gazetteer would silently be missing
           some of Spain's largest cities.
    PPLA2  seat of a second-order admin division (provincial capital, e.g.
           Malaga -- which is a province capital but not a CCAA capital).
    PPLA3  seat of a third-order admin division.
    PPLA4  seat of a fourth-order admin division.
Excluded from EXISTENCE (never introduce a gazetteer row on their own):
    PPL    plain populated place (villages/hamlets) -- too granular for
           "which municipality is a real-estate search profile centered
           on", and not what a portal's own geography filter searches by.
           PR #177: still consulted as a COORDINATE-ONLY fallback for an
           already-kept municipality that has no PPLC/PPLA*/ADM3 locality
           alternative -- see `_pick_coordinate` below.
    PPLX   a district *within* a city (e.g. a barrio) -- not an
           independently searchable municipality.
    PPLQ/PPLW/PPLH/PPLCH  abandoned/destroyed/historical -- not a real,
           current search target.

Which (name, province) key survives when more than one kept feature code
resolves to it (e.g. Madrid is both ADM3 and PPLC): the more "official
municipality" designation wins (ADM3 first) for NAME/PROVINCE/POPULATION --
unchanged from the original script. See `_pick_coordinate`'s docstring for
why the COORDINATE that row carries is a separate decision, changed by PR
#177.
"""

from __future__ import annotations

import csv
import math
import re
import sys

_PROVINCE_PREFIX_RE = re.compile(r"^(Provincia d[ae]|Province of)\s+", re.IGNORECASE)

# Defines municipality EXISTENCE (unchanged from the original script) --
# NAME, PROVINCE, and POPULATION for a kept (name, province) key all come
# from whichever of these rows wins this priority order.
_KEEP_FEATURE_CODES = ("ADM3", "PPLC", "PPLA", "PPLA2", "PPLA3", "PPLA4")
_EXISTENCE_PRIORITY = {code: i for i, code in enumerate(_KEEP_FEATURE_CODES)}

# Issue #177 (Opus review of #169's gazetteer, M1/M3): GeoNames' `ADM3`
# coordinate is a reference point for the *administrative division's
# boundary*, not necessarily anywhere near where the population actually
# is -- verified for every one of the review's measured offsets (up to
# 8.27km for Madrid) by diffing the ADM3 row against GeoNames' OWN
# populated-place ("seat of division") row for the identical municipality:
# Madrid ADM3 vs PPLC = 8.27km apart, Barcelona ADM3 vs PPLA = 4.93km,
# Malaga ADM3 vs PPLA2 = 4.74km, Marbella ADM3 vs PPLA3 = 0.11km, Mijas
# ADM3 vs PPLA3 = 7.47km. In every measured case the *locality* record
# (PPLC/PPLA/PPLA2/PPLA3/PPLA4 -- an inhabited place with a name and a
# population, not an administrative boundary's arbitrary reference point)
# sits far closer to where a human would actually point on a map for that
# town. `_KEEP_FEATURE_CODES`/`_EXISTENCE_PRIORITY` above still decide
# which municipalities exist and their name/province/population (ADM3
# first, unchanged) -- this is a strictly separate, coordinate-only
# preference: prefer any locality-type row over the plain administrative
# row for LAT/LON, when both exist for the same municipality (matched by
# GeoNames' `admin3 code`, the real per-municipio INE code -- see
# `_pick_coordinate`'s docstring for why that and not name/province text).
_LOCALITY_CODES = ("PPLC", "PPLA", "PPLA2", "PPLA3", "PPLA4")
_ADMIN_BOUNDARY_CODE = "ADM3"

# Coordinate-only fallback, one tier below every code above: a plain `PPL`
# row is excluded from `_KEEP_FEATURE_CODES` (it must never introduce a new
# gazetteer row for a village GeoNames didn't tag as any municipality's
# admin seat -- see the module docstring's "Excluded from EXISTENCE"), but
# when it shares the EXACT `admin3 code` of an already-kept
# municipality that has no PPLC/PPLA* alternative either (Alcala de
# Guadaira is exactly this case: ADM3 is 7.18km from the real town, and
# GeoNames only classifies the actual town center as plain `PPL`, not any
# admin-seat tier), it is clearly the same real settlement under-classified
# by GeoNames' admin hierarchy, not a different place that happens to share
# a name. Used for coordinate correction only, same as the locality codes.
_LOCALITY_FALLBACK_CODE = "PPL"

_COORD_CANDIDATE_CODES = _LOCALITY_CODES + (_LOCALITY_FALLBACK_CODE,)
_COORD_PRIORITY = {code: i for i, code in enumerate(_COORD_CANDIDATE_CODES)}

# Defense-in-depth only (see `_pick_coordinate`): the real anti-homonym
# guard is matching on GeoNames' `admin3 code` column (row[12] -- NOT the
# `admin2 code` at row[11], which is only Spain's PROVINCE and shared by
# every municipio in it). `admin3 code` carries Spain's actual per-municipio
# INE code (e.g. "29070" for Mijas, "28079" for Madrid) for every row this
# script reads, including the locality-type rows, not just ADM3 ones -- two
# municipios never share this code, so a same-admin3-code candidate is
# *guaranteed* to be the same municipality regardless of how far its point
# is from the ADM3 one (verified against a live GeoNames dump: every
# override this script applies has matching admin3 codes on both sides;
# see docs in geodata/README.md). This distance check only guards the
# admin3-code match itself failing open (a malformed/missing field in some
# future dump) -- kept generous (Spain's largest rural municipios can
# genuinely span >20km end to end) rather than tuned to reject anything.
_MAX_COORD_OVERRIDE_DRIFT_KM = 100.0

# GeoNames data-quality fix, not area curation: geonameid 6361046 (the ADM3
# record for Sevilla, pop 702355) has its own `name`/`asciiname` fields set
# to the English exonym "Seville" instead of "Sevilla" -- verified this is
# the ONLY such case among every kept-feature-code row with population >=
# 50,000 (every other accented name differs from its asciiname only by
# accent-stripping, e.g. "Malaga" from "Málaga", which is correct). Left
# uncorrected, this ADM3 record and the separate PPLA "Sevilla" record
# (pop 686741, same city) would NOT collide in the (name, province) dedup
# below -- both would survive as distinct gazetteer rows, and any
# connector's `_CITY_SLUGS` table (keyed on the Spanish "sevilla") would
# silently miss every point nearest_place() resolves to "seville" instead,
# reintroducing issue #169's exact silent-zero-coverage bug for one of the
# owner's two named v1 markets. Keyed by geonameid (GeoNames' own stable
# id), not by name, so this can't accidentally match an unrelated row.
# PR #177: this override is now doubly load-bearing -- without it, the
# "seville"-named ADM3 row wouldn't collide with the "sevilla"-named PPLA
# row at all, so the coordinate-preference logic below would never even
# get a chance to compare them for the same key.
_NAME_OVERRIDES_BY_GEONAMEID: dict[str, str] = {"6361046": "sevilla"}


def _haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    # Duplicated from etl/connectors/geography.py deliberately: this script
    # is a standalone regeneration tool (stdlib only, no etl/ import), run
    # by hand against a freshly downloaded dump, not part of any runtime
    # import path.
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def _load_province_names(admin2_codes_path: str) -> dict[str, str]:
    province_names: dict[str, str] = {}
    with open(admin2_codes_path, encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 3 or not parts[0].startswith("ES."):
                continue
            _, _admin1, admin2 = parts[0].split(".")
            name_ascii = _PROVINCE_PREFIX_RE.sub("", parts[2]).strip()
            province_names[admin2] = name_ascii
    return province_names


def _pick_coordinate(
    admin_row: tuple[str, ...],
    coord_candidates_by_admin3: dict[str, list[tuple[str, ...]]],
) -> tuple[str, str, str, str]:
    """Return (lat, lon, feature_code, geonameid) for the final gazetteer row.

    `admin_row` is the (name, lat, lon, province, population, feature_code,
    geonameid, admin3) tuple that won `_EXISTENCE_PRIORITY` for this (name,
    province) key -- unchanged, still decides whether this municipality
    exists at all and its name/province/population. This function ONLY
    decides which point to record it at (issue #177 M1/M3 fix, see the
    module docstring / `_LOCALITY_CODES` comment above for why).

    If `admin_row` itself is already a locality-type record (no separate
    ADM3 row existed to collide with it -- Sevilla's PPLA case), its own
    coordinate is already the best available and is returned unchanged.
    Otherwise (`admin_row` is the plain `ADM3` boundary row), look for the
    best locality-type candidate sharing the exact same GeoNames `admin3
    code` (Spain's real per-municipio INE code) -- preferring
    PPLC/PPLA/PPLA2/PPLA3/PPLA4 (in that order) over a plain `PPL` fallback
    -- and use ITS coordinate instead.

    Matching on `admin3 code`, not on (name, province) text and NOT on the
    coarser `admin2 code` (which is only Spain's province and is shared by
    every municipio in it), is deliberate and is the actual anti-homonym
    guard: two municipios never share an admin3 code, so a same-admin3-code
    match is guaranteed to be the exact same municipality, however far
    apart the two GeoNames rows' points are -- there is no "this might be a
    different village that happens to share a name" case left to guard
    against once the join key itself encodes municipality identity.
    `_MAX_COORD_OVERRIDE_DRIFT_KM` is kept as a defense-in-depth sanity
    check only, in case a future GeoNames dump has a malformed admin3 field
    that still happens to match by accident.
    """
    name, lat, lon, province, _population, feature_code, geonameid, admin3 = admin_row
    if feature_code != _ADMIN_BOUNDARY_CODE:
        return lat, lon, feature_code, geonameid

    candidates = coord_candidates_by_admin3.get(admin3)
    if not candidates:
        return lat, lon, feature_code, geonameid

    best_candidate = min(candidates, key=lambda r: _COORD_PRIORITY[r[5]])
    admin_point = (float(lat), float(lon))
    candidate_point = (float(best_candidate[1]), float(best_candidate[2]))
    drift_km = _haversine_km(admin_point, candidate_point)
    if drift_km > _MAX_COORD_OVERRIDE_DRIFT_KM:
        print(
            f"warning: {name}/{province}: {best_candidate[5]} candidate "
            f"(admin3={admin3}) is {drift_km:.1f}km from the ADM3 point "
            f"(over the {_MAX_COORD_OVERRIDE_DRIFT_KM}km sanity threshold) "
            f"-- keeping the ADM3 coordinate; check geonameid "
            f"{best_candidate[6]} by hand",
            file=sys.stderr,
        )
        return lat, lon, feature_code, geonameid

    return (
        best_candidate[1],
        best_candidate[2],
        best_candidate[5],
        best_candidate[6],
    )


def build(es_dump_path: str, admin2_codes_path: str) -> list[tuple[str, ...]]:
    province_names = _load_province_names(admin2_codes_path)
    existence_candidates: list[tuple[str, ...]] = []
    # Keyed by GeoNames' `admin3 code` (the actual per-municipio INE code,
    # e.g. "29070" for Mijas) -- see `_pick_coordinate`'s docstring for why
    # this, and not `admin2`/province, is the anti-homonym join key.
    coord_candidates_by_admin3: dict[str, list[tuple[str, ...]]] = {}

    with open(es_dump_path, encoding="utf-8") as f:
        for row in csv.reader(f, delimiter="\t"):
            feature_code = row[7]
            is_existence_code = feature_code in _EXISTENCE_PRIORITY
            is_coord_fallback_code = feature_code == _LOCALITY_FALLBACK_CODE
            if not is_existence_code and not is_coord_fallback_code:
                continue

            geonameid = row[0]
            asciiname, lat, lon, admin2, admin3, population = (
                row[2],
                row[4],
                row[5],
                row[11],
                row[12],
                row[14] or "0",
            )
            if not asciiname or not lat or not lon or not admin2 or not admin3:
                continue
            asciiname = _NAME_OVERRIDES_BY_GEONAMEID.get(geonameid, asciiname)
            record = (
                asciiname.strip().lower(),
                lat,
                lon,
                province_names.get(admin2, ""),
                population,
                feature_code,
                geonameid,
                admin3,
            )

            if is_existence_code:
                existence_candidates.append(record)
            # Every locality-type row (existence codes that are also
            # locality codes, plus the PPL fallback) is also a coordinate
            # candidate for its own `admin3` municipio code -- including
            # PPLC/PPLA/PPLA2/PPLA3/PPLA4 rows, so `_pick_coordinate` can
            # find them even though they didn't win `_EXISTENCE_PRIORITY`.
            if feature_code in _COORD_PRIORITY:
                coord_candidates_by_admin3.setdefault(admin3, []).append(record)

    best: dict[tuple[str, str], tuple[str, ...]] = {}
    for row in existence_candidates:
        key = (row[0], row[3])
        existing = best.get(key)
        if (
            existing is None
            or _EXISTENCE_PRIORITY[row[5]] < _EXISTENCE_PRIORITY[existing[5]]
        ):
            best[key] = row

    final_rows = []
    for key, admin_row in best.items():
        lat, lon, feature_code, geonameid = _pick_coordinate(
            admin_row, coord_candidates_by_admin3
        )
        name, _lat, _lon, province, population, _fc, _gid, _admin3 = admin_row
        final_rows.append(
            (name, lat, lon, province, population, feature_code, geonameid)
        )

    return sorted(final_rows, key=lambda r: (r[0], r[3]))


def main() -> None:
    if len(sys.argv) != 4:
        print(
            "usage: build-es-gazetteer.py <ES.txt> <admin2Codes.txt> <output.csv>",
            file=sys.stderr,
        )
        raise SystemExit(2)
    es_dump_path, admin2_codes_path, output_path = sys.argv[1:4]
    rows = build(es_dump_path, admin2_codes_path)
    with open(output_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(
            [
                "name",
                "lat",
                "lon",
                "province",
                "population",
                "feature_code",
                "geonameid",
            ]
        )
        writer.writerows(rows)
    print(f"wrote {len(rows)} rows to {output_path}")


if __name__ == "__main__":
    main()
