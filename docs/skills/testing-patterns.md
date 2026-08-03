# Skill: Testing Patterns

> Adapted from [ChrisWiles/claude-code-showcase](https://github.com/ChrisWiles/claude-code-showcase). Modified for this project's dual stack: Python (connectors/ETL) + TypeScript (Dashboard App). Examples below are illustrative — the real factories/fixtures land as Phase 1 tasks (schema in #10, connector framework in #11) are implemented; update these examples once real modules exist to copy from.

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

## Python Testing (connectors, ETL, scripts)

### Framework: pytest

```bash
# Run all tests
python -m pytest etl/tests/ -v

# Run with coverage
python -m pytest etl/tests/ --cov=etl

# Run specific test
python -m pytest etl/tests/test_dedup_engine.py -v
```

### Factory Pattern (Python)

```python
from decimal import Decimal

def make_listing(**overrides) -> dict:
    """Factory for a normalized listing row dict (see task 1.2, #10, for the real schema)."""
    defaults = {
        "source": "idealista",
        "external_id": "12345678",
        "price": Decimal("185000.00"),
        "m2_built": 78,
        "rooms": 3,
        "listing_kind": "particular",
        "description": "Piso luminoso, sin ascensor.",
    }
    return {**defaults, **overrides}

# Usage
def test_listing_below_threshold_excluded_by_hard_filter():
    listing = make_listing(price=Decimal("500000.00"))
    assert not passes_price_filter(listing, max_price=Decimal("300000.00"))
```

### Mocking an external connector source

```python
from unittest.mock import MagicMock, patch

@patch("etl.connectors.base.fetch_page")
def test_discover_paginates_until_empty_page(mock_fetch):
    mock_fetch.side_effect = [
        {"results": [{"id": "1"}, {"id": "2"}]},
        {"results": []},
    ]
    ids = list(discover(scope={}))
    assert ids == ["1", "2"]
```

### PostgreSQL integration tests

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

def test_property_count(pg_conn):
    with pg_conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM property")
        count = cur.fetchone()[0]
    assert count >= 0
```

### Gotcha: exact-count assertions on shared test coordinates flake under concurrent files (found while building #32's area-price tests)

Issue #159 isolates each `npm test` invocation to its own throwaway
database, but vitest still runs test *files* concurrently by default
against that one shared database. Several existing integration test files
(`materialize.integration.test.ts`, `candidates.integration.test.ts`,
`property-detail.integration.test.ts`) all seed synthetic properties at the
same real-world point (`MADRID_SOL`, `[40.4168, -3.7038]`) — this is safe
for them because every assertion checks *containment* of specific IDs
(`expect(matches).toContain(insideId)`), never a total count.

A new test that asserts an **exact count** within a radius (e.g.
`lib/analytics/__tests__/area-price.test.ts`'s `sample_size`) is NOT safe at
that same point: another file's concurrently-running fixture can land
inside the query's radius and inflate the count, producing an intermittent
failure that has nothing to do with the code under test — reproduced
directly: a full `npm test` run failed 2 of `area-price.test.ts`'s tests
one run and passed cleanly the next, while running that file alone was
always green.

**Rule**: if your test asserts an exact count (not just presence/absence of
specific rows) over a geographic radius or any other "everything nearby"
query, seed your fixtures at a coordinate no other test file uses — don't
reuse `MADRID_SOL`/`ATOCHA`. Pick something clearly dedicated and far
outside every other file's query radius (`area-price.test.ts` uses Gijón,
`[43.3619, -5.8494]`, with a one-line comment explaining why).

### Test structure (Python)

```python
class TestDedupEngine:
    """Tests for the dedup engine (task 2.2, #16)."""

    def test_matching_cadastral_ref_merges(self, pg_conn):
        """Exact cadastral_ref match should merge two properties."""
        pass

    def test_phone_only_match_never_auto_merges(self, pg_conn):
        """Phone-in-description match alone should downgrade to a suggestion."""
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
cd dashboard && npx vitest run components/CandidateCard.test.tsx
```

### Factory Pattern (TypeScript)

```typescript
import type { Property, ProfileListingState } from '@/lib/types';

export const makeProperty = (
  overrides?: Partial<Property>
): Property => ({
  id: 'p1',
  price: 185000,
  m2Built: 78,
  rooms: 3,
  ...overrides,
});

export const makeProfileListingState = (
  overrides?: Partial<ProfileListingState>
): ProfileListingState => ({
  profileId: 'profile1',
  propertyId: 'p1',
  score: 0.72,
  pipelineStage: 'new',
  ...overrides,
});
```

### Component testing

```typescript
import { render, screen } from '@testing-library/react';
import { CandidateCard } from '@/components/CandidateCard';
import { makeProperty, makeProfileListingState } from '@/test/factories';

describe('CandidateCard', () => {
  it('should render the price', () => {
    const property = makeProperty({ price: 185000 });
    const state = makeProfileListingState();
    render(<CandidateCard property={property} state={state} />);
    expect(screen.getByText('185.000 €')).toBeTruthy();
  });
});
```

### API route testing

```typescript
import { POST } from '@/app/api/profiles/route';

describe('POST /api/profiles', () => {
  it('should create a profile and return 201', async () => {
    const req = new Request('http://localhost/api/profiles', {
      method: 'POST',
      body: JSON.stringify({ name: 'High-yield rentals' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
  });

  it('should reject an empty name', async () => {
    const req = new Request('http://localhost/api/profiles', {
      method: 'POST',
      body: JSON.stringify({ name: '' }),
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
expect(screen.getByText('185.000 €')).toBeTruthy();
```

### Not using factories
```python
# Bad - duplicated, inconsistent test data
def test_1():
    listing = {"price": Decimal("1.99"), "m2_built": 10}

def test_2():
    listing = {"price": Decimal("2.99")}  # Missing m2_built!

# Good - reusable factory
listing = make_listing(m2_built=10)
```

### Testing implementation instead of behavior
```python
# Bad - testing internal state
assert connector._page_offset == 5000

# Good - testing observable behavior
assert len(ingested_ids) == expected_count
```

## Best Practices

1. **Always use factory functions** for test data
2. **Test behavior, not implementation**
3. **Use descriptive test names** that describe the expected behavior
4. **Organize with describe/class blocks** by feature area
5. **Clear mocks between tests** (`jest.clearAllMocks()` / `MagicMock.reset_mock()`)
6. **Keep tests focused** — one behavior per test
7. **For connectors/ETL**: integration tests with real PG, skip if no connection
8. **For Dashboard**: unit tests for components, integration for API routes

---

## See also

- [docs/testing-strategy.md](../testing-strategy.md) — test tiers, commands, coverage thresholds, and the "must cover before risky change" list
