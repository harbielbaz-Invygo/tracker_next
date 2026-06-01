/**
 * PageHeader — standard page heading used at the top of each authed
 * route. Pairs the per-view `ViewIcon` (same artwork as the sidebar
 * rail) with the page title + optional subtitle, so the body heading
 * visually echoes the rail item the user just clicked.
 *
 * Style tokens (icon size, brand colour, mb-6 below subtitle) live
 * here so future global tweaks are a one-file change.
 */
import { ViewIcon } from "@/components/view-icons";
import type { ViewName } from "@/lib/access";
import { cn } from "@/lib/utils";

export default function PageHeader({
  view, title, subtitle, className, subtitleClassName,
}: {
  view: ViewName;
  /** Override the displayed title. Defaults to the view name. */
  title?: string;
  /** Optional subhead — rendered under the h1 in muted text. */
  subtitle?: React.ReactNode;
  /** Extra classes on the outer wrapper, e.g. mb-* overrides. */
  className?: string;
  /**
   * Override classes on the subtitle <p>. Defaults to `max-w-prose`
   * (caps line length for readability). Pass `max-w-none` to let a
   * short single-sentence subtitle run full width on one line.
   */
  subtitleClassName?: string;
}) {
  const displayTitle = title ?? view;
  return (
    <header className={cn("mb-6", className)}>
      <div className="flex items-center gap-3 mb-1">
        <span className="text-brand shrink-0" aria-hidden="true">
          <ViewIcon view={view} className="h-8 w-8" />
        </span>
        <h1 className="text-3xl font-bold leading-none">{displayTitle}</h1>
      </div>
      {subtitle && (
        <p className={cn("text-sm text-ink-500", subtitleClassName ?? "max-w-prose")}>
          {subtitle}
        </p>
      )}
    </header>
  );
}
