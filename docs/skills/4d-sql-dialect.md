# Skill: 4D SQL Dialect Reference

**Use when**: Writing SQL queries against the 4D database, understanding type mappings, looking up function syntax, or troubleshooting query behavior that differs from PostgreSQL/MySQL.

## Related reference docs

- **[`../sample-queries.md`](../sample-queries.md)** — 10-domain ready-to-use SQL cookbook (schema discovery, retail sales, wholesale, stock, customers, payments, margins, transfers, M-prefix filtering, stock movement formula). Reach for this when you need a starting query for any business domain.
- **[`../sql-views.md`](../sql-views.md)** — catalog of 100 4D SQL views (`*_SQL` + `*_BI`) with column counts, domains, and detailed structure for key views (Ventas_SQL 150 cols, Exportaciones_SQL 161 cols with the 34-slot matrix). Use when you need to know which views exist and what columns they expose.
- **[`../schema-discovery.md`](../schema-discovery.md)** — full table inventory by domain (Products, Retail Sales, Customers, Wholesale, Purchasing, Stock, Finance, HR) plus the D-011 extraction session notes. Use when you need a bird's-eye view of the 4D schema or want to locate a table by domain.

---

## SQL Compliance

4D's SQL engine is **SQL-92 compliant** with specific additions and omissions. It is *not* PostgreSQL or MySQL -- many things look familiar but have subtle differences. When in doubt, test with a simple query first.

---

## 1. Data Types

### 4D SQL Type Names

| SQL Type | 4D Native Type | Description |
|----------|---------------|-------------|
| `VARCHAR` | Text (alpha) | Variable-length string |
| `ALPHA_NUMERIC` | Text (alpha) | Synonym for VARCHAR |
| `TEXT` | Text | Variable-length text (larger than VARCHAR) |
| `CLOB` | Text | Character Large Object |
| `BLOB` | Blob | Binary Large Object |
| `BIT` | Boolean | Single bit / boolean |
| `BIT VARYING` | Blob | Variable-length binary |
| `BYTE` | Blob | Binary data |
| `BOOLEAN` | Boolean | True/False |
| `SMALLINT` / `INT16` | Integer (16-bit) | -32,768 to 32,767 |
| `INT` / `INT32` | Long Integer (32-bit) | -2,147,483,648 to 2,147,483,647 |
| `INT64` | Long Integer 64-bit | 64-bit integer (SQL only, converts to Real in 4D language) |
| `NUMERIC` | Real | Decimal number |
| `REAL` | Real | 8-byte floating point |
| `FLOAT` | Real | Synonym for REAL |
| `DOUBLE PRECISION` | Real | Synonym for REAL |
| `TIMESTAMP` | Date + Time | Combined date and time |
| `DURATION` | Time | Time duration |
| `INTERVAL` | Time | Time interval |
| `UUID` | Text (UUID) | Universally unique identifier |
| `PICTURE` | Picture | Image data |
| `OBJECT` | Object (JSON) | JSON object -- requires CAST to VARCHAR for text retrieval |

### 4D Type IDs (from _USER_COLUMNS.DATA_TYPE)

These are the numeric type codes returned by the system tables:

| Type ID | Type Name | Python (p4d) Mapping |
|---------|-----------|---------------------|
| 1 | Boolean | `bool` |
| 3 | Integer (16-bit) | `int` (see **SQL vs native sign** below) |
| 4 | Long Integer (32-bit) | `int` |
| 6 | Real (float) | `float` |
| 8 | Date | `datetime.date` or `str` (YYYY-MM-DD) |
| 9 | Time | `datetime.time` or `str` (HH:MM:SS) |
| 10 | Text | `str` or `bytes` (see gotchas) |
| 12 | Picture/Blob | `bytes` (avoid querying) |
| 18 | Blob | `bytes` |
| 21 | Object (JSON) | `str` (JSON) or `bytes` |

### 16-bit integers over SQL (`DATA_TYPE = 3`, `DATA_LENGTH = 2`)

`_USER_COLUMNS` reports **16-bit integer** fields (type **3**, length **2**) — e.g. all **`Exportaciones.Stock1`…`Stock34`** (34 columns, each type 3 / length 2 in production).

- **Native 4D** (forms, compiled methods, `WORD` variables) keeps **signed** semantics: `−1` stays `−1`.
- **4D SQL + p4d** can still return the same bit pattern widened as an **unsigned** 32-bit value, so **`−1` appears as `65535`**, **`−2` as `65534`**, etc. The **`CCStock`** column on the same row is **`DATA_TYPE = 6` (Real)** and continues to show the correct **row-level net** (e.g. `−6.0`), which is why the POS grid matches **`CCStock`** while raw **`StockN`** look “huge” until reinterpreted.

**ETL fix:** `etl/db/fourd.py` → `decode_signed_int16_word()` — applied **only** when unpivoting **`Exportaciones.Stock1`…`Stock34`**, because **`_USER_COLUMNS`** marks those columns as **type 3 / length 2** only. There is **no `p4d.connect()` flag** to force signed 16-bit decoding.

