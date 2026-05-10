/**
 * Pure Slack-message formatter for the Cockpit page.
 *
 * Lives in its own file (separate from `lib/cockpit-data.ts`) so that
 * client components can `import { formatStatusCheckMessage }` without
 * webpack pulling `better-sqlite3` into the browser bundle. The DB
 * queries stay in cockpit-data.ts; this module only takes the data.
 *
 * Types are imported as type-only references — they get erased at compile
 * time so cockpit-data.ts never appears in the client runtime graph.
 */
import type { ActionDetail, DrawerData } from "./cockpit-data";

const STATUS_ICON: Record<ActionDetail["status"], string> = {
  waiting: "⏳",
  blocked: "⛔",
  done:    "✅",
  skipped: "⏭",
};

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

function ordinal(n: number): string {
  const suffix = (n % 100 >= 10 && n % 100 <= 20) ? "th"
    : (["st","nd","rd"][((n - 1) % 10)] ?? "th");
  return `${n}${suffix}`;
}

function fmtDate(iso: string): string {
  const parts = iso.split("-").map((x) => parseInt(x, 10));
  if (parts.length < 3 || !Number.isFinite(parts[1]) || !Number.isFinite(parts[2])) return iso;
  return `${MONTH_NAMES[parts[1] - 1]} ${ordinal(parts[2])}`;
}

/**
 * Build a Slack-ready status-check / follow-up message for a single batch.
 *
 * Layout:
 *   📋 Status check — {batchCode}
 *   {dealer} · {qty}× {model}
 *   {closure tag if closed} OR Promised: {date} · {status}
 *
 *   Where do we stand?
 *
 *   @Stakeholder (Department)
 *   ✅ {doneLabel} · {date}
 *   ⏳ {waitingLabel}
 *   ⛔ {waitingLabel} (blocked on …)
 *
 *   …repeated per stakeholder group…
 */
export function formatStatusCheckMessage(data: DrawerData): string {
  const lines: string[] = [];

  // ── Header ────────────────────────────────────────────────────
  lines.push(`📋 Status check — ${data.batchCode}`);
  lines.push(`${data.dealerName} · ${data.quantity}× ${data.modelYear}`);
  if (data.closedAt && data.closureReason) {
    const tag = data.closureReason === "delivered" ? "✅ Delivered" : "🚫 Cancelled";
    lines.push(`${tag} on ${fmtDate(data.closedAt)}  ·  Promised: ${fmtDate(data.promisedDate)}`);
    if (data.closureReason === "cancelled" && data.cancellationNote) {
      lines.push(`Reason: ${data.cancellationNote}`);
    }
  } else {
    lines.push(`Promised: ${fmtDate(data.promisedDate)}  ·  ${data.statusLabel}`);
  }

  if (data.actions.length === 0) {
    lines.push("");
    lines.push("(No actions on this batch yet.)");
    return lines.join("\n") + "\n";
  }

  // ── Group actions by stakeholder tag ─────────────────────────
  const byTag = new Map<string, ActionDetail[]>();
  for (const a of data.actions) {
    const tag = a.assignedStakeholderName
      ? `@${a.assignedStakeholderName}${a.departmentName ? ` (${a.departmentName})` : ""}`
      : a.departmentName
        ? `(unassigned — ${a.departmentName})`
        : "(unassigned)";
    const arr = byTag.get(tag) ?? [];
    arr.push(a);
    byTag.set(tag, arr);
  }

  // ── Body ──────────────────────────────────────────────────────
  lines.push("");
  lines.push("Where do we stand?");

  for (const [tag, items] of byTag) {
    lines.push("");
    lines.push(tag);
    for (const a of items) {
      const icon = STATUS_ICON[a.status];
      const label = a.status === "done" ? a.doneLabel : a.waitingLabel;
      let line = `${icon} ${label}`;
      if (a.status === "done" && a.completedAt) {
        line += `  ·  ${fmtDate(a.completedAt.slice(0, 10))}`;
      } else if (a.status === "blocked" && a.blockedBy.length > 0) {
        line += `  (blocked on ${a.blockedBy.join(", ")})`;
      }
      lines.push(line);
    }
  }

  return lines.join("\n") + "\n";
}
