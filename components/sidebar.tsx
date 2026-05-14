"use client";

/**
 * Sidebar — auth widget at top, then grouped nav (Partnership / Operations / Admin).
 * Mirrors the Streamlit sidebar in `tracker_v1/dashboard.py`. Same access logic,
 * same group labels, same access-badge convention (🌐 / ✅ / 🔒).
 *
 * Collapse behaviour:
 *   The sidebar can be shrunk to a slim rail by clicking the chevron at the
 *   top. State is persisted in localStorage under "sidebar-collapsed" so it
 *   survives navigation + reloads. In collapsed mode the nav becomes
 *   icon-only (just the access badge); hover tooltips reveal the full label.
 *   The auth widget compresses to an initial + logout icon.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { useEffect, useState } from "react";
import { ALL_VIEWS, ACCESS, VIEW_LABELS, canAccess, type Role, type ViewName } from "@/lib/access";
import { ViewIcon } from "@/components/view-icons";
import { cn } from "@/lib/utils";

// Stable mapping ViewName → URL slug
const VIEW_TO_PATH: Record<ViewName, string> = {
  "Dashboard":     "/dashboard",
  "Insights":      "/insights",
  "Forecast":      "/forecast",
  "Intake":        "/intake",
  "Action Center": "/action-center",
  "Reports":       "/reports",
  "Settings":      "/settings",
};

const NAV_GROUPS: { label: string | null; items: ViewName[] }[] = [
  { label: null,         items: ["Dashboard", "Insights"] },
  { label: "Workflow",   items: ["Forecast", "Intake"] },
  { label: "Operations", items: ["Action Center", "Reports"] },
  { label: "Admin",      items: ["Settings"] },
];

const STORAGE_KEY = "sidebar-collapsed";

function accessBadge(view: ViewName, role: Role) {
  const rule = ACCESS[view];
  if (rule === "public") return "🌐";
  if (canAccess(view, role)) return "✅";
  return "🔒";
}

export default function Sidebar({ role, name, username }: {
  role: Role; name: string; username: string;
}) {
  const pathname = usePathname();
  const isGuest = role === "guest";

  // Collapse state — initialised from localStorage on mount so the rail
  // doesn't flicker between SSR + hydration. Default expanded.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "1") setCollapsed(true);
    } catch {
      // localStorage can throw in private mode / disabled storage; ignore.
    }
  }, []);
  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch { /* ignore */ }
      return next;
    });
  }

  const initial = (name?.trim()?.[0] ?? "?").toUpperCase();

  return (
    <aside
      className={cn(
        "shrink-0 bg-ink-50 border-r border-ink-200 py-5 sticky top-0 h-screen overflow-y-auto",
        "transition-[width] duration-200 ease-out",
        collapsed ? "w-14 px-2" : "w-72 px-4",
      )}
      aria-label="Primary navigation"
    >
      {/* Collapse toggle — chevron sits at the very top so it's reachable
          regardless of which mode the rail is in. Title flips so the
          hover tooltip matches the click result. */}
      <div className={cn("mb-3 flex", collapsed ? "justify-center" : "justify-end")}>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="h-7 w-7 rounded-md border border-ink-200 bg-white text-ink-600
                     hover:bg-ink-100 hover:text-midnight transition-colors
                     focus-visible:outline-2 focus-visible:outline-brand
                     focus-visible:outline-offset-2 flex items-center justify-center text-sm"
        >
          {collapsed ? "›" : "‹"}
        </button>
      </div>

      {/* Auth widget */}
      <div className="mb-2">
        {isGuest ? (
          collapsed ? (
            <Link
              href="/login"
              title="Sign In"
              aria-label="Sign In"
              className="btn btn-primary w-full px-0 justify-center"
            >
              🔐
            </Link>
          ) : (
            <Link href="/login" className="btn btn-primary w-full">
              🔐 Sign In
            </Link>
          )
        ) : collapsed ? (
          <div className="flex flex-col items-center gap-2">
            <div
              title={`${name} (${role})\nSigned in as @${username}`}
              className="h-9 w-9 rounded-full bg-brand text-white flex items-center justify-center
                         font-semibold text-sm select-none"
              aria-label={`Signed in as ${name}, role ${role}`}
            >
              {initial}
            </div>
            <button
              onClick={() => signOut()}
              title="Logout"
              aria-label="Logout"
              className="btn w-full px-0 justify-center text-sm"
            >
              ⎋
            </button>
          </div>
        ) : (
          <div>
            <p className="font-semibold text-midnight">👤 {name}</p>
            <p className="text-xs text-ink-500 mb-2">
              Role: <code className="text-midnight">{role}</code>
            </p>
            <button onClick={() => signOut()} className="btn w-full">Logout</button>
          </div>
        )}
        {!collapsed && (
          <p className="text-xs text-ink-500 mt-2">
            {isGuest ? "👁️ You are browsing as Guest." : `Signed in as @${username}`}
          </p>
        )}
      </div>

      <hr className="my-4 border-ink-200" />

      {!collapsed && (
        <p className="text-xs font-medium text-ink-500 mb-2">Navigation</p>
      )}

      {NAV_GROUPS.map(({ label, items }, gi) => (
        <div key={gi} className={gi > 0 ? "mt-3" : ""}>
          {label && !collapsed && (
            <p className="text-[0.7rem] font-medium text-ink-500 mb-1 px-1 tracking-wide">
              {label}
            </p>
          )}
          {/* Thin divider replaces the group label in collapsed mode so the
              visual grouping is still preserved without taking horizontal
              space. */}
          {label && collapsed && gi > 0 && (
            <hr className="my-2 border-ink-200" aria-hidden="true" />
          )}
          <div className="space-y-1">
            {items.map((view) => {
              const href = VIEW_TO_PATH[view];
              const active = pathname === href;
              const badge = accessBadge(view, role);
              // Locked views are kept visible (server-side gating still
              // applies), but we visually deprioritise them in collapsed
              // mode so the rail still telegraphs "you can't enter here".
              const locked = badge === "🔒";
              return (
                <Link
                  key={view}
                  href={href as any}
                  title={collapsed ? `${badge} ${VIEW_LABELS[view]}` : view}
                  aria-label={VIEW_LABELS[view]}
                  className={cn(
                    "nav-btn",
                    active && "nav-btn-active",
                    collapsed && "justify-center px-0",
                    collapsed && locked && !active && "opacity-50",
                  )}
                >
                  {collapsed ? (
                    // Per-view icon (sprite) replaces the access badge
                    // in collapsed mode so each rail item is visually
                    // distinct at a glance. We layer a tiny lock pip
                    // bottom-right for inaccessible views to retain the
                    // 🔒 information without taking horizontal space.
                    <span className="relative inline-flex" aria-hidden="true">
                      <ViewIcon view={view} />
                      {locked && (
                        <span
                          className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5
                                     rounded-full bg-white text-[0.55rem] leading-none
                                     flex items-center justify-center
                                     border border-ink-300 text-ink-600"
                          title="Locked"
                        >
                          🔒
                        </span>
                      )}
                    </span>
                  ) : (
                    <>
                      <span className="mr-1" aria-hidden="true">{badge}</span>
                      <span>{VIEW_LABELS[view]}</span>
                    </>
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </aside>
  );
}
