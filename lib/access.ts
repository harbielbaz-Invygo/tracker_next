/**
 * Pure access-control rules — no NextAuth, no DB, no Node-only imports.
 * Safe for both client components and the Edge runtime.
 *
 * Roles:
 *   - admin: everything
 *   - ops:   tracker (Forecast, Intake, Cockpit, Dashboard)
 *   - guest: Dashboard only (read)
 *
 * Page model:
 *   - Forecast = Pre-PO bet, captured before PO is signed (Partnership confidence)
 *   - Intake   = Post-PO main flow, PDF-driven, action picker per batch
 *   - Cockpit  = Daily Ops surface — update action statuses across all batches
 *   - Settings = Admin: edit departments, action types, dependencies, lead times
 */

export type Role = "admin" | "ops" | "guest";

export const ALL_VIEWS = [
  "Dashboard",
  "Forecast",
  "Intake",
  "Cockpit",
  "Reports",
  "Settings",
] as const;
export type ViewName = (typeof ALL_VIEWS)[number];

/** Access map. */
export const ACCESS: Record<ViewName, Role[] | "public"> = {
  "Dashboard": "public",
  "Forecast":  ["ops", "admin"],
  "Intake":    ["ops", "admin"],
  "Cockpit":   ["ops", "admin"],
  "Reports":   ["ops", "admin"],
  "Settings":  ["admin"],
};

/** Sidebar display labels. Equal to names since the rename. */
export const VIEW_LABELS: Record<ViewName, string> = {
  "Dashboard": "Dashboard",
  "Forecast":  "Forecast",
  "Intake":    "Intake",
  "Cockpit":   "Cockpit",
  "Reports":   "Reports",
  "Settings":  "Settings",
};

export function canAccess(view: ViewName, role: Role): boolean {
  const rule = ACCESS[view];
  if (rule === "public") return true;
  return rule.includes(role);
}
