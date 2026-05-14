"use client";

/**
 * Sidebar — auth widget at top, then grouped nav (Partnership / Operations / Admin).
 * Mirrors the Streamlit sidebar in `tracker_v1/dashboard.py`. Same access logic,
 * same group labels, same access-badge convention (🌐 / ✅ / 🔒).
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { ALL_VIEWS, ACCESS, VIEW_LABELS, canAccess, type Role, type ViewName } from "@/lib/access";
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

  return (
    <aside className="w-72 shrink-0 bg-ink-50 border-r border-ink-200 px-4 py-5 sticky top-0 h-screen overflow-y-auto">
      {/* Auth widget */}
      <div className="mb-2">
        {isGuest ? (
          <Link href="/login" className="btn btn-primary w-full">
            🔐 Sign In
          </Link>
        ) : (
          <div>
            <p className="font-semibold text-midnight">👤 {name}</p>
            <p className="text-xs text-ink-500 mb-2">
              Role: <code className="text-midnight">{role}</code>
            </p>
            <button onClick={() => signOut()} className="btn w-full">Logout</button>
          </div>
        )}
        <p className="text-xs text-ink-500 mt-2">
          {isGuest ? "👁️ You are browsing as Guest." : `Signed in as @${username}`}
        </p>
      </div>

      <hr className="my-4 border-ink-200" />

      <p className="text-xs font-medium text-ink-500 mb-2">Navigation</p>

      {NAV_GROUPS.map(({ label, items }, gi) => (
        <div key={gi} className={gi > 0 ? "mt-3" : ""}>
          {label && (
            <p className="text-[0.7rem] font-medium text-ink-500 mb-1 px-1 tracking-wide">
              {label}
            </p>
          )}
          <div className="space-y-1">
            {items.map((view) => {
              const href = VIEW_TO_PATH[view];
              const active = pathname === href;
              return (
                <Link
                  key={view}
                  href={href as any}
                  title={view}
                  className={cn("nav-btn", active && "nav-btn-active")}
                >
                  <span className="mr-1" aria-hidden="true">{accessBadge(view, role)}</span>
                  <span>{VIEW_LABELS[view]}</span>
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </aside>
  );
}
