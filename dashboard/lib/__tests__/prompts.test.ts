import { describe, it, expect } from "vitest";
import { buildGeneratePrompt, buildModifyPrompt } from "../prompts";
import { DashboardSpecSchema } from "../schema";
import { SQL_PAIRS } from "../knowledge";

describe("prompts", () => {
  describe("buildGeneratePrompt", () => {
    const prompt = buildGeneratePrompt();

    it("includes the role description", () => {
      expect(prompt).toContain("dashboard generator");
      expect(prompt).toContain("Spanish retail");
    });

    it("includes widget type definitions", () => {
      expect(prompt).toContain("kpi_row");
      expect(prompt).toContain("bar_chart");
      expect(prompt).toContain("line_chart");
      expect(prompt).toContain("area_chart");
      expect(prompt).toContain("donut_chart");
      expect(prompt).toContain("table");
      expect(prompt).toContain("number");
    });

    it("includes JSON format examples", () => {
      expect(prompt).toContain('"type": "kpi_row"');
      expect(prompt).toContain('"type": "bar_chart"');
      expect(prompt).toContain('"type": "line_chart"');
    });

    it("includes PostgreSQL schema", () => {
      expect(prompt).toContain("ps_ventas");
      expect(prompt).toContain("ps_lineas_ventas");
      expect(prompt).toContain("ps_articulos");
      expect(prompt).toContain("ps_stock_tienda");
    });

    it("includes business rules", () => {
      expect(prompt).toContain("total_si");
      expect(prompt).toContain("fecha_creacion");
      expect(prompt).toContain("ccrefejofacm");
    });

    it("includes SQL pairs", () => {
      expect(prompt).toContain("Example SQL Patterns");
      expect(prompt).toContain(`${SQL_PAIRS.length} pairs`);
    });

    it("includes output format spec", () => {
      expect(prompt).toContain("Output Format");
      expect(prompt).toContain('"title"');
      expect(prompt).toContain('"widgets"');
    });

    it("includes glossary field in output format example", () => {
      expect(prompt).toContain('"glossary"');
    });

    it("documents global dashboard filters and __gf tokens", () => {
      expect(prompt).toContain("Global dashboard filters");
      expect(prompt).toContain("__gf_tienda__");
      expect(prompt).toContain('"filters"');
    });

    it("includes rule requiring glossary to always be present", () => {
      expect(prompt).toContain('glossary" field MUST always be included');
    });

    it("includes glossary entry structure in output format", () => {
      expect(prompt).toContain('"term"');
      expect(prompt).toContain('"definition"');
    });

    it("includes SQL rules", () => {
      expect(prompt).toContain("SQL Rules");
      expect(prompt).toContain("NEVER use total");
      expect(prompt).toContain("almacén central");
    });

    it("includes table relationships", () => {
      expect(prompt).toContain("Table Relationships");
      expect(prompt).toContain("MANY_TO_ONE");
    });

    it("includes comparison_sql documentation", () => {
      expect(prompt).toContain("comparison_sql");
    });

    it("includes COMP_FROM and COMP_TO token documentation", () => {
      expect(prompt).toContain(":comp_from");
      expect(prompt).toContain(":comp_to");
    });

    it("includes all eight date placeholder tokens", () => {
      expect(prompt).toContain(":curr_from");
      expect(prompt).toContain(":curr_to");
      expect(prompt).toContain(":comp_from");
      expect(prompt).toContain(":comp_to");
      expect(prompt).toContain(":curr_mes_from");
      expect(prompt).toContain(":curr_mes_to");
      expect(prompt).toContain(":comp_mes_from");
      expect(prompt).toContain(":comp_mes_to");
    });

    it("includes colecciones and clave_temporada guidance", () => {
      expect(prompt).toContain("clave_temporada");
      expect(prompt).toContain("colec");
    });

    it("all JSON widget examples in the prompt validate against DashboardSpecSchema", () => {
      const jsonBlocks = [...prompt.matchAll(/```json\s*([\s\S]*?)```/g)].map(
        (m) => m[1].trim(),
      );
      const widgetBlocks = jsonBlocks.flatMap((block, blockIndex) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(block) as unknown;
        } catch (error) {
          throw new Error(
            `JSON block at index ${blockIndex} could not be parsed as JSON: ${error instanceof Error ? error.message : String(error)}\nBlock:\n${block}`,
          );
        }
        const candidates = Array.isArray(parsed) ? parsed : [parsed];
        return candidates
          .filter(
            (candidate): candidate is { type?: unknown } =>
              typeof candidate === "object" &&
              candidate !== null &&
              "type" in candidate,
          )
          .map((candidate) => ({ parsed: candidate, blockIndex }));
      });
      let validatedWidgetCount = 0;
      for (const { parsed, blockIndex } of widgetBlocks) {
        validatedWidgetCount += 1;
        const result = DashboardSpecSchema.safeParse({
          title: "test",
          widgets: [parsed],
        });
        expect(
          result.success,
          `Widget JSON block at index ${blockIndex} with type ${String(parsed.type ?? "unknown")} failed schema validation: ${result.success ? "" : result.error.message}\nBlock:\n${JSON.stringify(parsed)}`,
        ).toBe(true);
      }
      expect(validatedWidgetCount).toBeGreaterThan(0);
    });

    it("prohibits :comp_from/:comp_to in main widget sql (rule 15)", () => {
      expect(prompt).toContain("Do NOT reference :comp_from/:comp_to");
      expect(prompt).toContain("comparison_sql");
    });

    it("donut_chart table row lists x/y fields, not category/value", () => {
      const lines = prompt.split("\n");
      const donutRow = lines.find(
        (l) => l.includes("donut_chart") && l.includes("|")
      );
      expect(donutRow).toBeDefined();
      expect(donutRow).toContain("x, y");
      expect(donutRow).not.toMatch(/\bcategory\b.*\bvalue\b/);
    });

    it("donut_chart JSON example uses x/y field names, not category/value as top-level keys", () => {
      const blocks = [...prompt.matchAll(/```json\s*([\s\S]*?)```/g)].map(
        (m) => m[1].trim()
      );
      const donutBlock = blocks.find((b) => b.includes('"donut_chart"'));
      expect(donutBlock).toBeDefined();
      const parsed = JSON.parse(donutBlock!);
      expect(parsed).toHaveProperty("x");
      expect(parsed).toHaveProperty("y");
      expect(parsed).not.toHaveProperty("category");
      expect(parsed).not.toHaveProperty("value");
    });

    it("buildGeneratePrompt: widget-selection rules discourage donut in rectangular panels (issue #420)", () => {
      // Heading must be present
      expect(prompt).toContain("Widget selection rules");
      // Anti-empty-space message
      expect(prompt).toMatch(/never leave more than ~30% of a panel empty/i);
      // Donut guidance — only square/near-square or paired with dense surroundings
      expect(prompt).toMatch(/donut_chart[`*]*\s+is allowed\s+\*\*only when\*\*/i);
      expect(prompt).toMatch(/square or near-square/i);
      // Few-categories guidance
      expect(prompt).toMatch(/< 3 categor/);
      // Recommended alternative — must be a real renderable widget type
      expect(prompt).toMatch(/bar_chart|ranked_bars/);
    });

    it("WIDGET_TYPES table lists every renderable widget the prompt rules reference", () => {
      // ranked_bars and insights_strip must appear in the Widget Types table,
      // not only in the selection rules — otherwise the LLM cannot emit them.
      const lines = prompt.split("\n");
      const tableRow = (type: string) =>
        lines.find((l) => l.includes(`| ${type}`) && l.includes("|"));
      expect(tableRow("ranked_bars"), "ranked_bars row missing").toBeDefined();
      expect(tableRow("insights_strip"), "insights_strip row missing").toBeDefined();
    });

    it("does not advertise stacked/horizontal bar_chart variants (renderer has none)", () => {
      // Guard against re-introducing capability hallucinations.
      expect(prompt).not.toMatch(/100%\s*stacked\s*`?bar_chart`?/i);
      expect(prompt).not.toMatch(/horizontal\s*`?bar_chart`?/i);
    });

    it("donut_chart JSON example is valid according to DashboardSpecSchema", () => {
      const blocks = [...prompt.matchAll(/```json\s*([\s\S]*?)```/g)].map(
        (m) => m[1].trim()
      );
      const donutBlock = blocks.find((b) => b.includes('"donut_chart"'));
      expect(donutBlock).toBeDefined();
      const widget = JSON.parse(donutBlock!);
      const result = DashboardSpecSchema.safeParse({
        title: "Test",
        widgets: [widget],
      });
      expect(result.success).toBe(true);
    });
  });

  describe("buildModifyPrompt", () => {
    const sampleSpec = JSON.stringify({
      title: "Test Dashboard",
      widgets: [{ id: "w1", type: "number", title: "Test", sql: "SELECT 1" }],
    });
    const prompt = buildModifyPrompt(sampleSpec);

    it("includes the modifier role", () => {
      expect(prompt).toContain("dashboard modifier");
    });

    it("includes the current spec", () => {
      expect(prompt).toContain("Current Dashboard Spec");
      expect(prompt).toContain("Test Dashboard");
    });

    it("does not wrap current spec in markdown fences", () => {
      expect(prompt).not.toContain("```json\n" + sampleSpec);
      // New contract: spec goes through apply_dashboard_modification tool, not raw JSON output.
      expect(prompt).toContain("apply_dashboard_modification");
    });

    it("instructs to preserve existing widgets", () => {
      expect(prompt).toContain("Preserve all existing widgets");
    });

    it("instructs to continue id sequence", () => {
      expect(prompt).toContain("continue the id sequence");
    });

    it("still includes all reference sections", () => {
      expect(prompt).toContain("Widget Types");
      expect(prompt).toContain("PostgreSQL Schema");
      expect(prompt).toContain("Business Rules");
      expect(prompt).toContain("Example SQL Patterns");
    });

    it("instructs to preserve existing glossary entries", () => {
      expect(prompt).toContain("Preserve all existing glossary entries");
    });

    it("instructs to preserve global filters and __gf tokens", () => {
      expect(prompt).toContain("Global filters preservation");
      expect(prompt).toContain("__gf_<id>__");
    });

    it("instructs to add new glossary terms for new widgets", () => {
      expect(prompt).toContain("Add new entries for any new business terms");
    });

    it("instructs to always include glossary in the response", () => {
      expect(prompt).toContain("glossary' field MUST always be present");
    });

    it("includes the glossary field in the output format example", () => {
      expect(prompt).toContain('"glossary"');
    });

    it("prohibits :comp_from/:comp_to in main widget sql (rule 15)", () => {
      expect(prompt).toContain("Do NOT reference :comp_from/:comp_to");
      expect(prompt).toContain("comparison_sql");
    });

    it("buildModifyPrompt: widget-selection rules discourage donut in rectangular panels (issue #420)", () => {
      expect(prompt).toContain("Widget selection rules");
      expect(prompt).toMatch(/never leave more than ~30% of a panel empty/i);
      expect(prompt).toMatch(/donut_chart[`*]*\s+is allowed\s+\*\*only when\*\*/i);
    });
  });

  describe("date token regression — no CURRENT_DATE literals in prompt examples", () => {
    const DATE_COLS = /fecha_creacion|fecha_documento|fecha_envio|fecha_factura/;
    const CURRENT_DATE_LITERAL = /CURRENT_DATE/;
    const SQL_FIELDS = ["sql", "trend_sql", "comparison_sql"];

    function extractJsonBlocks(text: string): string[] {
      const blocks: string[] = [];
      const fence = /```json\s*([\s\S]*?)```/g;
      let m: RegExpExecArray | null;
      while ((m = fence.exec(text)) !== null) {
        blocks.push(m[1].trim());
      }
      return blocks;
    }

    function walkSqlFields(obj: unknown, field: string): string[] {
      const values: string[] = [];
      if (typeof obj === "string") return values;
      if (Array.isArray(obj)) {
        for (const item of obj) values.push(...walkSqlFields(item, field));
        return values;
      }
      if (obj && typeof obj === "object") {
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          if (k === field && typeof v === "string") {
            values.push(v);
          } else {
            values.push(...walkSqlFields(v, field));
          }
        }
      }
      return values;
    }

    it("all date-filtered SQL in prompt examples uses :curr_from/:curr_to, not CURRENT_DATE literals", () => {
      const combinedPrompt =
        buildGeneratePrompt() +
        "\n" +
        buildModifyPrompt(
          JSON.stringify({ title: "T", widgets: [{ id: "w1", type: "number", title: "T", sql: "SELECT 1" }] })
        );

      const blocks = extractJsonBlocks(combinedPrompt);
      expect(blocks.length).toBeGreaterThan(0);

      for (const block of blocks) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(block);
        } catch {
          continue;
        }

        for (const field of SQL_FIELDS) {
          for (const sql of walkSqlFields(parsed, field)) {
            if (DATE_COLS.test(sql) && CURRENT_DATE_LITERAL.test(sql)) {
              throw new Error(
                `Prompt example "${field}" contains CURRENT_DATE literal instead of :curr_from/:curr_to:\n${sql}`
              );
            }
          }
        }

        // anomaly_sql with generate_series is intentionally exempt
        for (const sql of walkSqlFields(parsed, "anomaly_sql")) {
          if (/generate_series/.test(sql)) continue;
          if (DATE_COLS.test(sql) && CURRENT_DATE_LITERAL.test(sql)) {
            throw new Error(
              `Prompt example "anomaly_sql" (non-generate_series) contains CURRENT_DATE literal:\n${sql}`
            );
          }
        }
      }
    });
  });
});