**Do not** apply this decode to **Real** columns (type **6**) or to any column that is not **type 3 / length 2** in `_USER_COLUMNS`: wholesale line quantities can exceed **32767** and would be mis-decoded as negative if the int16 rule were applied blindly.

### Python p4d Type Notes

- **Text fields may return `bytes`** in Python 3.13+. Always decode: `v.decode('utf-8', errors='replace') if isinstance(v, bytes) else v`
- **Real fields** return Python `float`. Primary keys like `RegArticulo = 534.99` use the decimal part to encode store IDs.
- **Date fields** typically return as `datetime.date` or ISO string `'2024-01-15'`.
- **Time fields** typically return as `datetime.time` or string `'15:30:00'`.
- **Boolean fields** return `True`/`False` or `1`/`0` depending on context.
- **Type 0 columns** are unknown to p4d and cause `Unrecognized 4D type: 0` errors. Filter them out using `_USER_COLUMNS.DATA_TYPE`.

---

## 2. SELECT Syntax

### Full Syntax

```sql
SELECT [ALL | DISTINCT]
  {* | select_item, ..., select_item}
FROM table_reference, ..., table_reference
[WHERE search_condition]
[GROUP BY sort_list]
[HAVING search_condition]
[ORDER BY sort_list]
[LIMIT {int_number | ALL}]
[OFFSET int_number]
[INTO {4d_variable, ..., 4d_variable}]
[FOR UPDATE]
```

### Key Clauses

**DISTINCT** -- eliminates duplicate rows:
```sql
SELECT DISTINCT Tienda FROM LineasVentas
```

**Aliases** -- use `AS` (optional keyword):
```sql
SELECT Codigo AS product_code, Descripcion AS name FROM Articulos
SELECT a.Codigo, f.FamiGrupMarc
  FROM Articulos a, FamiGrupMarc f
  WHERE a.NumFamilia = f.RegFamilia
```

**ORDER BY** -- ascending (default) or descending; can reference column position:
```sql
SELECT Codigo, Descripcion FROM Articulos ORDER BY Descripcion ASC
SELECT Tienda, COUNT(*) FROM LineasVentas GROUP BY Tienda ORDER BY 2 DESC
```

**LIMIT / OFFSET** -- row limiting (works like standard SQL):
```sql
SELECT Codigo, Descripcion FROM Articulos LIMIT 10
SELECT Codigo, Descripcion FROM Articulos LIMIT 10 OFFSET 20
```

**GROUP BY / HAVING**:
```sql
SELECT Tienda, SUM(Total) AS revenue
  FROM LineasVentas
  WHERE Mes = 202501
  GROUP BY Tienda
  HAVING SUM(Total) > 1000
  ORDER BY revenue DESC
```

**Subqueries** -- supported in WHERE and FROM:
```sql
SELECT Codigo, Descripcion FROM Articulos
  WHERE RegArticulo IN (
    SELECT NumArticulo FROM LineasVentas WHERE Mes = 202501
  )
```

### Limitations

- **No `SELECT *` with explicit columns** -- you cannot mix `*` with named columns.
- **Object (JSON) fields not supported in SELECT** -- use `CAST(field AS VARCHAR)`.
- **No UNION / EXCEPT / INTERSECT** -- these set operations are not reliably supported in 4D v18. Use multiple queries and combine in Python.

---

## 3. WHERE Clause

### Comparison Operators

| Operator | Meaning |
|----------|---------|
| `=` | Equal |
| `<>` or `!=` | Not equal |
| `<` | Less than |
| `>` | Greater than |
| `<=` | Less than or equal |
| `>=` | Greater than or equal |

### Boolean Logic

```sql
WHERE condition1 AND condition2
WHERE condition1 OR condition2
WHERE NOT condition1
WHERE (condition1 OR condition2) AND condition3
```

### LIKE Predicate

Uses `%` (any sequence of characters) and `_` (any single character):

```sql
-- Products starting with "CAMISA"
SELECT Codigo, Descripcion FROM Articulos WHERE Descripcion LIKE 'CAMISA%'

-- Products with "TEJANO" anywhere in description
SELECT Codigo, Descripcion FROM Articulos WHERE Descripcion LIKE '%TEJANO%'

-- NOT LIKE
SELECT Codigo FROM Articulos WHERE Codigo NOT LIKE '7%'

-- ESCAPE clause for literal % or _
SELECT * FROM Articulos WHERE Descripcion LIKE '%10\%%' ESCAPE '\'
```

**Important**: 4D SQL string comparison is **case-sensitive by default**. `'camisa'` will NOT match `'CAMISA'`. Use `UPPER()` or `LOWER()` for case-insensitive matching:
```sql
WHERE UPPER(Descripcion) LIKE '%CAMISA%'
```

### IN Predicate

