/**
 * PO PDF parser — pure types, regex extraction, and Slack formatter.
 *
 * No `pdf-parse` (and therefore no `fs`) imports here — that lives in
 * `lib/po-parser-server.ts` so this file is safe to import from client
 * components for the types and the formatter.
 *
 * TypeScript port of `tracker_v1/po_parser.py`. Same regex patterns,
 * same multi-item logic, same Slack formatter. Verified against PO-0109
 * (multi-item) and PO-0114 (single-item with discount col).
 */

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────
export type DeliverySplit = {
  quantity: number;
  city: string;
  date: string; // ISO yyyy-mm-dd
};

export type ParsedItem = {
  model: string | null;
  year: number | null;
  quantity: number | null;
  buyBackRate: number | null;
  contractLength: string | null;
  contractLengthMonths: number | null;
  colorsRaw: string | null;
  colors: { qty: number; color: string }[];
  unitPriceSar: number | null;
  taxPct: number | null;
  lineAmountSar: number | null;
  discountPct: number | null;
  deliverySplits: DeliverySplit[];
};

export type ParsedPO = {
  poNumber: string | null;
  poDate: string | null;        // ISO
  deliveryDate: string | null;  // ISO
  dealerName: string | null;
  reference: string | null;
  invygoRegistration: string | null;
  subtotalSar: number | null;
  taxTotalSar: number | null;
  totalSar: number | null;
  notesText: string | null;
  earlyTerminationFees: string | null;
  deliveryAddress: string | null;
  deliveryPhone: string | null;
  deliveryAttention: string | null;
  deliveryInstructions: string | null;
  items: ParsedItem[];
};

