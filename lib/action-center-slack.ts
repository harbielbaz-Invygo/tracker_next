/**
 * Pure Slack-message formatter for the Action Center page.
 *
 * Lives in its own file (separate from `lib/action-center-data.ts`) so that
 * client components can `import { formatStatusCheckMessage }` without
 * webpack pulling `better-sqlite3` into the browser bundle. The DB
 * queries stay in action-center-data.ts; this module only takes the data.
 *
 * Types are imported as type-only references — they get erased at compile
 * time so action-center-data.ts never appears in the client runtime graph.
 */
import type { ActionDetail, DrawerData } from "./action-center-data";

// ──────────────────────────────────────────────────────────────────
// PO-level status check — the structured shape the new Slack message
// renders against. The data-layer call collects everything in this
// shape; the formatter below is a pure pretty-printer.
// ──────────────────────────────────────────────────────────────────

export interface PoModelLine {
  modelYear: string;        // "Hyundai Accent 2026"
  quantity: number;         // 20
}
export interface PoCitySlice {
  city: string;             // "Riyadh"
  totalCars: number;        // sum across modelYear lines
  models: PoModelLine[];    // sorted by name
}
export interface PoDeliveryWave {
  /** ISO yyyy-mm-dd — dealer-promised availability for this wave. */
  promisedDate: string;
  totalCars: number;
  cities: PoCitySlice[];    // sorted by city
}
export interface PoActionLine {
  /** Stakeholder + department label, e.g. "@Ahmed (Operations)" or "(unassigned — Logistics)". */
  tag: string;
  status: ActionDetail["status"];
  /** waitingLabel for non-done, doneLabel otherwise. */
  label: string;
  /** Short batch reference, e.g. "PO-0117 · 2 of 9 · Riyadh · 25×". */
  batchRef: string;
  /** completedAt or expectedDate, ISO. */
  date: string | null;
  /** parent action names this is blocked on. */
  blockedBy: string[];
}
export interface PoStatusCheckData {
  poNumber: string;
  dealerName: string;
  totalCars: number;
  totalBatchesInPo: number;
  waves: PoDeliveryWave[];   // sorted by promisedDate
  /** Single number when all batches agree; null when they differ across the PO. */
  contractLengthMonths: number | null;
  /** Min/max buy-back across batches. Null when no buy-back data anywhere. */
  buyBackRange: { min: number; max: number } | null;
  /** All pending actions across the PO's batches, grouped/sorted by stakeholder. */
  actions: PoActionLine[];
}

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

// ──────────────────────────────────────────────────────────────────
// PO-level message — the new format.
//
// Layout:
//   📦 PO-{number} — {dealer}
//   Total: {N} Cars
//
//   ━━━━━━━━━━━━━━
//   📅 Delivery Wave — {date}
//
//   🏙️ {city} — {N} Cars
//   • {modelYear} — {qty}
//   …
//
//   ━━━━━━━━━━━━━━
//   📋 Commercial Terms
//   • Contract Duration: {N} Months
//   • Buy-back Range: SAR {min} – {max}
//
//   ━━━━━━━━━━━━━━
//   📋 Actions
//   {stakeholder tag}
//   {status icon} {label}  ·  {batchRef}
//   …
//
// Each section is optional — empty waves are skipped, no commercial
// terms means the section is omitted, no actions means no Actions
// section.
// ──────────────────────────────────────────────────────────────────

const DIVIDER = "━━━━━━━━━━━━━━";

function fmtCurrency(n: number): string {
  // SAR uses thousands separator with no decimals in casual contexts.
  return Math.round(n).toLocaleString("en-US");
}

export function formatPoStatusCheckMessage(data: PoStatusCheckData): string {
  const lines: string[] = [];

  // Header.
  lines.push(`📦 ${data.poNumber} — ${data.dealerName}`);
  lines.push(`Total: ${data.totalCars} Cars`);

  // Delivery waves.
  for (const wave of data.waves) {
    lines.push("");
    lines.push(DIVIDER);
    lines.push(`📅 Delivery Wave — ${fmtDate(wave.promisedDate)}`);
    for (const slice of wave.cities) {
      lines.push("");
      lines.push(`🏙️ ${slice.city} — ${slice.totalCars} Cars`);
      for (const m of slice.models) {
        lines.push(`• ${m.modelYear} — ${m.quantity}`);
      }
    }
  }

  // Commercial Terms (only when at least one field is present).
  const hasTerms = data.contractLengthMonths != null || data.buyBackRange != null;
  if (hasTerms) {
    lines.push("");
    lines.push(DIVIDER);
    lines.push("📋 Commercial Terms");
    lines.push("");
    if (data.contractLengthMonths != null) {
      lines.push(`• Contract Duration: ${data.contractLengthMonths} Months`);
    }
    if (data.buyBackRange) {
      const { min, max } = data.buyBackRange;
      const range = min === max
        ? `SAR ${fmtCurrency(min)}`
        : `SAR ${fmtCurrency(min)} – ${fmtCurrency(max)}`;
      lines.push(`• Buy-back Range: ${range}`);
    }
  }

  // Actions.
  if (data.actions.length > 0) {
    lines.push("");
    lines.push(DIVIDER);
    lines.push("📋 Actions");
    let prevTag: string | null = null;
    for (const a of data.actions) {
      if (a.tag !== prevTag) {
        lines.push("");
        lines.push(a.tag);
        prevTag = a.tag;
      }
      const icon = STATUS_ICON[a.status];
      let line = `${icon} ${a.label}  ·  ${a.batchRef}`;
      if (a.status === "done" && a.date) {
        line += `  ·  ${fmtDate(a.date.slice(0, 10))}`;
      } else if (a.status === "blocked" && a.blockedBy.length > 0) {
        line += `  (blocked on ${a.blockedBy.join(", ")})`;
      }
      lines.push(line);
    }
  }

  return lines.join("\n") + "\n";
}
