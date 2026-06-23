/**
 * Server data layer for the "excused delay" workflow.
 *
 * When ops misses a task's planned date for a reason outside their control
 * (tech issue, dealer-side hold, …) they submit a justification against the
 * action. It sits `pending` — counting as a normal delay — until an admin
 * Accepts it in the Inbox, at which point the action's lateness is excused
 * (the metrics treat it as on-time and the UI relabels the slip as
 * "+N days · excused (<reason>)"). Rejected justifications stay delays.
 *
 * Both tables live OFF the Drizzle schema (raw SQL, tolerant of the
 * un-migrated table) — same pattern as po_redistribution_log etc. — so the
 * app never 500s before the ensure-delay-justification-tables migration is
 * run. Create them via that admin endpoint.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export type JustificationStatus = "pending" | "accepted" | "rejected";

export interface DelayReason {
  id: number;
  label: string;
  active: boolean;
  sortOrder: number;
}

export interface DelayJustification {
  id: number;
  actionId: number;
  reasonId: number | null;
  reasonText: string | null;
  /** Resolved display label: catalog label, else the free text. */
  reasonLabel: string;
  status: JustificationStatus;
  submittedBy: string | null;
  submittedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  decisionNote: string | null;
}

interface CatalogRow { id: number; label: string; active: number; sort_order: number }
interface JustRow {
  id: number; action_id: number; reason_id: number | null; reason_text: string | null;
  status: string; submitted_by: string | null; submitted_at: string | null;
  reviewed_by: string | null; reviewed_at: string | null; decision_note: string | null;
}

// ── Reason catalog ────────────────────────────────────────────────

export async function listReasonCatalog(includeInactive = false): Promise<DelayReason[]> {
  try {
    const rows = await db.all<CatalogRow>(sql`
      SELECT id, label, active, sort_order FROM delay_reason_catalog
      ORDER BY sort_order ASC, id ASC
    `);
    return rows
      .filter((r) => includeInactive || r.active === 1)
      .map((r) => ({ id: r.id, label: r.label, active: r.active === 1, sortOrder: r.sort_order }));
  } catch {
    return [];
  }
}

export async function createReason(label: string): Promise<number | null> {
  const clean = label.trim();
  if (!clean) return null;
  try {
    const [{ n }] = await db.all<{ n: number }>(sql`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM delay_reason_catalog`);
    await db.run(sql`INSERT INTO delay_reason_catalog (label, active, sort_order) VALUES (${clean}, 1, ${n})`);
    const [{ id }] = await db.all<{ id: number }>(sql`SELECT last_insert_rowid() AS id`);
    return id;
  } catch {
    return null;
  }
}

export async function setReasonActive(id: number, active: boolean): Promise<void> {
  try {
    await db.run(sql`UPDATE delay_reason_catalog SET active = ${active ? 1 : 0} WHERE id = ${id}`);
  } catch { /* table absent */ }
}

// ── Justifications ────────────────────────────────────────────────

function mapJust(r: JustRow, labelById: Map<number, string>): DelayJustification {
  const reasonLabel = r.reason_id != null
    ? (labelById.get(r.reason_id) ?? r.reason_text ?? "—")
    : (r.reason_text ?? "—");
  return {
    id: r.id,
    actionId: r.action_id,
    reasonId: r.reason_id,
    reasonText: r.reason_text,
    reasonLabel,
    status: (r.status as JustificationStatus) ?? "pending",
    submittedBy: r.submitted_by,
    submittedAt: r.submitted_at,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    decisionNote: r.decision_note,
  };
}

async function labelMap(): Promise<Map<number, string>> {
  const cat = await listReasonCatalog(true);
  return new Map(cat.map((c) => [c.id, c.label]));
}

/**
 * Submit (or replace) a delay justification for an action. If a `pending`
 * row already exists for the action it's updated in place (one open
 * submission per action); otherwise a new pending row is inserted. Returns
 * the row id, or null on failure / missing input.
 */