```sql
SELECT * FROM Tiendas WHERE Codigo IN ('99', '104', '121')
SELECT Codigo, Descripcion FROM Articulos
  WHERE NumFamilia IN (SELECT RegFamilia FROM FamiGrupMarc WHERE Clave = '10')
```

### BETWEEN Predicate

```sql
SELECT Codigo, Precio1 FROM Articulos WHERE Precio1 BETWEEN 10.0 AND 50.0
SELECT * FROM Ventas WHERE FechaCreacion BETWEEN '2025-01-01' AND '2025-01-31'
```

### IS NULL / IS NOT NULL

```sql
SELECT Codigo FROM Articulos WHERE CodigoBarra IS NULL
SELECT Codigo FROM Articulos WHERE CodigoBarra IS NOT NULL
```

### Date Literals

4D supports ODBC-style date/time constants:

```sql
-- Date literal
WHERE FechaCreacion = {d '2025-01-15'}

-- Time literal
WHERE Hora = {t '15:30:00'}

-- Timestamp literal
WHERE created_at = {ts '2025-01-15 15:30:00'}

-- String dates also work in many contexts
WHERE FechaCreacion = '2025-01-15'
WHERE FechaCreacion >= '2025-01-01' AND FechaCreacion <= '2025-01-31'
```

**Gotcha**: The SQL date parser rejects any date with `'0'` as the day or month (e.g., `'2025-00-00'`). Blank/empty dates require special handling.

---

## 4. JOIN Syntax

### Supported Join Types

4D supports both implicit (comma) and explicit JOIN syntax.

**Implicit Inner Join (comma syntax)**:
```sql
SELECT lv.Codigo, lv.Descripcion, v.FechaCreacion, v.Total
  FROM LineasVentas lv, Ventas v
  WHERE lv.NumVentas = v.RegVentas
```

**Explicit INNER JOIN**:
```sql
SELECT a.Codigo, a.Descripcion, f.FamiGrupMarc AS familia
  FROM Articulos a
  INNER JOIN FamiGrupMarc f ON a.NumFamilia = f.RegFamilia
```

**LEFT OUTER JOIN**:
```sql
SELECT a.Codigo, a.Descripcion, f.FamiGrupMarc
  FROM Articulos a
  LEFT OUTER JOIN FamiGrupMarc f ON a.NumFamilia = f.RegFamilia
```

**RIGHT OUTER JOIN**:
```sql
SELECT a.Codigo, f.FamiGrupMarc
  FROM Articulos a
  RIGHT OUTER JOIN FamiGrupMarc f ON a.NumFamilia = f.RegFamilia
```

**FULL OUTER JOIN**:
```sql
SELECT a.Codigo, f.FamiGrupMarc
  FROM Articulos a
  FULL OUTER JOIN FamiGrupMarc f ON a.NumFamilia = f.RegFamilia
```

**CROSS JOIN** (Cartesian product):
```sql
SELECT a.Codigo, t.Codigo
  FROM Articulos a CROSS JOIN Tiendas t
```

### JOIN Limitations

- **No NATURAL JOIN** -- not supported. Always specify ON conditions explicitly.
- **No USING clause** -- `JOIN ... USING (column)` is not supported. Use `ON` instead.
- **Equality only in ON clause** -- explicit JOIN conditions must use `=`. Operators like `>=`, `<`, `BETWEEN` are NOT allowed in ON clauses. Use WHERE for non-equality conditions:

```sql
-- WRONG: will fail
FROM Articulos a INNER JOIN LineasVentas lv ON a.RegArticulo = lv.NumArticulo AND lv.Mes >= 202501

-- CORRECT: move non-equality to WHERE
FROM Articulos a INNER JOIN LineasVentas lv ON a.RegArticulo = lv.NumArticulo
WHERE lv.Mes >= 202501
```

- **Multiple joins** can be combined in a single query, mixing implicit and explicit syntax.

---

## 5. Aggregate Functions

| Function | Syntax | Description |
|----------|--------|-------------|
| `COUNT` | `COUNT(*)` or `COUNT(expr)` or `COUNT(DISTINCT expr)` | Count rows or non-null values |
| `SUM` | `SUM(expr)` | Sum of values |
| `AVG` | `AVG(expr)` | Average of values |
| `MIN` | `MIN(expr)` | Minimum value |
| `MAX` | `MAX(expr)` | Maximum value |

### Examples with PowerShop Schema

```sql
-- Total sales count and revenue per store
SELECT Tienda, COUNT(*) AS num_tickets, SUM(Total) AS revenue
  FROM Ventas
  WHERE FechaCreacion >= '2025-01-01'
  GROUP BY Tienda
  ORDER BY revenue DESC

-- Average ticket value by store
SELECT v.Tienda, AVG(v.Total) AS avg_ticket
  FROM Ventas v
  WHERE v.FechaCreacion >= '2025-01-01' AND v.Total > 0
  GROUP BY v.Tienda

-- Product count per family
SELECT f.FamiGrupMarc AS familia, COUNT(*) AS num_products
  FROM Articulos a
  INNER JOIN FamiGrupMarc f ON a.NumFamilia = f.RegFamilia
  GROUP BY f.FamiGrupMarc
  HAVING COUNT(*) > 10
  ORDER BY num_products DESC

-- Date range with distinct count
SELECT COUNT(DISTINCT NumCliente) AS unique_customers
  FROM Ventas
  WHERE FechaCreacion BETWEEN '2025-01-01' AND '2025-03-31'
    AND NumCliente > 0
```

