/**
 * Date helpers for weekly review windows and default action due dates.
 */

export function defaultDueDateThursdayAfter(weekStartIso: string): string {
  const [y, m, d] = weekStartIso.split("-").map((x) => parseInt(x, 10));
  const thu = new Date(y, m - 1, d + 10);
  const yy = thu.getFullYear();
  const mm = String(thu.getMonth() + 1).padStart(2, "0");
  const dd = String(thu.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