export async function submitJustification(args: {
  actionId: number;
  reasonId: number | null;
  reasonText: string | null;
  submittedBy: string | null;
}): Promise<number | null> {
  const reasonText = args.reasonText?.trim() || null;
  const reasonId = args.reasonId && Number.isInteger(args.reasonId) ? args.reasonId : null;
  if (reasonId == null && !reasonText) return null; // need at least one
  try {
    const existing = await db.all<{ id: number }>(sql`
      SELECT id FROM action_delay_justifications
      WHERE action_id = ${args.actionId} AND status = 'pending'
      ORDER BY id DESC LIMIT 1
    `);
    if (existing.length > 0) {
      await db.run(sql`
        UPDATE action_delay_justifications
        SET reason_id = ${reasonId}, reason_text = ${reasonText},
            submitted_by = ${args.submittedBy}, submitted_at = CURRENT_TIMESTAMP
        WHERE id = ${existing[0].id}
      `);
      return existing[0].id;
    }
    await db.run(sql`
      INSERT INTO action_delay_justifications (action_id, reason_id, reason_text, status, submitted_by)
      VALUES (${args.actionId}, ${reasonId}, ${reasonText}, 'pending', ${args.submittedBy})
    `);
    const [{ id }] = await db.all<{ id: number }>(sql`SELECT last_insert_rowid() AS id`);
    return id;
  } catch {
    return null;
  }
}

/** Accept or reject a justification. Returns false if the row is missing. */
export async function reviewJustification(args: {
  id: number;
  decision: "accepted" | "rejected";
  note: string | null;
  reviewedBy: string | null;
}): Promise<boolean> {
  try {
    const rows = await db.all<{ id: number }>(sql`SELECT id FROM action_delay_justifications WHERE id = ${args.id}`);
    if (rows.length === 0) return false;
    await db.run(sql`
      UPDATE action_delay_justifications
      SET status = ${args.decision}, decision_note = ${args.note?.trim() || null},
          reviewed_by = ${args.reviewedBy}, reviewed_at = CURRENT_TIMESTAMP
      WHERE id = ${args.id}
    `);
    return true;
  } catch {
    return false;
  }
}

/** Latest justification per action, keyed by actionId (for UI badges). */
export async function getJustificationsByAction(actionIds?: number[]): Promise<Map<number, DelayJustification>> {
  try {
    const rows = await db.all<JustRow>(sql`
      SELECT id, action_id, reason_id, reason_text, status,
             submitted_by, submitted_at, reviewed_by, reviewed_at, decision_note
      FROM action_delay_justifications
      ORDER BY id ASC
    `);
    const labels = await labelMap();
    const wanted = actionIds ? new Set(actionIds) : null;
    const out = new Map<number, DelayJustification>();
    for (const r of rows) {
      if (wanted && !wanted.has(r.action_id)) continue;
      out.set(r.action_id, mapJust(r, labels)); // ORDER BY id ASC → last wins = latest
    }
    return out;
  } catch {
    return new Map();
  }
}

/** Set of actionIds whose lateness is excused (an accepted justification). */
export async function getExcusedActionIds(): Promise<Set<number>> {
  try {
    const rows = await db.all<{ action_id: number }>(sql`
      SELECT DISTINCT action_id FROM action_delay_justifications WHERE status = 'accepted'
    `);
    return new Set(rows.map((r) => r.action_id));
  } catch {
    return new Set();
  }
}

/** Flat list of justifications, optionally filtered by status (for the Inbox). */
export async function listJustifications(status?: JustificationStatus): Promise<DelayJustification[]> {
  try {
    const rows = status
      ? await db.all<JustRow>(sql`
          SELECT id, action_id, reason_id, reason_text, status,
                 submitted_by, submitted_at, reviewed_by, reviewed_at, decision_note
          FROM action_delay_justifications WHERE status = ${status} ORDER BY id DESC`)
      : await db.all<JustRow>(sql`
          SELECT id, action_id, reason_id, reason_text, status,
                 submitted_by, submitted_at, reviewed_by, reviewed_at, decision_note
          FROM action_delay_justifications ORDER BY id DESC`);
    const labels = await labelMap();
    return rows.map((r) => mapJust(r, labels));
  } catch {
    return [];
  }
}
