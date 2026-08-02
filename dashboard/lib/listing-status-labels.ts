/**
 * Spanish labels for `listing.status` (etl/schema/init.sql's CHECK
 * constraint: active/reserved/sold/withdrawn/expired). Deliberately
 * dependency-free — moved out of a component file (#73 review) so it's
 * reusable from non-component code too, and kept out of lib/property-detail.ts
 * on purpose: that module imports the server-only `pg` client (lib/db-write),
 * and pulling a label map in from there would drag that import into whatever
 * client component uses the labels — the exact class of bug task 2.3 shipped
 * once already (Node builtins leaking into the browser bundle).
 */
export const STATUS_LABELS: Record<string, string> = {
  active: "Activo",
  reserved: "Reservado",
  sold: "Vendido",
  withdrawn: "Retirado",
  expired: "Caducado",
};