// ─────────────────────────────────────────────────────────
// Top-level extraction (exported for the server-only PDF wrapper)
// ─────────────────────────────────────────────────────────
export function extract(text: string): ParsedPO {
  return {
    poNumber:           reValue(text, /Purchase Order Number\s*\n\s*([A-Z0-9-]+)/i),
    poDate:             maybeDate(reValue(text, /Purchase Order Date\s*\n\s*(\d+\s+\w+\s+\d{4})/i)),
    deliveryDate:       maybeDate(reValue(text, /Delivery Date\s*\n\s*(\d+\s+\w+\s+\d{4})/i)),
    dealerName:         extractDealerName(text),
    reference:          reValue(text, /Reference\s*\n\s*([^\n]+)/i),
    invygoRegistration: reValue(text, /invygo saudi\s*\n\s*(\d+)/i),

    subtotalSar:  money(lastNumberOnLine(text, /Subtotal\b/i)),
    taxTotalSar:  money(lastNumberOnLine(text, /TOTAL\s+PURCHASES\s+TAX/i)),
    totalSar:     money(lastNumberOnLine(text, /TOTAL\s+SAR/i)),

    notesText:           extractNotes(text),
    earlyTerminationFees: extractEarlyTermination(text),
    deliveryAddress:     extractDeliveryAddress(text),
    deliveryPhone:       reValue(text, /Telephone\s*\n\s*([0-9 +\-]+)/),
    deliveryAttention:   extractAttention(text),
    deliveryInstructions: extractDeliveryInstructions(text),

    items: extractItems(text),
  };
}

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────
function reValue(text: string, re: RegExp): string | null {
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

function lastNumberOnLine(text: string, anchor: RegExp): string | null {
  // Match the line containing `anchor`, take the LAST decimal number on it.
  const lineRe = new RegExp(anchor.source + "[^\\n]*", anchor.flags);
  const m = text.match(lineRe);
  if (!m) return null;
  const nums = m[0].match(/[0-9,]+\.[0-9]+/g);
  return nums ? nums[nums.length - 1] : null;
}

function money(s: string | null): number | null {
  if (!s) return null;
  const n = parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function maybeDate(s: string | null): string | null {
  if (!s) return null;
  // Accept "4 May 2026" or "4 May 2026" → ISO
  const months: Record<string, number> = {
    jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
    january:1,february:2,march:3,april:4,june:6,july:7,august:8,
    september:9,october:10,november:11,december:12,
  };
  const m = s.trim().match(/^(\d+)\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = months[m[2].toLowerCase()];
  const year = parseInt(m[3], 10);
  if (!month) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function extractDealerName(text: string): string | null {
  const m = text.match(/PURCHASE ORDER\s*\n\s*([A-Za-z][A-Za-z0-9 &'\-]{2,60})\s*\n/);
  if (!m) return null;
  const c = m[1].trim();
  if (/^purchase order|^company registration/i.test(c)) return null;
  return c;
}

function extractNotes(text: string): string | null {
  const m = text.match(/Notes:\s*\n([\s\S]+?)(?=\n\s*Early Termination|\n\s*Subtotal|\n\s*Total)/);
  return m ? m[1].trim() : null;
}

function extractEarlyTermination(text: string): string | null {
  const m = text.match(/Early Termination Fees:\s*\n([\s\S]+?)(?=\n\s*Subtotal|\n\s*\n\s*[A-Z])/);
  return m ? m[1].trim() : null;
}

function extractDeliveryAddress(text: string): string | null {
  const m = text.match(/Delivery Address\s*\n([\s\S]+?)(?=\n\s*Attention|\n\s*Telephone|\n\s*Delivery Instructions)/);
  return m ? m[1].trim() : null;
}

function extractAttention(text: string): string | null {
  const m = text.match(/Attention\s*\n\s*([^\n]*)\n/);
  if (!m) return null;
  const v = m[1].trim();
  return v && !/^telephone/i.test(v) ? v : null;
}

function extractDeliveryInstructions(text: string): string | null {
  const m = text.match(/Delivery Instructions\s*\n([\s\S]+?)(?=Company Registration|$)/);
  return m ? m[1].trim() : null;
}

// ─── Items ───────────────────────────────────────────────
// The item heading is "<Make> <Model …> <Year>". Most POs put pricing
// (qty, unit price, tax %, line amount) on the line BELOW the heading,
// but some templates put it INLINE on the same line — and pdf-parse
// frequently strips the spaces between the right-aligned pricing
// columns, yielding e.g. "Hyundai Sonata Smart 202630.002,956.5217...".
// We deliberately do NOT constrain what follows the year (no `\b`, no
// `\s*$`): year alone is a strong enough discriminator within the
// items section, and any trailing pricing digits are peeled off later
// by parseItemChunk's pricing regex.
//
// The first token must START with a letter so a year-like 4-digit number
// in the description ("2030 Special edition") can't be confused for the
// model. Tokens MAY contain digits after the first letter so model codes
// like GS3 / Q5 / X3 / E300 / C-HR / GT-R parse cleanly. A later token may
// ALSO be a standalone 1–3 digit number so split-word models like "MG 5"
// or "BMW 320" parse — 1–3 digits can never be a 4-digit year, so the
// year-discrimination still holds.
const ITEM_HEAD_RE = /^([A-Z][A-Za-z0-9\-]*(?:\s+(?:[A-Za-z][A-Za-z0-9\-]*|\d{1,3})){1,4})\s+(20[2-3][0-9])/gm;

/**
 * Drop table-header garbage that some PDFs concatenate into a row, e.g.
 * "ItemDescriptionQuantityUnit PriceDiscountTaxAmount SAR Hyundai Accent".
 * Keeps proper-noun words (Toyota, Hyundai, Accent) and short all-caps
 * brands (BMW, MG, GMC). Drops camelCase glob words (multi-uppercase
 * mid-word) and bare currency / table-header tokens.
 */
const MODEL_STOP_WORDS = /^(Item|Description|Quantity|Unit|Price|Discount|Tax|Amount|SAR|USD|AED|EUR|Total|Subtotal|Notes)$/i;
function cleanModelName(raw: string): string {
  return raw
    .split(/\s+/)
    .filter((w) => {
      if (!w || MODEL_STOP_WORDS.test(w)) return false;
      // CamelCase concat like "ItemDescriptionQuantity" or "PriceDiscountTaxAmount"
      // — has multiple capitals after the first character.
      if (/^[A-Z][a-z]+[A-Z]/.test(w)) return false;
      // Proper noun (Toyota, Hyundai, Accent)
      if (/^[A-Z][a-z]+$/.test(w)) return true;
      // Short all-caps brand (BMW, MG, GMC, KIA, GAC)
      if (/^[A-Z]{2,4}$/.test(w)) return true;
      // Hyphenated proper noun (e.g. "Land-Cruiser")
      if (/^[A-Z][a-z]+(?:-[A-Z]?[a-z]+)+$/.test(w)) return true;
      // Alphanumeric model code (GS3, Q5, X3, A4, E300, RX450h). Must
      // start with a letter and contain at least one digit so we don't
      // mistake plain proper nouns or stop-word concats for codes.
      if (/^[A-Z][A-Za-z0-9]*\d[A-Za-z0-9]*$/.test(w)) return true;
      // Hyphenated alphanumeric model code (C-HR, GT-R, X-Trail, GS-3).
      if (/^[A-Z][A-Za-z0-9]*(?:-[A-Z0-9][A-Za-z0-9]*)+$/.test(w)) return true;
      // Standalone short number that's part of a split-word model
      // ("MG 5" → MG + 5, "BMW 320" → BMW + 320). 1–3 digits so a 4-digit
      // year can never be mistaken for a model token.
      if (/^\d{1,3}$/.test(w)) return true;
      return false;
    })
    .join(" ");
}

function extractItems(text: string): ParsedItem[] {
  // Slice out the items section. Tolerate variants where PDF rendering
  // concatenates the table header ("ItemDescription", "Item Description").
  const sectionMatch = text.match(/Item\s*Description[^\n]*\n?([\s\S]*?)(?=\nNotes:|\nSubtotal|\nDELIVERY DETAILS|$)/i);
  const section = sectionMatch ? sectionMatch[1] : text;

  const headers: { idx: number; model: string; year: number }[] = [];
  let m: RegExpExecArray | null;
  ITEM_HEAD_RE.lastIndex = 0;
  while ((m = ITEM_HEAD_RE.exec(section)) !== null) {
    const cleaned = cleanModelName(m[1]);
    if (!cleaned) continue; // header-only line, skip
    headers.push({ idx: m.index, model: cleaned, year: parseInt(m[2], 10) });
  }
  if (headers.length === 0) return [];

  const items: ParsedItem[] = [];
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].idx;
    const end = i + 1 < headers.length ? headers[i + 1].idx : section.length;
    const chunk = section.slice(start, end);
    items.push(parseItemChunk(chunk, headers[i].model, headers[i].year));
  }
  return items;
}

function parseItemChunk(chunk: string, model: string, year: number): ParsedItem {
  const out: ParsedItem = {
    model, year,
    quantity: null,
    buyBackRate: null, contractLength: null, contractLengthMonths: null,
    colorsRaw: null, colors: [],
    unitPriceSar: null, taxPct: null, lineAmountSar: null, discountPct: null,
    deliverySplits: [],
  };

  const buyBack = chunk.match(/Buy\s*Back\s*Option\s*Rate:\s*SAR\s*([\d,]+)/i);
  if (buyBack) out.buyBackRate = parseInt(buyBack[1].replace(/,/g, ""), 10);

  const contract = chunk.match(/Contract Length:\s*([^\n]+)/i);
  if (contract) {
    out.contractLength = contract[1].trim();
    const cm = contract[1].match(/(\d+)/);
    if (cm) out.contractLengthMonths = parseInt(cm[1], 10);
  }

  // Colors often wrap across multiple lines in the PDF render, e.g.
  //   "Car Colors: 40 Titan Gray.  30\nAmazon Gray. 10 Atlas White."
  // Capture every subsequent line until we hit the pricing line, which
  // ALWAYS contains a `%` (tax + discount columns). Colors never do.
  // The earlier "digits + space + digits" anchor failed because
  // pdf-parse can strip spaces between pricing columns, yielding e.g.
  // "80.001,782.60870.00%15%142,608.70" with no whitespace between
  // qty and unit price. Anchoring on `%` is format-independent.
  // Whitespace within the capture gets collapsed to single spaces so
  // the resulting colorsRaw reads naturally on a single line.
  const colors = chunk.match(/Car Colors?:\s*([\s\S]+?)(?=\n[^\n]*%|$)/i);
  if (colors) {
    out.colorsRaw = colors[1]
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\.$/, "");
    out.colors = parseColors(out.colorsRaw);
  }

  out.deliverySplits = extractDeliverySplits(chunk);

  const pricing = extractPricing(chunk);
  Object.assign(out, pricing);
  if (out.quantity == null && out.deliverySplits.length > 0) {
    out.quantity = out.deliverySplits.reduce((a, s) => a + s.quantity, 0);
  }
  return out;
}

function parseColors(s: string): { qty: number; color: string }[] {
  return s.split(/\s*[,;]\s*/).flatMap((part) => {
    const m = part.trim().match(/(\d+)\s+([A-Za-z][A-Za-z\- ]*)/);
    if (!m) return [];
    return [{
      qty: parseInt(m[1], 10),
      color: m[2].trim().replace(/\.$/, "")
        .replace(/\b\w/g, c => c.toUpperCase()),
    }];
  });
}

function extractPricing(chunk: string): Partial<ParsedItem> {
  // The pricing column appears in two flavours from pdf-parse:
  //   spaces preserved: "30.00 2,956.5217 0.00% 15%   88,695.65"
  //   spaces stripped:  "30.002,956.52170.00%15%88,695.65"
  // (right-aligned table cells get glued together when pdf-parse loses
  // the inter-column whitespace.) `\s*` between fields handles both.
  //
  // Qty is constrained two ways:
  //   1) 1-5 digits followed by EXACTLY ".00" — qty always renders as
  //      `<int>.00` in the PO templates we've seen.
  //   2) Positive lookbehind: qty MUST be preceded by whitespace OR by
  //      a 4-digit year. The lookbehind matters when the heading itself
  //      is inline ("Hyundai Sonata Smart 202630.00…"): without it the
  //      engine would otherwise pick a fake qty like "02630" or "2630"
  //      out of the year digits. With the lookbehind, the first valid
  //      position is right after the year, where the real qty lives.
  // With discount column: "25.00 1,782.6087 0.00% 15% 44,565.22"
  let m = chunk.match(/(?<=\s|20[2-3][0-9])(\d{1,5}\.\d{2})\s*([\d,]+\.\d+)\s*([\d.]+)%\s*(\d+)%\s*([\d,.]+)/);
  if (m) {
    return {
      quantity:        Math.trunc(parseFloat(m[1])),
      unitPriceSar:    parseFloat(m[2].replace(/,/g, "")),
      discountPct:     parseFloat(m[3]),
      taxPct:          parseInt(m[4], 10),
      lineAmountSar:   parseFloat(m[5].replace(/,/g, "")),
    };
  }
  // Without discount: "10.00 2,304.3478 15% 23,043.48"
  m = chunk.match(/(?<=\s|20[2-3][0-9])(\d{1,5}\.\d{2})\s*([\d,]+\.\d+)\s*(\d+)%\s*([\d,.]+)/);
  if (m) {
    return {
      quantity:        Math.trunc(parseFloat(m[1])),
      unitPriceSar:    parseFloat(m[2].replace(/,/g, "")),
      taxPct:          parseInt(m[3], 10),
      lineAmountSar:   parseFloat(m[4].replace(/,/g, "")),
    };
  }
  return {};
}

function extractDeliverySplits(text: string): DeliverySplit[] {
  const yearMatch = text.match(/\b(20[2-3][0-9])\b/);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();

  // Two-step parse, matching the two PO formats we see in the wild:
  //
  //   A) "20 cars in Riyadh on May 5th."          (city + date inline per item)
  //   B) "20 in Riyadh, 20 in Jeddah, 10 in       (cities grouped, single date)
  //       Dammam on May 20th. 20 in Riyadh,
  //       20 in Jeddah, 10 in Dammam on June 25th."
  //
  // Strategy: walk every "<prefix> on <Month> <day>" group (non-greedy
  // so we stop at the next 'on Month day' anchor or the next sentence
  // boundary). Within each prefix, extract every "<qty> [cars?] in
  // <City>" pair and assign the group's date to each.
  //
  // The `cars?` token is optional — format B drops it. The prefix is
  // upper-bounded by a period or a previous date anchor to keep one
  // wave's cities from leaking into the next.
  const groupRe = /([^.]+?)\s+on\s+([A-Z][a-z]+)\s+(\d+)(?:st|nd|rd|th)?/g;
  const itemRe  = /(\d+)\s+(?:cars?\s+)?in\s+([A-Z][A-Za-z]+)/g;

  const seen = new Set<string>();
  const out: DeliverySplit[] = [];

  let g: RegExpExecArray | null;
  while ((g = groupRe.exec(text)) !== null) {
    const dateIso = maybeDate(`${g[3]} ${g[2]} ${year}`);
    if (!dateIso) continue;
    // Trim prefix to the *current* wave only: chop off anything up
    // to the previous date anchor inside the prefix (handles the
    // case where format A appears alongside format B and the
    // non-greedy regex still ate too much).
    const prefix = g[1].split(/\bon\s+[A-Z][a-z]+\s+\d+(?:st|nd|rd|th)?/).pop() ?? g[1];

    itemRe.lastIndex = 0;
    let im: RegExpExecArray | null;
    let cityFound = false;
    while ((im = itemRe.exec(prefix)) !== null) {
      const qty = parseInt(im[1], 10);
      const cityRaw = im[2];
      const city = cityRaw.charAt(0).toUpperCase() + cityRaw.slice(1).toLowerCase();
      const key = `${qty}|${city}|${dateIso}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ quantity: qty, city, date: dateIso });
      cityFound = true;
    }
    // Cityless format — "<qty> cars on <Date>" with no "in <City>"
    // (single-destination POs). Take the last "<qty> cars/units" in the
    // prefix and emit a split with an empty city for ops to fill.
    if (!cityFound) {
      const carMatches = [...prefix.matchAll(/(\d+)\s*(?:cars?|units?|vehicles?)\b/gi)];
      const last = carMatches.at(-1);
      const qty = last ? parseInt(last[1], 10) : NaN;
      if (Number.isFinite(qty) && qty > 0) {
        const key = `${qty}||${dateIso}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ quantity: qty, city: "", date: dateIso });
        }
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────
// Slack-ready announcement
// ─────────────────────────────────────────────────────────

/**
 * One action item in the Slack output. Built by the Intake form from
 * the user's selections + Settings-configured stakeholders.
 */
export interface SlackAction {
  /** Human-readable action text (typically the action_type's `waitingLabel`). */
  actionLabel: string;
  /** Department that owns the action. Null if the action type has no default dept. */
  departmentName: string | null;
  /** Stakeholder picked for the department's actions. Null when none picked yet. */
  stakeholderName: string | null;
}

function ordinal(n: number): string {
  const suffix = (n % 100 >= 10 && n % 100 <= 20) ? "th"
    : (["st","nd","rd"][((n - 1) % 10)] ?? "th");
  return `${n}${suffix}`;
}

function dealerShort(name: string | null | undefined): string {
  if (!name) return "—";
  return name.trim().split(/\s+/)[0] || "—";
}

function fmtMonthDay(iso: string): string {
  const parts = iso.split("-").map((x) => parseInt(x, 10));
  const m = parts[1];
  const d = parts[2];
  if (!Number.isFinite(m) || !Number.isFinite(d)) return iso;
  const monthName = ["January","February","March","April","May","June",
                     "July","August","September","October","November","December"][m - 1];
  return `${monthName} ${ordinal(d)}`;
}

/** Optional risk callout prepended to the Slack message at Intake. */
export interface SlackRisk {
  /** "block" = override accepted (HIGH RISK). "caution" = tight window. */
  level: "block" | "caution";
  /** Human-readable reason — e.g. "Only 17d to availability vs 21d Pre PO Lead Time". */
  reason: string;
}

/**
 * Form-state snapshot used to override `p.items` in the Slack output.
 * Lets the Intake form pass its edited items (with the new
 * `opsExpectedDate` per split) so the announcement reflects what Ops
 * actually entered, not the raw parser output.
 *
 * When provided, the items section + total qty render from these
 * snapshots instead of `p.items`. Each split's `opsExpectedDate`
 * triggers an extra "Ops ETA" line when it diverges from the
 * dealer-promised date.
 */
export interface SlackItemSnapshot {
  model: string;
  year: number | null;
  quantity: number;
  contractLength: string | null;
  buyBackRate: number | null;
  colorsRaw: string | null;
  deliverySplits: {
    quantity: number;
    city: string;
    /** Dealer-promised availability date. */
    date: string;
    /** Ops-committed delivery date. Empty/null = no Ops override. */
    opsExpectedDate?: string | null;
  }[];
}

/**
 * Build a Slack-ready announcement from the parsed PO + the picked actions.
 *
 * Layout:
 *   ⚠️ HIGH RISK — {reason}            ← only when risk.level=block
 *   ⚠️ TIGHT WINDOW — {reason}         ← only when risk.level=caution
 *
 *   📦 PO-NNNN — Dealer  ·  N Cars
 *
 *   Items: …
 *   ═══════════════════
 *   Actions: …
 *
 * Stakeholder grouping order matches the order actions appear in the
 * input array, so the operator can influence it via column order.
 *
 * `items`, when provided, replaces `p.items` for the items section and
 * the total-qty header. The Intake form passes its current form state so
 * the announcement reflects user edits — including the per-split
 * `opsExpectedDate` (rendered as an "Ops ETA" line when it differs from
 * the dealer-promised date).
 */
export function formatSlackMessage(
  p: ParsedPO,
  actions: SlackAction[] = [],
  risk?: SlackRisk,
  items?: SlackItemSnapshot[],
): string {
  const lines: string[] = [];

  // ── Risk header (always first if present) ─────────────────────
  // After the form rework that locks PO Availability and auto-floors
  // Ops Expected, "block" is no longer emitted by the form. We keep it
  // here for backward compat (older clients / direct-Slack-format calls)
  // and treat "caution" as the "Ops behind dealer promise" callout.
  if (risk) {
    if (risk.level === "block") {
      lines.push(`⚠️ *HIGH RISK* — ${risk.reason}`);
      lines.push("Pre PO Ops Lead Time was overridden at Intake. Track every action carefully.");
      lines.push("");
    } else {
      lines.push(`⚠️ *OPS BEHIND PROMISE* — ${risk.reason}`);
      lines.push("Dealer-promised availability sits inside the Pre PO Ops Lead Time; Ops cannot match it.");
      lines.push("");
    }
  }

  // ── Header ────────────────────────────────────────────────────
  // When the form passes its own `items`, source totals + the items
  // section from there. Falls back to the parser snapshot otherwise.
  const itemsForSlack: SlackItemSnapshot[] = items ?? p.items.map((it) => ({
    model: it.model ?? "—",
    year: it.year,
    quantity: it.quantity ?? 0,
    contractLength: it.contractLength,
    buyBackRate: it.buyBackRate,
    colorsRaw: it.colorsRaw,
    deliverySplits: it.deliverySplits.map((s) => ({
      quantity: s.quantity,
      city: s.city,
      date: s.date,
    })),
  }));

  const totalQty = itemsForSlack.reduce((sum, it) => sum + (it.quantity ?? 0), 0);
  const dealer = dealerShort(p.dealerName);
  lines.push(
    `📦 ${p.poNumber ?? "—"} — ${dealer}  ·  ${totalQty} ${totalQty === 1 ? "Car" : "Cars"}`,
  );

  // ── Items + delivery splits ───────────────────────────────────
  if (itemsForSlack.length > 0) {
    lines.push("");
    lines.push("Items:");
    for (const it of itemsForSlack) {
      const modelYear = [it.model, it.year].filter(Boolean).join(" ") || "—";
      const qty = it.quantity ?? 0;
      lines.push(`• ${modelYear} · ${qty} ${qty === 1 ? "car" : "cars"}`);

      const meta: string[] = [];
      if (it.contractLength) meta.push(`Contract: ${it.contractLength}`);
      if (it.buyBackRate)    meta.push(`Buy-back: SAR ${it.buyBackRate.toLocaleString()}`);
      if (meta.length > 0)   lines.push(`   ${meta.join("  ·  ")}`);

      if (it.colorsRaw)      lines.push(`   Colors: ${it.colorsRaw}`);

      if (it.deliverySplits.length > 0) {
        const splits = it.deliverySplits
          .map((s) => `${s.quantity} in ${s.city} on ${fmtMonthDay(s.date)}`)
          .join(", ");
        lines.push(`   Delivery: ${splits}`);

        // Show "Ops ETA" line only when at least one split has an Ops
        // commitment that differs from the dealer-promised date. Splits
        // with no override fall back to the dealer date, so the parallel
        // structure stays readable.
        const hasOpsOverride = it.deliverySplits.some(
          (s) => s.opsExpectedDate && s.opsExpectedDate !== s.date,
        );
        if (hasOpsOverride) {
          const opsLine = it.deliverySplits
            .map((s) => {
              const eta = s.opsExpectedDate || s.date;
              return `${s.quantity} in ${s.city} on ${fmtMonthDay(eta)}`;
            })
            .join(", ");
          lines.push(`   Ops ETA:  ${opsLine}`);
        }
      } else if (p.deliveryDate && qty > 0) {
        lines.push(`   Delivery: ${qty} on ${fmtMonthDay(p.deliveryDate)}`);
      }
    }
  }

  // ── Actions, grouped by stakeholder ───────────────────────────
  if (actions.length > 0) {
    lines.push("");
    lines.push("═══════════════════");
    lines.push("Actions:");

    // Group by stakeholder tag. Map preserves insertion order, so the
    // grouping mirrors the order actions arrive (which we control by
    // iterating columns left-to-right in the form).
    const byTag = new Map<string, string[]>();
    for (const a of actions) {
      const tag = a.stakeholderName
        ? `@${a.stakeholderName}${a.departmentName ? ` (${a.departmentName})` : ""}`
        : a.departmentName
          ? `(unassigned — ${a.departmentName})`
          : "(unassigned)";
      const arr = byTag.get(tag) ?? [];
      arr.push(a.actionLabel);
      byTag.set(tag, arr);
    }

    for (const [tag, items] of byTag) {
      lines.push("");
      lines.push(tag);
      for (const item of items) lines.push(`• ${item}`);
    }
  }

  return lines.join("\n") + "\n";
}