---

## 6. String Functions

| Function | Syntax | Description |
|----------|--------|-------------|
| `CONCAT` | `CONCAT(str1, str2)` | Concatenate two strings |
| `CONCATENATE` | `CONCATENATE(str1, str2, ...)` | 4D-specific: concatenate multiple strings |
| `SUBSTRING` | `SUBSTRING(str, start [, length])` | Extract substring (1-based index) |
| `LENGTH` | `LENGTH(str)` | Character count |
| `CHAR_LENGTH` | `CHAR_LENGTH(str)` | Character count (synonym) |
| `OCTET_LENGTH` | `OCTET_LENGTH(str)` | Byte count |
| `BIT_LENGTH` | `BIT_LENGTH(str)` | Bit count |
| `UPPER` | `UPPER(str)` | Convert to uppercase |
| `LOWER` | `LOWER(str)` | Convert to lowercase |
| `TRIM` | `TRIM([[LEADING\|TRAILING\|BOTH] [char] FROM] str)` | Remove leading/trailing characters |
| `LTRIM` | `LTRIM(str)` | Remove leading spaces |
| `RTRIM` | `RTRIM(str)` | Remove trailing spaces |
| `LEFT` | `LEFT(str, n)` | Leftmost n characters |
| `RIGHT` | `RIGHT(str, n)` | Rightmost n characters |
| `REPLACE` | `REPLACE(str, from, to)` | Replace occurrences |
| `REPEAT` | `REPEAT(str, n)` | Repeat string n times |
| `INSERT` | `INSERT(str, start, length, new_str)` | Insert string at position |
| `LOCATE` | `LOCATE(substring, str)` | Find position of substring (1-based, 0 if not found) |
| `POSITION` | `POSITION(substring IN str)` | Find position (SQL-92 syntax) |
| `SPACE` | `SPACE(n)` | Generate n spaces |
| `TRANSLATE` | `TRANSLATE(str, from_chars, to_chars)` | Character-by-character translation |
| `ASCII` | `ASCII(str)` | ASCII code of first character |
| `CHAR` | `CHAR(code)` | Character from ASCII code |
| `COALESCE` | `COALESCE(expr1, expr2, ...)` | First non-null value |
| `NULLIF` | `NULLIF(expr1, expr2)` | NULL if expr1 = expr2 |

### String Function Examples

```sql
-- Full product description with family
SELECT CONCAT(CONCAT(a.Codigo, ' - '), a.Descripcion) AS full_desc
  FROM Articulos a
  LIMIT 10

-- Case-insensitive search
SELECT Codigo, Descripcion FROM Articulos
  WHERE UPPER(Descripcion) LIKE '%CAMISA%'

-- Extract first 3 characters of store code
SELECT LEFT(Tienda, 3) AS store_prefix, COUNT(*) AS sales
  FROM LineasVentas
  GROUP BY LEFT(Tienda, 3)

-- Clean up trailing spaces
SELECT TRIM(Descripcion) AS clean_name FROM Articulos LIMIT 5

-- COALESCE for null handling
SELECT Codigo, COALESCE(CodigoBarra, 'NO-BARCODE') AS barcode
  FROM Articulos LIMIT 10
```

---

## 7. Date/Time Functions

| Function | Syntax | Description |
|----------|--------|-------------|
| `CURRENT_DATE` | `CURRENT_DATE` | Today's date |
| `CURRENT_TIME` | `CURRENT_TIME` | Current time |
| `CURRENT_TIMESTAMP` | `CURRENT_TIMESTAMP` | Current date + time |
| `CURDATE` | `CURDATE()` | Today's date (synonym) |
| `CURTIME` | `CURTIME()` | Current time (synonym) |
| `YEAR` | `YEAR(date_expr)` | Extract year |
| `MONTH` | `MONTH(date_expr)` | Extract month (1-12) |
| `DAY` | `DAY(date_expr)` | Extract day of month |
| `DAYOFMONTH` | `DAYOFMONTH(date_expr)` | Day of month (synonym) |
| `DAYOFWEEK` | `DAYOFWEEK(date_expr)` | Day of week (1=Sunday, 7=Saturday) |
| `DAYOFYEAR` | `DAYOFYEAR(date_expr)` | Day of year (1-366) |
| `DAYNAME` | `DAYNAME(date_expr)` | Name of day ('Monday', etc.) |
| `MONTHNAME` | `MONTHNAME(date_expr)` | Name of month ('January', etc.) |
| `WEEK` | `WEEK(date_expr)` | Week number of year |
| `QUARTER` | `QUARTER(date_expr)` | Quarter (1-4) |
| `HOUR` | `HOUR(time_expr)` | Extract hour |
| `MINUTE` | `MINUTE(time_expr)` | Extract minute |
| `SECOND` | `SECOND(time_expr)` | Extract second |
| `MILLISECOND` | `MILLISECOND(time_expr)` | Extract millisecond |
| `EXTRACT` | `EXTRACT(part FROM expr)` | Extract date/time component |
| `DATE_TO_CHAR` | `DATE_TO_CHAR(date_expr, format)` | Format date as string |

