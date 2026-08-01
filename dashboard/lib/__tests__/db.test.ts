import { describe, it, expect } from "vitest";
import { validateReadOnly, SqlValidationError, stripLiteralsAndComments } from "../db";

describe("validateReadOnly", () => {
  // ─── Allowed statements ─────────────────────────────────────────────────

  it("allows simple SELECT", () => {
    expect(() => validateReadOnly("SELECT 1")).not.toThrow();
  });

  it("allows SELECT with leading whitespace", () => {
    expect(() => validateReadOnly("  SELECT * FROM ps_ventas")).not.toThrow();
  });

  it("allows lowercase select", () => {
    expect(() => validateReadOnly("select count(*) from ps_ventas")).not.toThrow();
  });

  it("allows WITH (CTE)", () => {
    expect(() =>
      validateReadOnly("WITH cte AS (SELECT 1) SELECT * FROM cte")
    ).not.toThrow();
  });

  it("allows EXPLAIN", () => {
    expect(() =>
      validateReadOnly("EXPLAIN SELECT * FROM ps_ventas")
    ).not.toThrow();
  });

  it("allows EXPLAIN ANALYZE", () => {
    expect(() =>
      validateReadOnly("EXPLAIN ANALYZE SELECT * FROM ps_ventas")
    ).not.toThrow();
  });

  // ─── Column/table names containing write keyword substrings ──────────────
  // Note: With the write-keyword check using \b word boundaries, column names
  // like "updated_at" contain "update" but NOT as a standalone word (\bUPDATE\b
  // does not match "updated_at" because "d" follows "update"). However, a
  // column literally named "update" would match. This is acceptable — such
  // column names are extremely rare and the safety tradeoff is worth it.

  it("allows SELECT with column named updated_at (substring, not a word match)", () => {
    expect(() =>
      validateReadOnly("SELECT updated_at FROM ps_ventas")
    ).not.toThrow();
  });

  it("allows SELECT with created_items (substring, not a word match)", () => {
    expect(() =>
      validateReadOnly("SELECT * FROM ps_created_items")
    ).not.toThrow();
  });

  it("allows SELECT with deleted flag (substring, not a word match)", () => {
    expect(() =>
      validateReadOnly("SELECT is_deleted, inserted_at FROM ps_ventas")
    ).not.toThrow();
  });

  // ─── Rejected write operations ──────────────────────────────────────────

  it("rejects INSERT", () => {
    expect(() =>
      validateReadOnly("INSERT INTO ps_ventas (id) VALUES (1)")
    ).toThrow(SqlValidationError);
  });

  it("rejects UPDATE", () => {
    expect(() =>
      validateReadOnly("UPDATE ps_ventas SET total_si = 0")
    ).toThrow(SqlValidationError);
  });

  it("rejects DELETE", () => {
    expect(() =>
      validateReadOnly("DELETE FROM ps_ventas WHERE id = 1")
    ).toThrow(SqlValidationError);
  });

  it("rejects DROP", () => {
    expect(() => validateReadOnly("DROP TABLE ps_ventas")).toThrow(
      SqlValidationError
    );
  });

  it("rejects ALTER", () => {
    expect(() =>
      validateReadOnly("ALTER TABLE ps_ventas ADD COLUMN x TEXT")
    ).toThrow(SqlValidationError);
  });

  it("rejects TRUNCATE", () => {
    expect(() => validateReadOnly("TRUNCATE ps_ventas")).toThrow(
      SqlValidationError
    );
  });

  it("rejects CREATE", () => {
    expect(() =>
      validateReadOnly("CREATE TABLE test (id INT)")
    ).toThrow(SqlValidationError);
  });

  it("rejects case-insensitive write operations", () => {
    expect(() => validateReadOnly("insert INTO ps_ventas VALUES (1)")).toThrow(
      SqlValidationError
    );
    expect(() => validateReadOnly("Update ps_ventas SET x = 1")).toThrow(
      SqlValidationError
    );
  });

  // ─── Edge cases ─────────────────────────────────────────────────────────

  it("rejects empty string", () => {
    expect(() => validateReadOnly("")).toThrow(SqlValidationError);
  });

  it("rejects whitespace-only string", () => {
    expect(() => validateReadOnly("   ")).toThrow(SqlValidationError);
  });

  it("rejects statements that don't start with allowed keywords", () => {
    expect(() => validateReadOnly("GRANT ALL ON ps_ventas TO user1")).toThrow(
      SqlValidationError
    );
  });

  it("rejects multi-statement SQL with semicolons", () => {
    expect(() =>
      validateReadOnly("SELECT 1; DROP TABLE ps_ventas")
    ).toThrow(SqlValidationError);
  });

  it("rejects SELECT with trailing semicolon", () => {
    expect(() =>
      validateReadOnly("SELECT 1;")
    ).toThrow(SqlValidationError);
  });

  // ─── Data-modifying CTEs ────────────────────────────────────────────────

  it("rejects data-modifying CTE (WITH ... DELETE ... RETURNING)", () => {
    expect(() =>
      validateReadOnly(
        "WITH deleted AS (DELETE FROM ps_ventas RETURNING *) SELECT * FROM deleted"
      )
    ).toThrow(SqlValidationError);
  });

  it("rejects data-modifying CTE (WITH ... INSERT ... RETURNING)", () => {
    expect(() =>
      validateReadOnly(
        "WITH ins AS (INSERT INTO ps_ventas (id) VALUES (1) RETURNING *) SELECT * FROM ins"
      )
    ).toThrow(SqlValidationError);
  });

  it("rejects data-modifying CTE (WITH ... UPDATE ... RETURNING)", () => {
    expect(() =>
      validateReadOnly(
        "WITH upd AS (UPDATE ps_ventas SET total_si = 0 RETURNING *) SELECT * FROM upd"
      )
    ).toThrow(SqlValidationError);
  });

  // ─── EXPLAIN ANALYZE with write ─────────────────────────────────────────

  it("rejects EXPLAIN ANALYZE INSERT (executes the write)", () => {
    expect(() =>
      validateReadOnly("EXPLAIN ANALYZE INSERT INTO ps_ventas (id) VALUES (1)")
    ).toThrow(SqlValidationError);
  });

  it("rejects EXPLAIN ANALYZE DELETE", () => {
    expect(() =>
      validateReadOnly("EXPLAIN ANALYZE DELETE FROM ps_ventas")
    ).toThrow(SqlValidationError);
  });

  // ─── SELECT INTO ────────────────────────────────────────────────────────

  it("rejects SELECT INTO (creates a new table)", () => {
    expect(() =>
      validateReadOnly("SELECT * INTO new_table FROM ps_ventas")
    ).toThrow(SqlValidationError);
  });

  it("rejects SELECT INTO TEMP (also creates a table)", () => {
    expect(() =>
      validateReadOnly("SELECT * INTO TEMP new_table FROM ps_ventas")
    ).toThrow(SqlValidationError);
  });

  it("rejects SELECT INTO TEMPORARY", () => {
    expect(() =>
      validateReadOnly("SELECT * INTO TEMPORARY new_table FROM ps_ventas")
    ).toThrow(SqlValidationError);
  });

  // ─── MERGE ──────────────────────────────────────────────────────────────

  it("rejects MERGE statement", () => {
    expect(() =>
      validateReadOnly("MERGE INTO ps_ventas USING source ON (ps_ventas.id = source.id)")
    ).toThrow(SqlValidationError);
  });

  it("rejects data-modifying CTE with MERGE", () => {
    expect(() =>
      validateReadOnly(
        "WITH src AS (SELECT 1 AS id) MERGE INTO ps_ventas USING src ON (ps_ventas.id = src.id)"
      )
    ).toThrow(SqlValidationError);
  });

  // ─── String literals and comments (should NOT cause false positives) ────

  it("allows SELECT with 'DELETE' inside a string literal", () => {
    expect(() =>
      validateReadOnly("SELECT 'DELETE' AS action FROM ps_ventas")
    ).not.toThrow();
  });

  it("allows SELECT with 'UPDATE' inside a string literal", () => {
    expect(() =>
      validateReadOnly("SELECT 'UPDATE' AS op FROM ps_ventas")
    ).not.toThrow();
  });

  it("allows SELECT with write keyword in a block comment", () => {
    expect(() =>
      validateReadOnly("SELECT /* DROP TABLE */ 1 FROM ps_ventas")
    ).not.toThrow();
  });

  it("allows SELECT with write keyword in a line comment", () => {
    expect(() =>
      validateReadOnly("SELECT 1 FROM ps_ventas -- DELETE this later")
    ).not.toThrow();
  });

  it("allows SELECT with quoted identifier containing write keyword", () => {
    expect(() =>
      validateReadOnly('SELECT "update" FROM ps_ventas')
    ).not.toThrow();
  });
});

describe("stripLiteralsAndComments", () => {
  it("strips single-quoted strings", () => {
    expect(stripLiteralsAndComments("SELECT 'DELETE' AS x")).toBe(
      "SELECT '' AS x"
    );
  });

  it("strips block comments", () => {
    expect(stripLiteralsAndComments("SELECT /* DROP */ 1")).toBe(
      "SELECT   1"
    );
  });

  it("strips line comments", () => {
    expect(stripLiteralsAndComments("SELECT 1 -- DROP")).toBe("SELECT 1 ");
  });

  it("strips double-quoted identifiers", () => {
    expect(stripLiteralsAndComments('SELECT "update" FROM t')).toBe(
      'SELECT "" FROM t'
    );
  });
});
