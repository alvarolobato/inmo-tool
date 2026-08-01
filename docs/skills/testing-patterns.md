# Skill: Testing Patterns

> Adapted from [ChrisWiles/claude-code-showcase](https://github.com/ChrisWiles/claude-code-showcase). Modified for this project's dual stack: Python (ETL) + TypeScript (Dashboard App).

**Use when**: Writing unit tests, creating test factories, or following TDD workflow.

## Testing Philosophy

**Test-Driven Development (TDD):**
- Write failing test FIRST
- Implement minimal code to pass
- Refactor after green
- Never write production code without a failing test

**Behavior-Driven Testing:**
- Test behavior, not implementation
- Focus on public APIs and business requirements
- Avoid testing implementation details
- Use descriptive test names that describe behavior

**Factory Pattern:**
- Create `getMock<Type>(overrides?)` functions (TS) or `make_<type>(**overrides)` functions (Python)
- Provide sensible defaults
- Allow overriding specific properties
- Keep tests DRY and maintainable

---

## Python Testing (ETL, scripts)

### Framework: pytest

```bash
# Run all ETL tests
python -m pytest etl/tests/ -v

# Run with coverage
python -m pytest etl/tests/ --cov=etl

# Run specific test
python -m pytest etl/tests/test_sync_ventas.py -v
```

### Factory Pattern (Python)

```python
from decimal import Decimal

def make_venta(**overrides) -> dict:
    """Factory for ps_ventas row dicts."""
    defaults = {
        "reg_ventas": Decimal("10001.641"),
        "n_documento": Decimal("641001.0"),
        "tienda": "641",
        "fecha_creacion": "2026-03-30",
        "total_si": Decimal("24.79"),
        "total": Decimal("30.49"),
        "num_cliente": Decimal("0"),
        "tipo_documento": "Ticket",
        "entrada": True,
    }
    return {**defaults, **overrides}

# Usage
def test_venta_is_return():
    venta = make_venta(entrada=False, total_si=Decimal("-15.00"))
    assert not venta["entrada"]
    assert venta["total_si"] < 0
```

### Mocking 4D Connection

```python
from unittest.mock import MagicMock, patch

@patch("etl.db.fourd.get_connection")
def test_sync_articulos(mock_conn):
    mock_cursor = MagicMock()
    mock_cursor.fetchall.return_value = [
        (Decimal("1.99"), "12345", "CAMISA", "Test article"),
    ]
    mock_cursor.description = [
        (b"REGARTICULO",), (b"CODIGO",), (b"CCREFEJOFACM",), (b"DESCRIPCION",),
    ]
    mock_conn.return_value.cursor.return_value = mock_cursor
    # ... test sync function
```

### PostgreSQL Integration Tests

```python
import pytest
import os

@pytest.fixture
def pg_conn():
    """Skip if no PostgreSQL available."""
    dsn = os.environ.get("POSTGRES_DSN")
    if not dsn:
        pytest.skip("POSTGRES_DSN not set")
    import psycopg2
    conn = psycopg2.connect(dsn)
    yield conn
    conn.close()

def test_ventas_count(pg_conn):
    with pg_conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM ps_ventas")
        count = cur.fetchone()[0]
    assert count > 0, "ps_ventas should have data"
```

### Test Structure (Python)

```python
class TestSyncVentas:
    """Tests for the ventas sync module."""

    def test_count_matches_source(self, pg_conn, fourd_conn):
        """Row count in PG should match 4D."""
        pass

    def test_total_si_not_null(self, pg_conn):
        """total_si should be non-null for 90%+ of rows."""
        pass

    def test_delta_only_fetches_modified(self, pg_conn, fourd_conn):
        """With a recent watermark, only recent rows should sync."""
        pass
```

---

## TypeScript Testing (Dashboard App)

### Framework: Vitest + React Testing Library

```bash
# Run all dashboard tests
cd dashboard && npm test

# Run with coverage
cd dashboard && npm run test:coverage

# Run specific file
cd dashboard && npx vitest run components/widgets/KpiRow.test.tsx
```

### Factory Pattern (TypeScript)

```typescript
import type { DashboardSpec, Widget } from '@/lib/schema';

export const makeDashboardSpec = (
  overrides?: Partial<DashboardSpec>
): DashboardSpec => ({
  title: 'Test Dashboard',
  description: 'Test description',
  widgets: [makeKpiWidget()],
  ...overrides,
});

export const makeKpiWidget = (
  overrides?: Partial<Widget>
): Widget => ({
  id: 'w1',
  type: 'kpi_row',
  items: [
    { label: 'Ventas Netas', sql: 'SELECT 100 AS value', format: 'currency', prefix: '€' },
  ],
  ...overrides,
});

export const makeBarChartWidget = (
  overrides?: Partial<Widget>
): Widget => ({
  id: 'w2',
  type: 'bar_chart',
  title: 'Ventas por Tienda',
  sql: "SELECT tienda AS label, SUM(total_si) AS value FROM ps_ventas GROUP BY tienda",
  x: 'label',
  y: 'value',
  ...overrides,
});
```

### Component Testing

```typescript
import { render, screen } from '@testing-library/react';
import { KpiRow } from '@/components/widgets/KpiRow';
import { makeKpiWidget } from '@/test/factories';

describe('KpiRow', () => {
  it('should render KPI labels', () => {
    const widget = makeKpiWidget();
    const data = [{ value: 12345.67 }];
    render(<KpiRow spec={widget} data={data} />);
    expect(screen.getByText('Ventas Netas')).toBeTruthy();
  });

  it('should format currency in European style', () => {
    const widget = makeKpiWidget();
    const data = [{ value: 12345.67 }];
    render(<KpiRow spec={widget} data={data} />);
    expect(screen.getByText('€12.345,67')).toBeTruthy();
  });
});
```

### API Route Testing

```typescript
import { POST } from '@/app/api/dashboard/generate/route';

describe('POST /api/dashboard/generate', () => {
  it('should return valid dashboard spec', async () => {
    const req = new Request('http://localhost/api/dashboard/generate', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'ventas del mes' }),
    });
    const res = await POST(req);
    const data = await res.json();
    expect(data.title).toBeDefined();
    expect(data.widgets).toBeInstanceOf(Array);
    expect(data.widgets.length).toBeGreaterThan(0);
  });

  it('should reject empty prompt', async () => {
    const req = new Request('http://localhost/api/dashboard/generate', {
      method: 'POST',
      body: JSON.stringify({ prompt: '' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
```

---

## Anti-Patterns to Avoid

### Testing mock behavior instead of real behavior
```typescript
// Bad - testing the mock
expect(mockFetchData).toHaveBeenCalled();

// Good - testing actual behavior
expect(screen.getByText('12.345,67 €')).toBeTruthy();
```

### Not using factories
```python
# Bad - duplicated, inconsistent test data
def test_1():
    venta = {"reg_ventas": Decimal("1.99"), "total_si": Decimal("10")}

def test_2():
    venta = {"reg_ventas": Decimal("2.99")}  # Missing total_si!

# Good - reusable factory
venta = make_venta(total_si=Decimal("10"))
```

### Testing implementation instead of behavior
```python
# Bad - testing internal state
assert sync._offset == 5000

# Good - testing observable behavior
assert pg_count == fourd_count
```

## Best Practices

1. **Always use factory functions** for test data
2. **Test behavior, not implementation**
3. **Use descriptive test names** that describe the expected behavior
4. **Organize with describe/class blocks** by feature area
5. **Clear mocks between tests** (`jest.clearAllMocks()` / `MagicMock.reset_mock()`)
6. **Keep tests focused** — one behavior per test
7. **For ETL**: integration tests with real PG, skip if no connection
8. **For Dashboard**: unit tests for components, integration for API routes

---

## See also

- [docs/testing-strategy.md](../testing-strategy.md) — test tiers, commands, coverage thresholds, and the "must cover before risky change" list