### Date/Time Examples

```sql
-- Sales from current month
SELECT COUNT(*) FROM Ventas
  WHERE YEAR(FechaCreacion) = YEAR(CURRENT_DATE)
    AND MONTH(FechaCreacion) = MONTH(CURRENT_DATE)

-- Monthly sales summary for 2025
SELECT YEAR(FechaCreacion) AS yr, MONTH(FechaCreacion) AS mo,
       COUNT(*) AS num_sales, SUM(Total) AS revenue
  FROM Ventas
  WHERE FechaCreacion >= '2025-01-01' AND FechaCreacion < '2026-01-01'
  GROUP BY YEAR(FechaCreacion), MONTH(FechaCreacion)
  ORDER BY yr, mo

-- Using LineasVentas.Mes for faster period filtering (integer YYYYMM)
SELECT Mes, SUM(Total) AS revenue, COUNT(*) AS lines
  FROM LineasVentas
  WHERE Mes BETWEEN 202501 AND 202512
  GROUP BY Mes
  ORDER BY Mes

-- Day-of-week analysis
SELECT DAYOFWEEK(FechaCreacion) AS dow, COUNT(*) AS sales
  FROM Ventas
  WHERE FechaCreacion >= '2025-01-01'
  GROUP BY DAYOFWEEK(FechaCreacion)
  ORDER BY dow

-- EXTRACT syntax
SELECT EXTRACT(YEAR FROM FechaCreacion) AS year FROM Ventas LIMIT 5
```

### Date Arithmetic

4D SQL has limited built-in date arithmetic. For complex date math, prefer computing boundaries in Python and passing them as literals:

```python
from datetime import date, timedelta
start = date.today() - timedelta(days=30)
query = f"SELECT * FROM Ventas WHERE FechaCreacion >= '{start.isoformat()}'"
```

---

## 8. Math Functions

| Function | Syntax | Description |
|----------|--------|-------------|
| `ABS` | `ABS(n)` | Absolute value |
| `ROUND` | `ROUND(n [, decimals])` | Round to n decimal places (default 0) |
| `CEILING` | `CEILING(n)` | Round up to nearest integer |
| `FLOOR` | `FLOOR(n)` | Round down to nearest integer |
| `TRUNC` / `TRUNCATE` | `TRUNC(n [, decimals])` | Truncate decimal places |
| `MOD` | `MOD(n, divisor)` | Modulo / remainder |
| `SIGN` | `SIGN(n)` | -1, 0, or 1 |
| `POWER` | `POWER(base, exp)` | Exponentiation |
| `SQRT` | `SQRT(n)` | Square root |
| `EXP` | `EXP(n)` | e^n |
| `LOG` | `LOG(n)` | Natural logarithm |
| `LOG10` | `LOG10(n)` | Base-10 logarithm |
| `RAND` | `RAND()` | Random number 0-1 |
| `PI` | `PI()` | Pi constant |
| `DEGREES` | `DEGREES(radians)` | Radians to degrees |
| `RADIANS` | `RADIANS(degrees)` | Degrees to radians |
| `SIN` / `COS` / `TAN` | `SIN(n)` | Trigonometric functions |
| `ASIN` / `ACOS` / `ATAN` | `ASIN(n)` | Inverse trig functions |
| `ATAN2` | `ATAN2(y, x)` | Two-argument arctangent |
| `COT` | `COT(n)` | Cotangent |

### Math Examples

```sql
-- Gross margin percentage
SELECT Codigo, Descripcion,
       Precio1 AS pvp, PrecioCoste AS cost,
       ROUND((Precio1 - PrecioCoste) / Precio1 * 100, 1) AS margin_pct
  FROM Articulos
  WHERE Precio1 > 0 AND PrecioCoste > 0
  ORDER BY margin_pct DESC
  LIMIT 20

-- ROUND example
SELECT ROUND(1234.1966, 2)  -- returns 1234.2000

-- Random sample of products
SELECT Codigo, Descripcion FROM Articulos
  WHERE RAND() < 0.01
  LIMIT 10
```

---

## 9. CAST Function

Convert between types:

```sql
CAST(expression AS sql_data_type_name)
```

