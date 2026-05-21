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

// Stable mapping ViewName → URL slug. Dashboard + Reports retained
// here so legacy bookmarks and direct URLs still resolve; they're
// just no longer surfaced in the nav. Remove from access.ts in a
// follow-up if you want to remove the pages entirely.
const VIEW_TO_PATH: Record<ViewName, string> = {
  "Dashboard":     "/dashboard",
  "Insights":      "/insights",
  "Forecast":      "/forecast",
  "Intake":        "/intake",
  "Action Center": "/action-center",
  "Action Center 3": "/action-center-3",
  "Action Center Fluent": "/action-center-fluent",
  "Action Center Flow":   "/action-center-flow",
  "Reports":       "/reports",
  "Settings":      "/settings",
  "Guide":         "/guide",
};

// Dashboard + Reports removed from the nav — Insights now covers
// both their surfaces. Forecast moved under Intake (Intake is the
// workflow's entry point; Forecast is the projection that follows).
// Guide sits in its own group at the bottom (renamed from "About"
// once the content grew past a simple landing).
const NAV_GROUPS: { label: string | null; items: ViewName[] }[] = [
  { label: null,         items: ["Insights"] },
  { label: "Workflow",   items: ["Intake", "Forecast"] },
  { label: "Operations", items: ["Action Center", "Action Center Flow"] },
  { label: "Admin",      items: ["Settings"] },
  { label: "Help",       items: ["Guide"] },
];

const STORAGE_KEY = "sidebar-collapsed";

// Sidebar width (expanded mode only — collapsed mode is a fixed slim
// rail). Persisted in localStorage so each user keeps their preferred
// rail width across sessions.
const WIDTH_STORAGE_KEY = "sidebar-width";
const DEFAULT_SIDEBAR_WIDTH = 288; // matches the previous w-72
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 480;

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

  // Width state — drag-to-resize handle on the right edge of the rail
  // (expanded mode only). Persisted to localStorage; clamped between
  // MIN/MAX so users can't shrink the rail past readability.
  const [width, setWidth] = useState<number>(DEFAULT_SIDEBAR_WIDTH);
  const [isResizing, setIsResizing] = useState<boolean>(false);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(WIDTH_STORAGE_KEY);
      if (stored) {
        const n = parseInt(stored, 10);
        if (!isNaN(n) && n >= MIN_SIDEBAR_WIDTH && n <= MAX_SIDEBAR_WIDTH) setWidth(n);
      }
    } catch { /* private mode / SSR */ }
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem(WIDTH_STORAGE_KEY, String(width)); } catch { /* ignore */ }
  }, [width]);

  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    setIsResizing(true);
    function onMove(ev: MouseEvent) {
      const next = Math.min(
        MAX_SIDEBAR_WIDTH,
        Math.max(MIN_SIDEBAR_WIDTH, startWidth + (ev.clientX - startX)),
      );
      setWidth(next);
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setIsResizing(false);
    }
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const initial = (name?.trim()?.[0] ?? "?").toUpperCase();

  return (
    <aside
      className={cn(
        "relative shrink-0 bg-ink-50 border-r border-ink-200 py-5 sticky top-0 h-screen overflow-y-auto",
        // Transition only while NOT actively dragging — otherwise the
        // 200ms ease lags behind the cursor and feels rubbery.
        !isResizing && "transition-[width] duration-200 ease-out",
        collapsed ? "w-14 px-2" : "px-4",
      )}
      style={!collapsed ? { width: `${width}px` } : undefined}
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

      {/* Drag-to-resize handle on the right edge — expanded mode only.
          Sits absolutely against the right border, full-height, with a
          slim hit area that highlights on hover. Double-click resets
          to the default width. */}
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuenow={width}
          title={`Drag to resize · Double-click to reset (${width}px)`}
          onMouseDown={startResize}
          onDoubleClick={() => setWidth(DEFAULT_SIDEBAR_WIDTH)}
          className={cn(
            "absolute top-0 right-0 h-full w-1.5 cursor-col-resize select-none",
            "hover:bg-brand/40 active:bg-brand/60 transition-colors",
            isResizing && "bg-brand/60",
          )}
        />
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
                  {/*
                    Both modes now show the per-view sprite icon (was
                    the access badge in expanded mode pre-PR). The lock
                    pip in the bottom-right preserves the 🔒 signal
                    without flattening the rail's distinctiveness — a
                    sea of ✅s defeats the point of having icons at all.
                  */}
                  <span className="relative inline-flex shrink-0" aria-hidden="true">
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
                  {!collapsed && <span>{VIEW_LABELS[view]}</span>}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </aside>
  );
}
