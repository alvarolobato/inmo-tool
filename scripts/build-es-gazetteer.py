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

Feature codes kept (see https://www.geonames.org/export/codes.html):
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
Excluded:
    PPL    plain populated place (villages/hamlets) -- too granular for
           "which municipality is a real-estate search profile centered
           on", and not what a portal's own geography filter searches by.
    PPLX   a district *within* a city (e.g. a barrio) -- not an
           independently searchable municipality.
    PPLQ/PPLW/PPLH/PPLCH  abandoned/destroyed/historical -- not a real,
           current search target.

When more than one kept feature code resolves to the same (name, province)
pair (e.g. Madrid is both ADM3 and PPLC at nearly the same point), the more
"official municipality" designation wins (ADM3 first), so the kept point is
administrative, not an arbitrary duplicate.
"""

from __future__ import annotations

import csv
import re
import sys

_PROVINCE_PREFIX_RE = re.compile(r"^(Provincia d[ae]|Province of)\s+", re.IGNORECASE)

_KEEP_FEATURE_CODES = ("ADM3", "PPLC", "PPLA", "PPLA2", "PPLA3", "PPLA4")
_PRIORITY = {code: i for i, code in enumerate(_KEEP_FEATURE_CODES)}

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
_NAME_OVERRIDES_BY_GEONAMEID: dict[str, str] = {"6361046": "sevilla"}


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


def build(es_dump_path: str, admin2_codes_path: str) -> list[tuple[str, ...]]:
    province_names = _load_province_names(admin2_codes_path)
    candidates: list[tuple[str, ...]] = []
    with open(es_dump_path, encoding="utf-8") as f:
        for row in csv.reader(f, delimiter="\t"):
            feature_code = row[7]
            if feature_code not in _PRIORITY:
                continue
            geonameid = row[0]
            asciiname, lat, lon, admin2, population = (
                row[2],
                row[4],
                row[5],
                row[11],
                row[14] or "0",
            )
            if not asciiname or not lat or not lon:
                continue
            asciiname = _NAME_OVERRIDES_BY_GEONAMEID.get(geonameid, asciiname)
            candidates.append(
                (
                    asciiname.strip().lower(),
                    lat,
                    lon,
                    province_names.get(admin2, ""),
                    population,
                    feature_code,
                    row[0],  # geonameid
                )
            )

    best: dict[tuple[str, str], tuple[str, ...]] = {}
    for row in candidates:
        key = (row[0], row[3])
        existing = best.get(key)
        if existing is None or _PRIORITY[row[5]] < _PRIORITY[existing[5]]:
            best[key] = row
    return sorted(best.values(), key=lambda r: (r[0], r[3]))


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
