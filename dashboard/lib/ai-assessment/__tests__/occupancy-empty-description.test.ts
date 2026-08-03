/**
 * A property whose active listings carry no description must never reach a
 * positive occupancy verdict (#156 review, must-fix 2).
 *
 * `formatListing` (system-prompt.ts) emits no DESCRIPCIÓN block for a listing
 * with a null/empty description, so a property whose only active listings are
 * description-less hands the model zero text to read. The eje-2/eje-3 silence
 * rule then produces `compraventa`/`pleno_dominio` "because nothing
 * contradicts it" — but nothing contradicts it because there is nothing to
 * read at all, not because the adverts are silent on a topic they otherwise
 * discuss. `loadPropertyListings` must treat that the same as "no listings":
 * `assessPropertyOccupancy` already turns an empty array into
 * `NoListingsError`, which is the existing, callers-already-handle-it 404
 * path ("La propiedad no tiene anuncios activos que evaluar.") — reusing it
 * here keeps "we never looked" and "we looked at nothing" the same signal.
 *
 * Mocks @/lib/db-write so no live DB is needed — this is a pure parsing/gating
 * unit, not the real-schema round-trip (that's occupancy.integration.test.ts).
 */
import { describe, expect, it, vi } from "vitest";

const mockSql = vi.fn();
vi.mock("@/lib/db-write", () => ({
  sql: (...a: unknown[]) => mockSql(...a),
}));

import {
  loadPropertyListings,
  assessPropertyOccupancy,
  NoListingsError,
} from "../occupancy";

function propertyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "7",
    property_type: "piso",
    m2_built: "90",
    rooms: 3,
    bathrooms: 2,
    floor: "3",
    address: "Calle Test Ocupacion 1",
    city: "Madrid",
    province: "Madrid",
    ...overrides,
  };
}

function listingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "101",
    source: "fotocasa",
    url: null,
    status: "active",
    operation: "sale",
    current_price: "200000",
    description: null,
    first_seen_at: null,
    ...overrides,
  };
}

/** Route the two loadPropertyListings queries to the right canned rows. */
function mockDb(propertyRows: unknown[], listingRows: unknown[]) {
  mockSql.mockImplementation(async (query: string) => {
    if (typeof query === "string" && query.includes("FROM property")) {
      return propertyRows;
    }
    return listingRows;
  });
}

describe("loadPropertyListings — description-less listings", () => {
  it("returns no listings when every active advert has a null description", async () => {
    mockDb([propertyRow()], [listingRow({ description: null })]);

    expect(await loadPropertyListings(7)).toEqual([]);
  });

  it("returns no listings when every active advert has a whitespace-only description", async () => {
    mockDb(
      [propertyRow()],
      [
        listingRow({ id: "101", description: "" }),
        listingRow({ id: "102", source: "milanuncios", description: "   " }),
      ],
    );

    expect(await loadPropertyListings(7)).toEqual([]);
  });

  it("still returns listings once AT LEAST ONE advert has a real description", async () => {
    mockDb(
      [propertyRow()],
      [
        listingRow({ id: "101", description: null }),
        listingRow({
          id: "102",
          source: "milanuncios",
          description: "Piso luminoso, tres dormitorios.",
        }),
      ],
    );

    const listings = await loadPropertyListings(7);
    expect(listings).toHaveLength(2);
  });
});

describe("assessPropertyOccupancy — a property with nothing to read never gets a positive verdict from silence", () => {
  it("throws NoListingsError instead of asking the model to infer from zero text", async () => {
    mockDb([propertyRow()], [listingRow({ description: null })]);

    await expect(assessPropertyOccupancy(7)).rejects.toThrow(NoListingsError);
  });
});
