"use client";

import {
  KpiRow,
  BarChartWidget,
  LineChartWidget,
  AreaChartWidget,
  DonutChartWidget,
  TableWidget,
  NumberWidget,
} from "@/components/widgets";
import type {
  KpiRowWidget,
  BarChartWidget as BarChartSpec,
  LineChartWidget as LineChartSpec,
  AreaChartWidget as AreaChartSpec,
  DonutChartWidget as DonutChartSpec,
  TableWidget as TableSpec,
  NumberWidget as NumberSpec,
} from "@/lib/schema";
import type { WidgetData } from "@/components/widgets";

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const kpiWidget: KpiRowWidget = {
  type: "kpi_row",
  items: [
    { label: "Ventas Netas", sql: "", format: "currency", prefix: "\u20ac" },
    { label: "Tickets", sql: "", format: "number" },
    { label: "Ticket Medio", sql: "", format: "currency", prefix: "\u20ac" },
    { label: "Margen", sql: "", format: "percent" },
  ],
};

const kpiData: (WidgetData | null)[] = [
  { columns: ["value"], rows: [[125340.5]] },
  { columns: ["value"], rows: [[4521]] },
  { columns: ["value"], rows: [[27.72]] },
  { columns: ["value"], rows: [[34.8]] },
];

const barWidget: BarChartSpec = {
  type: "bar_chart",
  title: "Ventas por Tienda",
  sql: "",
  x: "tienda",
  y: "ventas",
};

const barData: WidgetData = {
  columns: ["tienda", "ventas"],
  rows: [
    ["Madrid Centro", 45200],
    ["Barcelona", 38900],
    ["Valencia", 22100],
    ["Sevilla", 18500],
    ["Bilbao", 15300],
  ],
};

const lineWidget: LineChartSpec = {
  type: "line_chart",
  title: "Tendencia Semanal de Ventas",
  sql: "",
  x: "semana",
  y: "ventas",
};

const lineData: WidgetData = {
  columns: ["semana", "ventas"],
  rows: [
    ["Sem 1", 18500],
    ["Sem 2", 22300],
    ["Sem 3", 19800],
    ["Sem 4", 25100],
    ["Sem 5", 28400],
    ["Sem 6", 31200],
  ],
};

const areaWidget: AreaChartSpec = {
  type: "area_chart",
  title: "Evolucion Mensual de Ingresos",
  sql: "",
  x: "mes",
  y: "ingresos",
};

const areaData: WidgetData = {
  columns: ["mes", "ingresos"],
  rows: [
    ["Ene", 95000],
    ["Feb", 102000],
    ["Mar", 118000],
    ["Abr", 125000],
    ["May", 110000],
    ["Jun", 135000],
  ],
};

const donutWidget: DonutChartSpec = {
  type: "donut_chart",
  title: "Mix por Familia",
  sql: "",
  x: "familia",
  y: "porcentaje",
};

const donutData: WidgetData = {
  columns: ["familia", "porcentaje"],
  rows: [
    ["Camisetas", 35],
    ["Pantalones", 25],
    ["Calzado", 20],
    ["Accesorios", 12],
    ["Otros", 8],
  ],
};

const tableWidget: TableSpec = {
  type: "table",
  title: "Top 10 Articulos por Ventas",
  sql: "",
};

const tableData: WidgetData = {
  columns: ["Referencia", "Descripcion", "Unidades", "Importe"],
  rows: [
    ["CAM-001", "Camiseta basica blanca", 245, 4900],
    ["PAN-012", "Pantalon vaquero slim", 189, 9450],
    ["CAL-005", "Zapatilla deportiva", 156, 11700],
    ["CAM-003", "Camiseta estampada", 134, 3350],
    ["ACC-008", "Cinturon cuero", 121, 2420],
    ["PAN-007", "Pantalon chino beige", 98, 3920],
    ["CAM-015", "Polo manga corta", 87, 2610],
    ["CAL-002", "Bota casual", 76, 6840],
    ["ACC-001", "Gafas de sol", 72, 2880],
    ["CAM-009", "Sudadera con capucha", 65, 3250],
  ],
};

const numberWidget: NumberSpec = {
  type: "number",
  title: "Total Ventas del Mes",
  sql: "",
  format: "currency",
  prefix: "\u20ac",
};

const numberData: WidgetData = {
  columns: ["total"],
  rows: [[253891.45]],
};

// Empty state widget for demo
const emptyBarWidget: BarChartSpec = {
  type: "bar_chart",
  title: "Grafico sin datos (estado vacio)",
  sql: "",
  x: "x",
  y: "y",
};

// ---------------------------------------------------------------------------
// Demo page
// ---------------------------------------------------------------------------

export default function DemoPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">
          Demo de Widgets
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Todos los tipos de widget con datos de ejemplo.
        </p>
      </div>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-gray-700">
          KPI Row
        </h2>
        <KpiRow widget={kpiWidget} data={kpiData} />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-gray-700">
          Number (numero grande)
        </h2>
        <div className="max-w-sm">
          <NumberWidget widget={numberWidget} data={numberData} />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-gray-700">
          Bar Chart
        </h2>
        <BarChartWidget widget={barWidget} data={barData} />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-gray-700">
          Line Chart
        </h2>
        <LineChartWidget widget={lineWidget} data={lineData} />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-gray-700">
          Area Chart
        </h2>
        <AreaChartWidget widget={areaWidget} data={areaData} />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-gray-700">
          Donut Chart
        </h2>
        <div className="max-w-md">
          <DonutChartWidget widget={donutWidget} data={donutData} />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-gray-700">
          Table (con ordenacion)
        </h2>
        <TableWidget widget={tableWidget} data={tableData} />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-gray-700">
          Estado vacio
        </h2>
        <BarChartWidget widget={emptyBarWidget} data={null} />
      </section>
    </div>
  );
}
