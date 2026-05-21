/**
 * Per-view icons used in the sidebar (mainly when collapsed, where the
 * access badges (✅/🔒/🌐) collapse to a wall of identical green checks
 * and you can't tell Dashboard from Reports) and in page headers
 * (`PageHeader` component) so the rail + the body heading visually match.
 *
 * All icons are inline SVG, sized via the `className` prop (default
 * h-5 w-5 — the sidebar size), and use `currentColor` so they inherit
 * the surrounding text colour — they turn white automatically when the
 * link is active (brand background) without any extra prop wiring.
 *
 * Style: outline / stroke-based, 1.75 stroke width, rounded joins.
 * Matches a generic heroicons-style aesthetic without adding a dep.
 */
import type { ViewName } from "@/lib/access";

type IconProps = { className?: string };

function IconBase({
  children, label, className = "h-5 w-5",
}: {
  children: React.ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role="img"
      aria-label={label}
    >
      {children}
    </svg>
  );
}

/** 2×2 grid of rounded panels — the canonical "dashboard" affordance. */
function DashboardIcon({ className }: IconProps) {
  return (
    <IconBase label="Dashboard icon" className={className}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </IconBase>
  );
}

/** Lightbulb — universal "insights / ideas" mark. */
function InsightsIcon({ className }: IconProps) {
  return (
    <IconBase label="Insights icon" className={className}>
      <path d="M9 17.5h6" />
      <path d="M10 20.5h4" />
      <path d="M12 3.5a6 6 0 0 0-3.5 10.8c.5.4.8 1 .8 1.7h5.4c0-.7.3-1.3.8-1.7A6 6 0 0 0 12 3.5Z" />
    </IconBase>
  );
}

/** Chart with a trending-up arrow — "what's coming next". */
function ForecastIcon({ className }: IconProps) {
  return (
    <IconBase label="Forecast icon" className={className}>
      <path d="M3.5 20.5h17" />
      <path d="M4 16l4.5-4.5 3.5 3.5 4.5-6" />
      <path d="M14.5 9h3v3" />
    </IconBase>
  );
}

/** Inbox tray with a downward arrow — work coming "in". */
function IntakeIcon({ className }: IconProps) {
  return (
    <IconBase label="Intake icon" className={className}>
      <path d="M3.5 13.5v5a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1v-5" />
      <path d="M7.5 13.5h2l1 2h3l1-2h2" />
      <path d="M12 3.5v8" />
      <path d="M9 8.5l3 3 3-3" />
    </IconBase>
  );
}

/** Bolt / spark — Action Center is where ops actually does the work. */
function ActionCenterIcon({ className }: IconProps) {
  return (
    <IconBase label="Action Center icon" className={className}>
      <path d="M13 2.5 4 14h7l-1 7.5L20 10h-7l0-7.5Z" />
    </IconBase>
  );
}

/** Document with content lines — "reports". */
function ReportsIcon({ className }: IconProps) {
  return (
    <IconBase label="Reports icon" className={className}>
      <path d="M6 3.5h9l4 4v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z" />
      <path d="M14.5 3.5v4h4.5" />
      <path d="M8 13h8" />
      <path d="M8 16.5h8" />
      <path d="M8 9.5h3" />
    </IconBase>
  );
}

/** Cog — Settings. Outer 8-point gear + inner ring. */
function SettingsIcon({ className }: IconProps) {
  return (
    <IconBase label="Settings icon" className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 14.5a1.7 1.7 0 0 0 .4 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.4 1.7 1.7 0 0 0-1.1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.4l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .4-1.9 1.7 1.7 0 0 0-1.6-1.1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.4-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.4h.1a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1.1 1.6 1.7 1.7 0 0 0 1.9-.4l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.4 1.9v.1a1.7 1.7 0 0 0 1.6 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </IconBase>
  );
}

/** Open book — Guide page (renamed from "About"). */
function GuideIcon({ className }: IconProps) {
  return (
    <IconBase label="Guide icon" className={className}>
      <path d="M3.5 5.5h6a3 3 0 0 1 3 3v11a2 2 0 0 0-2-2h-7Z" />
      <path d="M20.5 5.5h-6a3 3 0 0 0-3 3v11a2 2 0 0 1 2-2h7Z" />
    </IconBase>
  );
}

const ICONS: Record<ViewName, (p: IconProps) => React.ReactElement> = {
  "Dashboard":     DashboardIcon,
  "Insights":      InsightsIcon,
  "Forecast":      ForecastIcon,
  "Intake":        IntakeIcon,
  "Action Center": ActionCenterIcon,
  // Test surface — reuse the Action Center glyph so the two share a
  // visual lineage in the sidebar.
  "Action Center 3": ActionCenterIcon,
  "Action Center Fluent": ActionCenterIcon,
  "Action Center Flow": ActionCenterIcon,
  "Reports":       ReportsIcon,
  "Settings":      SettingsIcon,
  "Guide":         GuideIcon,
};

/**
 * Renders the icon for a given view. Used by the collapsed sidebar so
 * each nav target is visually distinct at a glance, and by the page
 * headers so the rail + heading visually match. The icon inherits the
 * parent's text colour via currentColor; pass a `className` to override
 * the default size (h-5 w-5).
 */
export function ViewIcon({ view, className }: { view: ViewName; className?: string }) {
  const Icon = ICONS[view];
  return <Icon className={className} />;
}
