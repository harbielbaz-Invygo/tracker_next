import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** `cn(...)` — combine class names cleanly. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ──────────────────────────────────────────────────────────────────
// Batch code
// ──────────────────────────────────────────────────────────────────
//
// Format:
//   PO-{number}-{Dealer}-{n}of{total}-{City}-{qty}-{Carname}
//
// Example:
//   PO-0114-Capital-2of3-Jeddah-5-Accent
//
// Rules:
//   - PO number is normalised to start with "PO-".
//   - Dealer / City use the first whitespace-separated word, stripped of
//     non-alphanumeric characters. Hyphens inside a word ("Al-Riyadh")
//     are preserved as joined letters ("AlRiyadh").
//   - Carname strips the brand (the first word) and slugs the rest, so
//     "Hyundai Accent" → "Accent", "Toyota Land Cruiser" → "LandCruiser",
//     "BMW X5" → "X5". Single-word inputs are kept as-is.
//   - Splits inside one PO submission are numbered 1of{total}…{total}of{total}.
//   - URL-safe: only A-Z, a-z, 0-9, and `-`.
// ──────────────────────────────────────────────────────────────────

export interface BatchCodeArgs {
  /** PO number from the PDF or a synthetic prefix; "PO-" is added if missing. */
  poNumber: string;
  /** Full dealer name (e.g. "Capital Auto Group"). First word becomes the slug. */
  dealerName: string;
  /** 1-based index within this submission. */
  splitN: number;
  /** Total batches that will be created in this submission. */
  splitTotal: number;
  /** City for this batch's split. First word becomes the slug. */
  city: string;
  /** Model string from the PDF (e.g. "Hyundai Accent"). First word becomes the slug. */
  model: string;
  /** Quantity for this split. */
  qty: number;
}

export function makeBatchCode(args: BatchCodeArgs): string {
  return [
    normalizePoNumber(args.poNumber),
    firstWordSlug(args.dealerName),
    `${args.splitN}of${args.splitTotal}`,
    firstWordSlug(args.city),
    String(args.qty),
    carNameSlug(args.model),
  ].join("-");
}

/**
 * Ensure a "PO-…" prefix. Accepts:
 *   "PO-0114"  → "PO-0114"
 *   "0114"     → "PO-0114"
 *   "S001"     → "PO-S001"
 *   "po-0114"  → "PO-0114"
 *   ""         → "PO-UNKNOWN"
 */
function normalizePoNumber(s: string | null | undefined): string {
  const cleaned = (s ?? "").trim().replace(/[^A-Za-z0-9-]/g, "");
  if (!cleaned) return "PO-UNKNOWN";
  if (/^PO-/i.test(cleaned)) return "PO-" + cleaned.replace(/^PO-/i, "");
  return `PO-${cleaned}`;
}

/**
 * Take the first whitespace-separated token, strip non-alphanumeric,
 * preserve casing. Returns "X" if input is empty.
 *
 * Examples:
 *   "Capital Auto Group" → "Capital"
 *   "Al-Riyadh Motors"   → "AlRiyadh"   (hyphen removed within the word)
 *   "Hyundai Accent"     → "Hyundai"
 *   "BMW X5"             → "BMW"
 */
function firstWordSlug(s: string | null | undefined): string {
  if (!s) return "X";
  const firstToken = s.trim().split(/\s+/)[0] ?? "";
  const cleaned = firstToken.replace(/[^A-Za-z0-9]/g, "");
  return cleaned || "X";
}

/**
 * Slug for the *car name* — the model, not the brand. Drops the first
 * whitespace-separated token (assumed to be the brand) and joins the
 * rest into one alphanumeric token. Single-word input is returned as-is
 * so a bare "Accent" still works. Returns "X" if the input is empty.
 *
 * Examples:
 *   "Hyundai Accent"      → "Accent"
 *   "Hyundai Sonata"      → "Sonata"
 *   "Toyota Land Cruiser" → "LandCruiser"
 *   "BMW X5"              → "X5"
 *   "Accent"              → "Accent"     (no brand prefix)
 */
function carNameSlug(s: string | null | undefined): string {
  if (!s) return "X";
  const tokens = s.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "X";
  // Single-word input: no brand to strip, keep as-is.
  if (tokens.length === 1) {
    return tokens[0].replace(/[^A-Za-z0-9]/g, "") || "X";
  }
  // Multi-word: drop the brand (first token), slug the rest.
  const cleaned = tokens.slice(1)
    .map((t) => t.replace(/[^A-Za-z0-9]/g, ""))
    .join("");
  return cleaned || "X";
}

// ──────────────────────────────────────────────────────────────────
// Misc
// ──────────────────────────────────────────────────────────────────

/** ISO date helper. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
