/**
 * Pure access-control rules — no NextAuth, no DB, no Node-only imports.
 * Safe for both client components and the Edge runtime.
 *
 * Roles:
 *   - admin: everything
 *   - ops:   tracker (Forecast, Intake, Action Center, Dashboard)
 *   - guest: Dashboard only (read)
 *
 * Page model:
 *   - Forecast      = Pre-PO bet, captured before PO is signed (Partnership confidence)
 *   - Intake        = Post-PO main flow, PDF-driven, action picker per batch
 *   - Action Center = Daily Ops surface — update action statuses across all batches
 *   - Settings      = Admin: edit departments, action types, dependencies, lead times
 */

export type Role = "admin" | "ops" | "guest";

export const ALL_VIEWS = [
  "Dashboard",
  "Insights",
  "Forecast",
  "Intake",
  "Action Center",
  "Action Center 3",
  "Action Center Fluent",
  "Reports",
  "Settings",
  "Guide",
] as const;
export type ViewName = (typeof ALL_VIEWS)[number];

/** Access map. */
export const ACCESS: Record<ViewName, Role[] | "public"> = {
  "Dashboard":     "public",
  // New unified view (Dashboard + Reports proposal). Same audience as
  // the underlying surfaces it merges — read-only ops + admin. We can
  // open it up to guest later once the design lands.
  "Insights":      ["ops", "admin"],
  "Forecast":      ["ops", "admin"],
  "Intake":        ["ops", "admin"],
  "Action Center": ["ops", "admin"],
  // Test surface — redesigned External-Phase view. Same audience as
  // the main Action Center while it's being evaluated.
  "Action Center 3": ["ops", "admin"],
  // Fluent UI v9 take on the Action Center surface — separate test
  // surface so the design-system pick is testable in isolation.
  "Action Center Fluent": ["ops", "admin"],
  "Reports":       ["ops", "admin"],
  "Settings":      ["admin"],
  // Public — pages overview, workflow, roles, glossary, tech stack.
  // Renamed from "About" once the content grew past a simple landing.
  "Guide":         "public",
};

/** Sidebar display labels. Equal to names since the rename. */
export const VIEW_LABELS: Record<ViewName, string> = {
  "Dashboard":     "Dashboard",
  "Insights":      "Insights",
  "Forecast":      "Forecast",
  "Intake":        "Intake",
  "Action Center": "Action Center",
  "Action Center 3": "Action Center 3",
  "Action Center Fluent": "Action Center · Fluent",
  "Reports":       "Reports",
  "Settings":      "Settings",
  "Guide":         "Guide",
};

export function canAccess(view: ViewName, role: Role): boolean {
  const rule = ACCESS[view];
  if (rule === "public") return true;
  return rule.includes(role);
}
