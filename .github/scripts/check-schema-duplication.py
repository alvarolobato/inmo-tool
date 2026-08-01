#!/usr/bin/env python3
"""Check etl/schema/init.sql for duplicate CREATE TABLE IF NOT EXISTS blocks."""

import re
import sys
from pathlib import Path

SQL_FILE = Path(__file__).parent.parent.parent / "etl" / "schema" / "init.sql"


def main() -> int:
    sql = SQL_FILE.read_text(encoding="utf-8")
    # Strip single-line comments to avoid false positives from comment lines
    sql_no_comments = re.sub(r"--[^\n]*", "", sql)
    tables = re.findall(
        r"CREATE TABLE IF NOT EXISTS (\w+)", sql_no_comments, re.IGNORECASE
    )
    seen: dict[str, int] = {}
    duplicates = []
    for name in tables:
        key = name.lower()
        if key in seen:
            duplicates.append(name)
        seen[key] = seen.get(key, 0) + 1
    if duplicates:
        for name in duplicates:
            print(
                f"DUPLICATE: CREATE TABLE IF NOT EXISTS {name}"
                f" appears more than once in init.sql"
            )
        return 1
    print("Schema duplication check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