Examples:
```sql
-- Object field to text (JSON)
SELECT CAST(Objeto AS VARCHAR) FROM Articulos WHERE Objeto IS NOT NULL LIMIT 5

-- Number to string
SELECT CAST(RegArticulo AS VARCHAR) FROM Articulos LIMIT 5

-- String to integer
SELECT * FROM LineasVentas WHERE CAST(Tienda AS INT) = 99
```

---

## 10. System Tables

All system tables are in the `SYSTEM_SCHEMA` and are read-only.

### _USER_TABLES

```sql
SELECT TABLE_NAME, TABLE_ID, SCHEMA_ID FROM _USER_TABLES
```

| Column | Type | Description |
|--------|------|-------------|
| TABLE_NAME | VARCHAR | Table name |
| TEMPORARY | BOOLEAN | Is temporary table |
| TABLE_ID | INT64 | Numeric table ID |
| SCHEMA_ID | INT32 | Schema ID |
| REST_AVAILABLE | BOOLEAN | Exposed via REST |
| LOGGED | BOOLEAN | Included in transaction log |

### _USER_COLUMNS

```sql
SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, DATA_LENGTH, NULLABLE
  FROM _USER_COLUMNS
  WHERE TABLE_NAME = 'Articulos'
  ORDER BY COLUMN_ID
```

| Column | Type | Description |
|--------|------|-------------|
| TABLE_NAME | VARCHAR | Parent table |
| COLUMN_NAME | VARCHAR | Column name |
| DATA_TYPE | INT32 | SQL type code (see type IDs above) |
| DATA_LENGTH | INT32 | Size in bytes |
| OLD_DATA_TYPE | INT32 | Legacy 4D type code |
| NULLABLE | BOOLEAN | Allows NULLs |
| TABLE_ID | INT64 | Table number |
| COLUMN_ID | INT64 | Column number |
| UNIQUENESS | BOOLEAN | Has unique constraint |
| AUTOGENERATE | BOOLEAN | Auto-generated value |
| AUTOINCREMENT | BOOLEAN | Auto-increment |

### _USER_INDEXES

```sql
SELECT INDEX_NAME, TABLE_NAME, INDEX_TYPE, UNIQUENESS
  FROM _USER_INDEXES
  WHERE TABLE_NAME = 'Articulos'
```

| Column | Type | Description |
|--------|------|-------------|
| INDEX_ID | VARCHAR | Index identifier |
| INDEX_NAME | VARCHAR | Index name |
| INDEX_TYPE | INT32 | 1=BTree, 3=Cluster/Keyword, 7=Auto, 8=Object-type |
| KEYWORD | BOOLEAN | Is keyword index |
| TABLE_NAME | VARCHAR | Table name |
| UNIQUENESS | BOOLEAN | Unique index |

### _USER_IND_COLUMNS

```sql
SELECT INDEX_NAME, TABLE_NAME, COLUMN_NAME, COLUMN_POSITION
  FROM _USER_IND_COLUMNS
  WHERE TABLE_NAME = 'Articulos'
```

### _USER_CONSTRAINTS

```sql
SELECT CONSTRAINT_NAME, CONSTRAINT_TYPE, TABLE_NAME,
       RELATED_TABLE_NAME, DELETE_RULE
  FROM _USER_CONSTRAINTS
```

| CONSTRAINT_TYPE | Meaning |
|-----------------|---------|
| `P` | Primary Key |
| `R` | Foreign Key |
| `4DR` | 4D Relation (automatic) |

### _USER_CONS_COLUMNS

```sql
SELECT CONSTRAINT_NAME, TABLE_NAME, COLUMN_NAME,
       RELATED_COLUMN_NAME
  FROM _USER_CONS_COLUMNS
  WHERE TABLE_NAME = 'LineasVentas'
```

### _USER_SCHEMAS

```sql
SELECT SCHEMA_ID, SCHEMA_NAME FROM _USER_SCHEMAS
```

### _USER_VIEWS / _USER_VIEW_COLUMNS

```sql
SELECT VIEW_NAME FROM _USER_VIEWS
SELECT VIEW_NAME, COLUMN_NAME, DATA_TYPE FROM _USER_VIEW_COLUMNS
```

---

## 11. DDL Commands (Reference Only)

These are available in 4D SQL but **should NEVER be used against the production database**:

| Command | Syntax |
|---------|--------|
| `CREATE TABLE` | `CREATE TABLE name (col_def, ...)` |
| `ALTER TABLE` | `ALTER TABLE name ADD column ...` / `DROP column` |
| `DROP TABLE` | `DROP TABLE name` |
| `CREATE INDEX` | `CREATE [UNIQUE] INDEX name ON table (cols)` |
| `DROP INDEX` | `DROP INDEX name` |
| `CREATE VIEW` | `CREATE VIEW name AS SELECT ...` |
| `DROP VIEW` | `DROP VIEW name` |
| `CREATE SCHEMA` | `CREATE SCHEMA name` |
| `DROP SCHEMA` | `DROP SCHEMA name` |
| `GRANT` / `REVOKE` | Access control |
| `LOCK TABLE` / `UNLOCK TABLE` | Table locking |

