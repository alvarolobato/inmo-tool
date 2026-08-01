# Raw Schema Extraction Data

> Extracted 2026-04-05 by querying the live 4D server and the PowerShop.4DC compiled binary.
> See [../schema-discovery.md](../schema-discovery.md) — "D-011 Extraction Session" for full details.

## Files

| File | Size | Contents |
|------|------|---------|
| `4d_all_columns.json` | ~292K | All tables → column name lists. Dict keyed by table name. |
| `4d_views_schema.json` | ~72K | Column details (name, type_code, type_name, nullable) for 48 queryable SQL views. |
| `4d_cons_columns.json` | ~52K | FK and PK constraints from `_USER_CONS_COLUMNS` (88 FK + 82 PK rows). |
| `4d_index_columns.json` | ~36K | Indexed columns from `_USER_IND_COLUMNS` (239 tables, 1,784 indexed columns). |
| `4d_wsdl_methods.json` | ~9K | 113 `WS_JS_*` SOAP method signatures with input/output parameters. |

## Not included

- `4dc_strings.txt` (47 MB) — string extraction from compiled binary. Too large for git.
  Regenerate: `strings -n 5 "PowerShop.4DC" > /tmp/4dc_strings.txt`
- `4d_tiendas.json` — store data including names/addresses (business data, not committed).

## How to query

```python
import json

# All columns by table
with open('docs/schema-raw/4d_all_columns.json') as f:
    cols = json.load(f)  # {table_name: [col_name, ...]}
print(cols['Ventas'])

# SOAP method signatures
with open('docs/schema-raw/4d_wsdl_methods.json') as f:
    methods = json.load(f)  # [{name, inputs: [{name, type}], outputs: [{name, type}]}]
print([m['name'] for m in methods])
```
