/**
 * Dashboard templates index.
 *
 * Each template exports { name, description, spec } where spec is a valid
 * DashboardSpec.  This module re-exports them as a typed array for the UI.
 */
import type { DashboardSpec } from "@/lib/schema";

import * as ventas from "./ventas";
import * as stock from "./stock";
import * as mayorista from "./mayorista";
import * as general from "./general";
import * as compras from "./compras";
import * as cobertura from "./cobertura";

export interface DashboardTemplate {
  /** Unique slug derived from the file name. */
  slug: string;
  /** Human-readable name shown in the UI. */
  name: string;
  /** Short description shown below the name. */
  description: string;
  /** The pre-built dashboard spec (valid DashboardSpec). */
  spec: DashboardSpec;
}

export const TEMPLATES: DashboardTemplate[] = [
  { slug: "ventas", name: ventas.name, description: ventas.description, spec: ventas.spec },
  { slug: "stock", name: stock.name, description: stock.description, spec: stock.spec },
  { slug: "mayorista", name: mayorista.name, description: mayorista.description, spec: mayorista.spec },
  { slug: "general", name: general.name, description: general.description, spec: general.spec },
  { slug: "compras", name: compras.name, description: compras.description, spec: compras.spec },
  { slug: "cobertura", name: cobertura.name, description: cobertura.description, spec: cobertura.spec },
];