---

## 12. Transactions

```sql
START TRANSACTION;
-- statements
COMMIT;
-- or
ROLLBACK;
```

- **Auto-commit**: By default, individual statements are NOT wrapped in transactions. Auto-commit can be enabled in 4D settings.
- **Our connection is read-only**: Transaction commands are irrelevant since we only run SELECT queries.

---

## 13. Gotchas and Differences from Standard SQL

### Critical Differences

| Topic | 4D SQL Behavior | PostgreSQL/MySQL Behavior |
|-------|----------------|--------------------------|
| **String comparison** | **Case-sensitive by default** | Varies (PG sensitive, MySQL insensitive) |
| **Primary keys** | Real (float) with `.99` suffix pattern | Integer / UUID |
| **NULL handling** | Has "Map NULL to blank values" mode that converts NULLs to defaults (empty string, 0, false) | Standard NULL semantics |
| **NATURAL JOIN** | Not supported | Supported |
| **USING clause** | Not supported | Supported |
| **JOIN ON conditions** | Equality (`=`) only | Any expression |
| **UNION / INTERSECT / EXCEPT** | Unreliable in v18 | Fully supported |
| **Object fields** | Must CAST to VARCHAR | Native JSON support |
| **Column name case** | Names returned UPPERCASE from queries, but must be written in **original case** in SQL | Varies |
| **LIMIT syntax** | `LIMIT n OFFSET m` (works) | Same syntax |
| **Date zero** | Cannot use `'0000-00-00'` or day/month = 0 | MySQL allows, PG rejects |
| **String concatenation** | `CONCAT(a, b)` or `CONCATENATE(a, b, c)` | `a \|\| b` (PG) or `CONCAT(a, b)` |
| **Boolean literals** | `TRUE` / `FALSE` | Same, but 4D may also use 1/0 |
| **Table/column name limit** | 31 characters max | Much larger |
| **Max columns per table** | 32,767 | Varies (250-1600 typical) |

### Practical Gotchas

1. **Never use `SELECT *`** on wide tables (CCStock: 582 cols, Articulos: 379 cols, Clientes: 311 cols). Always list specific columns.

2. **Type 0 columns** cause `Unrecognized 4D type: 0` errors with p4d. Always query specific columns or pre-filter by checking `_USER_COLUMNS.DATA_TYPE != 0`.

3. **Picture/Blob columns** (type 12, 18) in `SELECT *` can hang the connection. Exclude them.

4. **Text returns bytes**: In Python 3.13+, p4d may return `bytes` for text columns. Always handle: `val.decode('utf-8', errors='replace') if isinstance(val, bytes) else val`.

5. **Floating-point PKs**: When joining on Real-type foreign keys (e.g., `NumVentas = RegVentas`), be aware of floating-point precision. The values should match exactly since they are stored as-is, but avoid arithmetic on PK values.

6. **No `ILIKE`**: Unlike PostgreSQL, there is no case-insensitive LIKE. Use `UPPER(col) LIKE 'PATTERN%'`.

7. **No `::type` casting**: Use `CAST(expr AS type)` instead of PostgreSQL's `::` syntax.

8. **No `COALESCE` with mixed types**: Ensure all arguments to COALESCE are the same type.

9. **String comparison is byte-level**: Accented characters (common in Spanish/Portuguese data like "Descripcion", "Poblacion") sort by byte value, not linguistic order.

10. **Connection stability**: The SQL server is manually started on the 4D Server. If 4D restarts, SQL may not come back without manual intervention.

---

## 14. Query Examples for PowerShop Schema

### Sales Analysis

```sql
-- Daily sales summary for a store
SELECT FechaCreacion, COUNT(*) AS tickets, SUM(Total) AS revenue
  FROM Ventas
  WHERE Tienda = '99' AND FechaCreacion >= '2025-01-01'
  GROUP BY FechaCreacion
  ORDER BY FechaCreacion

-- Top 20 products by units sold in a period
SELECT lv.Codigo, lv.Descripcion,
       SUM(lv.Unidades) AS units, SUM(lv.Total) AS revenue
  FROM LineasVentas lv
  WHERE lv.Mes BETWEEN 202501 AND 202503
  GROUP BY lv.Codigo, lv.Descripcion
  ORDER BY units DESC
  LIMIT 20

-- Sales by family with join
SELECT f.FamiGrupMarc AS familia,
       SUM(lv.Total) AS revenue,
       SUM(lv.Unidades) AS units,
       COUNT(*) AS line_count
  FROM LineasVentas lv
  INNER JOIN FamiGrupMarc f ON lv.NumFamilia = f.RegFamilia
  WHERE lv.Mes = 202501
  GROUP BY f.FamiGrupMarc
  ORDER BY revenue DESC
```

### Product Analysis

```sql
-- Products with margin below threshold
SELECT Codigo, Descripcion, Precio1, PrecioCoste,
       ROUND((Precio1 - PrecioCoste) / Precio1 * 100, 1) AS margin_pct
  FROM Articulos
  WHERE Precio1 > 0 AND PrecioCoste > 0 AND Anulado = FALSE
    AND (Precio1 - PrecioCoste) / Precio1 < 0.3
  ORDER BY margin_pct ASC
  LIMIT 50

-- Product catalog with classification
SELECT a.Codigo, a.Descripcion, a.Precio1,
       f.FamiGrupMarc AS familia,
       d.DepaSeccFabr AS departamento,
       a.ClaveTemporada, a.MarcaO2 AS marca
  FROM Articulos a
  LEFT OUTER JOIN FamiGrupMarc f ON a.NumFamilia = f.RegFamilia
  LEFT OUTER JOIN DepaSeccFabr d ON a.NumDepartament = d.RegDepartament
  WHERE a.Anulado = FALSE
  ORDER BY a.Codigo
  LIMIT 100
```

### Customer Analysis

```sql
-- Top customers by purchase volume
SELECT v.NumCliente, v.Cliente,
       COUNT(*) AS num_purchases, SUM(v.Total) AS total_spent
  FROM Ventas v
  WHERE v.NumCliente > 0
    AND v.FechaCreacion >= '2025-01-01'
  GROUP BY v.NumCliente, v.Cliente
  HAVING SUM(v.Total) > 500
  ORDER BY total_spent DESC
  LIMIT 50

-- Customer details lookup
SELECT RegCliente, Cliente, Poblacion, Provincia, Postal,
       Telefono, Movil, CIF, FormaPago
  FROM Clientes
  WHERE UPPER(Cliente) LIKE '%EXAMPLE%'
```

### Stock and Transfers

```sql
-- Transfer summary by store
SELECT TiendaEntrada, Tipo, COUNT(*) AS transfers,
       SUM(UnidadesE) AS total_units
  FROM Traspasos
  WHERE FechaE >= '2025-01-01'
  GROUP BY TiendaEntrada, Tipo
  ORDER BY TiendaEntrada, total_units DESC

-- Products never sold (in last year)
SELECT a.Codigo, a.Descripcion, a.Stock
  FROM Articulos a
  WHERE a.Anulado = FALSE AND a.Stock > 0
    AND a.RegArticulo NOT IN (
      SELECT DISTINCT lv.NumArticulo FROM LineasVentas lv
      WHERE lv.Mes >= 202501
    )
  LIMIT 100
```

### Schema Discovery

```sql
-- List all tables with row estimates
SELECT TABLE_NAME, TABLE_ID FROM _USER_TABLES ORDER BY TABLE_NAME

-- Describe a table's columns
SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH, NULLABLE
  FROM _USER_COLUMNS
  WHERE TABLE_NAME = 'Ventas'
  ORDER BY COLUMN_ID

-- Find all text columns in a table (safe to query)
SELECT COLUMN_NAME FROM _USER_COLUMNS
  WHERE TABLE_NAME = 'Articulos' AND DATA_TYPE = 10

-- Find all numeric columns
SELECT COLUMN_NAME FROM _USER_COLUMNS
  WHERE TABLE_NAME = 'Articulos' AND DATA_TYPE IN (3, 4, 6)

-- Find columns safe to query (exclude Picture, Blob, type 0)
SELECT COLUMN_NAME, DATA_TYPE FROM _USER_COLUMNS
  WHERE TABLE_NAME = 'Articulos' AND DATA_TYPE NOT IN (0, 12, 18)
  ORDER BY COLUMN_ID
```

---

## 15. Complete SQL Function Reference (Alphabetical)

All functions available in 4D SQL:

**Aggregate**: AVG, COUNT, MAX, MIN, SUM

**String**: ASCII, CHAR, CHAR_LENGTH, CONCAT, CONCATENATE, INSERT, LEFT, LENGTH, LOCATE, LOWER, LTRIM, OCTET_LENGTH, BIT_LENGTH, POSITION, REPEAT, REPLACE, RIGHT, RTRIM, SPACE, SUBSTRING, TRANSLATE, TRIM, UPPER

**Numeric**: ABS, ACOS, ASIN, ATAN, ATAN2, CEILING, COS, COT, DEGREES, EXP, FLOOR, LOG, LOG10, MOD, PI, POWER, RADIANS, RAND, ROUND, SIGN, SIN, SQRT, TAN, TRUNC, TRUNCATE

**Date/Time**: CURDATE, CURRENT_DATE, CURRENT_TIME, CURRENT_TIMESTAMP, CURTIME, DATE_TO_CHAR, DAY, DAYNAME, DAYOFMONTH, DAYOFWEEK, DAYOFYEAR, EXTRACT, HOUR, MILLISECOND, MINUTE, MONTH, MONTHNAME, QUARTER, SECOND, WEEK, YEAR

**Conversion/Logic**: CAST, COALESCE, NULLIF

**4D-Specific**: DATABASE_PATH, CONCATENATE

---

## LLM:rules

```json
[]
```
