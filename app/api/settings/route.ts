/**
 * POST /api/settings — consolidated mutation endpoint for the Settings page.
 *
 * Discriminated union body:
 *   { resource: "department",  op: "create" | "update" | "delete", … }
 *   { resource: "action-type", op: "create" | "update" | "delete", … }
 *   { resource: "dependency",  op: "add" | "remove",                … }
 *   { resource: "rule",        op: "set",                            … }
 *
 * Returns the affected row(s) or { ok: true } for deletes.
 *
 * The Settings page itself is admin-gated by middleware. This endpoint
 * relies on that gate. (Phase: re-check role here once role propagates
 * to the request handler context.)
 */
import { and, eq, ne } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import {
  departments, stakeholders, actionTypes, actionDependencies, batchActions, batches, users, alertRules, alerts,
  vinChaseStages, batchVinStages,
} from "@/lib/db/schema";
import { setRuleNumber, RULE_KEYS, getLeadTimeDays } from "@/lib/rules";
import { requireAuth } from "@/lib/api-auth";

const MIN_PASSWORD_LENGTH = 8;

export const runtime = "nodejs";

type Body =
  | { resource: "department"; op: "create"; name: string; sortOrder?: number }
  | { resource: "department"; op: "update"; id: number; name?: string; sortOrder?: number }
  | { resource: "department"; op: "delete"; id: number }
  | { resource: "action-type"; op: "create"; name: string; waitingLabel: string; doneLabel: string; defaultDepartmentId?: number | null; sortOrder?: number }
  | { resource: "action-type"; op: "update"; id: number; name?: string; waitingLabel?: string; doneLabel?: string; defaultDepartmentId?: number | null; sortOrder?: number }
  | { resource: "action-type"; op: "delete"; id: number }
  | { resource: "dependency";  op: "add";    actionTypeId: number; dependsOnActionTypeId: number }
  | { resource: "dependency";  op: "remove"; actionTypeId: number; dependsOnActionTypeId: number }
  | { resource: "rule";        op: "set";    key: string; value: number | string }
  | { resource: "batch";       op: "update"; id: number; fields: Record<string, unknown> }
  | { resource: "batch";       op: "delete"; id: number }
  | { resource: "stakeholder"; op: "create"; departmentId: number; name: string; sortOrder?: number }
  | { resource: "stakeholder"; op: "update"; id: number; name?: string; sortOrder?: number }
  | { resource: "stakeholder"; op: "delete"; id: number }
  | { resource: "user"; op: "create"; username: string; password: string; name?: string | null; email?: string | null; role: "admin" | "ops" }
  | { resource: "user"; op: "update"; id: number; username?: string; name?: string | null; email?: string | null; role?: "admin" | "ops" }
  | { resource: "user"; op: "reset-password"; id: number; password: string }
  | { resource: "user"; op: "delete"; id: number }
  | { resource: "alert-rule"; op: "create"; name: string; triggerType: string; thresholdDays: number; actionTypeId?: number | null; severity: string }
  | { resource: "alert-rule"; op: "update"; id: number; name?: string; thresholdDays?: number; actionTypeId?: number | null; severity?: string; isActive?: boolean }
  | { resource: "alert-rule"; op: "delete"; id: number }
  | { resource: "vin-stage";  op: "create"; name: string; waitingLabel: string; doneLabel: string; sortOrder?: number }
  | { resource: "vin-stage";  op: "update"; id: number; name?: string; waitingLabel?: string; doneLabel?: string; sortOrder?: number }
  | { resource: "vin-stage";  op: "delete"; id: number };

export async function POST(req: NextRequest) {
  // Settings are admin-only — no other role can mutate departments,
  // action types, dependencies, rules, or batches from this endpoint.
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    switch (body.resource) {
      case "department":   return await handleDepartment(body);
      case "action-type":  return await handleActionType(body);
      case "dependency":   return await handleDependency(body);
      case "rule":         return await handleRule(body);
      case "batch":        return await handleBatch(body);
      case "stakeholder":  return await handleStakeholder(body);
      case "user":         return await handleUser(body, Number(gate.user.id));
      case "alert-rule":   return await handleAlertRule(body);
      case "vin-stage":    return await handleVinStage(body);
      default:
        return NextResponse.json({ error: "Unknown resource" }, { status: 400 });
    }
  } catch (e) {
    return translateError(e);
  }
}

/**
 * Map raw better-sqlite3 / Drizzle errors to user-friendly messages.
 * Keeps the SQL noise out of the editor UI.
 */
function translateError(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);

  // UNIQUE constraint — name collision on insert/update
  const uniqueMatch = msg.match(/UNIQUE constraint failed: (\w+)\.(\w+)/);
  if (uniqueMatch) {
    const [, table, field] = uniqueMatch;
    const subject =
      table === "departments" ? "department"
      : table === "action_types" ? "action type"
      : table.replace(/s$/, "");
    return NextResponse.json(
      { error: `A ${subject} with that ${field} already exists. Pick a different ${field}.` },
      { status: 409 },
    );
  }

  // FOREIGN KEY — referenced row in use
  if (/FOREIGN KEY constraint failed/i.test(msg)) {
    return NextResponse.json(
      { error: "Can't complete: this row is referenced by other data. Reassign or remove the references first." },
      { status: 409 },
    );
  }

  // NOT NULL — empty required field
  const notNullMatch = msg.match(/NOT NULL constraint failed: (\w+)\.(\w+)/);
  if (notNullMatch) {
    const [, , field] = notNullMatch;
    return NextResponse.json(
      { error: `${field.replace(/_/g, " ")} is required.` },
      { status: 400 },
    );
  }

  return NextResponse.json({ error: msg }, { status: 500 });
}

// ──────────────────────────────────────────────────────────────────
// Departments
// ──────────────────────────────────────────────────────────────────

async function handleDepartment(b: Extract<Body, { resource: "department" }>) {
  if (b.op === "create") {
    if (!b.name?.trim()) {
      return NextResponse.json({ error: "name required" }, { status: 400 });
    }
    const [row] = await db.insert(departments).values({
      name: b.name.trim(),
      sortOrder: Number.isFinite(b.sortOrder) ? Number(b.sortOrder) : 0,
    }).returning();
    return NextResponse.json({ ok: true, row });
  }
  if (b.op === "update") {
    const updates: Partial<typeof departments.$inferInsert> = {};
    if (b.name !== undefined) updates.name = b.name.trim();
    if (b.sortOrder !== undefined) updates.sortOrder = Number(b.sortOrder);
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "no fields to update" }, { status: 400 });
    }
    await db.update(departments).set(updates).where(eq(departments.id, b.id));
    return NextResponse.json({ ok: true });
  }
  if (b.op === "delete") {
    // Schema sets default_department_id and department_id to NULL on delete,
    // so we only need to confirm the dept exists, then delete.
    await db.delete(departments).where(eq(departments.id, b.id));
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Unknown op" }, { status: 400 });
}

// ──────────────────────────────────────────────────────────────────
// Action types
// ──────────────────────────────────────────────────────────────────

async function handleActionType(b: Extract<Body, { resource: "action-type" }>) {
  if (b.op === "create") {
    if (!b.name?.trim() || !b.waitingLabel?.trim() || !b.doneLabel?.trim()) {
      return NextResponse.json(
        { error: "name, waitingLabel, doneLabel all required" },
        { status: 400 },
      );
    }
    const [row] = await db.insert(actionTypes).values({
      name: b.name.trim(),
      waitingLabel: b.waitingLabel.trim(),
      doneLabel: b.doneLabel.trim(),
      defaultDepartmentId: b.defaultDepartmentId ?? null,
      sortOrder: Number.isFinite(b.sortOrder) ? Number(b.sortOrder) : 0,
    }).returning();
    return NextResponse.json({ ok: true, row });
  }
  if (b.op === "update") {
    const updates: Partial<typeof actionTypes.$inferInsert> = {};
    if (b.name !== undefined)               updates.name = b.name.trim();
    if (b.waitingLabel !== undefined)       updates.waitingLabel = b.waitingLabel.trim();
    if (b.doneLabel !== undefined)          updates.doneLabel = b.doneLabel.trim();
    if (b.defaultDepartmentId !== undefined) updates.defaultDepartmentId = b.defaultDepartmentId ?? null;
    if (b.sortOrder !== undefined)          updates.sortOrder = Number(b.sortOrder);
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "no fields to update" }, { status: 400 });
    }
    await db.update(actionTypes).set(updates).where(eq(actionTypes.id, b.id));
    return NextResponse.json({ ok: true });
  }
  if (b.op === "delete") {
    // batch_actions references action_types ON DELETE RESTRICT — refuse if
    // the action type is in use anywhere. Schema dependency cascade is
    // already cascade-on-delete for action_dependencies.
    const [used] = await db
      .select({ id: batchActions.id })
      .from(batchActions)
      .where(eq(batchActions.actionTypeId, b.id))
      .limit(1);
    if (used) {
      return NextResponse.json(
        { error: "Cannot delete: this action type is in use on existing batches. Mark all of them done or skipped first, or remove the action type from those batches." },
        { status: 409 },
      );
    }
    await db.delete(actionTypes).where(eq(actionTypes.id, b.id));
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Unknown op" }, { status: 400 });
}

// ──────────────────────────────────────────────────────────────────
// Dependencies
// ──────────────────────────────────────────────────────────────────

async function handleDependency(b: Extract<Body, { resource: "dependency" }>) {
  if (b.actionTypeId === b.dependsOnActionTypeId) {
    return NextResponse.json({ error: "An action cannot depend on itself" }, { status: 400 });
  }

  if (b.op === "add") {
    // Cycle check + insert in one transaction so two concurrent adds
    // can't both pass an isolated cycle check and end up creating a cycle.
    // libSQL transactions take an async callback; every query is awaited.
    const result = await db.transaction(async (tx) => {
      const wouldCycle = await pathExistsTx(tx, b.dependsOnActionTypeId, b.actionTypeId);
      if (wouldCycle) return { kind: "cycle" as const };

      const existingRows = await tx.select().from(actionDependencies).where(and(
        eq(actionDependencies.actionTypeId, b.actionTypeId),
        eq(actionDependencies.dependsOnActionTypeId, b.dependsOnActionTypeId),
      )).limit(1);
      if (existingRows[0]) return { kind: "exists" as const, row: existingRows[0] };

      const [row] = await tx.insert(actionDependencies).values({
        actionTypeId: b.actionTypeId,
        dependsOnActionTypeId: b.dependsOnActionTypeId,
      }).returning();
      return { kind: "created" as const, row };
    });

    if (result.kind === "cycle") {
      return NextResponse.json(
        { error: "This would create a dependency cycle" },
        { status: 400 },
      );
    }
    return NextResponse.json({ ok: true, row: result.row });
  }

  if (b.op === "remove") {
    await db.delete(actionDependencies).where(and(
      eq(actionDependencies.actionTypeId, b.actionTypeId),
      eq(actionDependencies.dependsOnActionTypeId, b.dependsOnActionTypeId),
    ));
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Unknown op" }, { status: 400 });
}

type SettingsTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Is there a directed path from `start` to `target` through dependencies?
 *  Async — runs inside a libSQL transaction. */
async function pathExistsTx(tx: SettingsTx, start: number, target: number): Promise<boolean> {
  const visited = new Set<number>([start]);
  let frontier: number[] = [start];
  while (frontier.length > 0) {
    const rows = await tx
      .select({ parent: actionDependencies.dependsOnActionTypeId })
      .from(actionDependencies)
      .where(eq(actionDependencies.actionTypeId, frontier[0]));
    frontier = frontier.slice(1);
    for (const r of rows) {
      if (r.parent === target) return true;
      if (!visited.has(r.parent)) {
        visited.add(r.parent);
        frontier.push(r.parent);
      }
    }
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────
// Rules
// ──────────────────────────────────────────────────────────────────

async function handleRule(b: Extract<Body, { resource: "rule" }>) {
  if (b.op === "set") {
    const known = Object.values(RULE_KEYS) as string[];
    if (!known.includes(b.key)) {
      return NextResponse.json({ error: `Unknown rule key: ${b.key}` }, { status: 400 });
    }
    if (b.key === RULE_KEYS.PRE_PO_OPS_LEAD_TIME_DAYS) {
      const n = Number(b.value);
      if (!Number.isFinite(n) || n < 1 || n > 365) {
        return NextResponse.json(
          { error: "lead time must be a number between 1 and 365" },
          { status: 400 },
        );
      }
      await setRuleNumber(b.key, n);
      return NextResponse.json({ ok: true, key: b.key, value: n });
    }
    return NextResponse.json({ error: "rule type not supported yet" }, { status: 400 });
  }
  return NextResponse.json({ error: "Unknown op" }, { status: 400 });
}

// ──────────────────────────────────────────────────────────────────
// Batches
// ──────────────────────────────────────────────────────────────────

/**
 * Whitelist of editable batch columns. Anything not on this list is
 * ignored. System-managed fields (id, batchCode, *_at_lock confidences,
 * targetPoDate, created_at, updated_at) are deliberately excluded.
 */
const EDITABLE_BATCH_FIELDS = new Set<string>([
  // PO header
  "poNumber", "poReference", "actualPoDate", "expectedPoDate",
  "poTotalSar", "poSubtotalSar", "poTaxTotalSar",
  // Identity
  "dealerId", "model", "year", "category",
  // Quantities
  "requestedQuantity", "allocatedQuantity", "deliveredQuantity",
  // Cities
  "appDisplayCities", "dealerReceivingCity",
  // Dates
  "requestedAt", "dealerPromisedDeliveryDate", "currentProjectedDeliveryDate",
  // Status
  "currentStage", "lifecycleState", "feasibilityStatus",
  // Commercial
  "buyBackRate", "contractLengthMonths", "colorSummary",
  "unitPriceSar", "taxPct", "lineAmountSar",
  // Confidence (live values; *_at_lock are never editable)
  "partnershipConfidence", "operationsConfidence", "riskScore",
  // Notes
  "notes",
]);

async function handleBatch(b: Extract<Body, { resource: "batch" }>) {
  if (b.op === "delete") {
    // batch_actions / vehicles / milestones / batch_color_matrix cascade
    // via FK ON DELETE CASCADE. `alerts.batch_id` was defined without
    // cascade, so any batch with active alerts (e.g. TEST-002/003/011
    // after the alert engine fires) would otherwise fail with a FOREIGN
    // KEY error. Delete those alerts first inside a transaction so the
    // batch delete either fully succeeds or rolls back cleanly.
    await db.transaction(async (tx) => {
      await tx.delete(alerts).where(eq(alerts.batchId, b.id));
      await tx.delete(batches).where(eq(batches.id, b.id));
    });
    return NextResponse.json({ ok: true });
  }

  if (b.op === "update") {
    const updates: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(b.fields ?? {})) {
      if (!EDITABLE_BATCH_FIELDS.has(k)) continue;
      // null is a legal "clear" for nullable fields.
      updates[k] = v === undefined ? null : v;
    }
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "no valid fields to update" }, { status: 400 });
    }

    // Coerce numeric fields that arrive as strings from <input type="number">
    const numericFields = [
      "year", "dealerId", "requestedQuantity", "allocatedQuantity", "deliveredQuantity",
      "buyBackRate", "contractLengthMonths", "unitPriceSar", "taxPct", "lineAmountSar",
      "poTotalSar", "poSubtotalSar", "poTaxTotalSar",
      "partnershipConfidence", "operationsConfidence", "riskScore",
    ];
    for (const f of numericFields) {
      if (f in updates && updates[f] !== null && updates[f] !== "") {
        const n = Number(updates[f]);
        if (!Number.isFinite(n)) {
          return NextResponse.json(
            { error: `${f} must be a number` },
            { status: 400 },
          );
        }
        updates[f] = n;
      } else if (f in updates && updates[f] === "") {
        updates[f] = null;
      }
    }

    // Recompute targetPoDate when promised date changes.
    if ("dealerPromisedDeliveryDate" in updates && typeof updates.dealerPromisedDeliveryDate === "string") {
      const lead = await getLeadTimeDays();
      const promisedMs = new Date(updates.dealerPromisedDeliveryDate).getTime();
      if (Number.isFinite(promisedMs)) {
        updates.targetPoDate = new Date(promisedMs - lead * 24 * 60 * 60 * 1000)
          .toISOString().slice(0, 10);
      }
    }

    updates.updatedAt = new Date().toISOString();
    await db.update(batches).set(updates).where(eq(batches.id, b.id));
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown op" }, { status: 400 });
}

// ──────────────────────────────────────────────────────────────────
// Stakeholders
// ──────────────────────────────────────────────────────────────────

async function handleStakeholder(b: Extract<Body, { resource: "stakeholder" }>) {
  if (b.op === "create") {
    if (!b.name?.trim()) {
      return NextResponse.json({ error: "name required" }, { status: 400 });
    }
    if (!Number.isFinite(b.departmentId)) {
      return NextResponse.json({ error: "departmentId required" }, { status: 400 });
    }
    const [row] = await db.insert(stakeholders).values({
      departmentId: b.departmentId,
      name:         b.name.trim(),
      sortOrder:    Number.isFinite(b.sortOrder) ? Number(b.sortOrder) : 0,
    }).returning();
    return NextResponse.json({ ok: true, row });
  }
  if (b.op === "update") {
    const updates: Partial<typeof stakeholders.$inferInsert> = {};
    if (b.name !== undefined)      updates.name = b.name.trim();
    if (b.sortOrder !== undefined) updates.sortOrder = Number(b.sortOrder);
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "no fields to update" }, { status: 400 });
    }
    await db.update(stakeholders).set(updates).where(eq(stakeholders.id, b.id));
    return NextResponse.json({ ok: true });
  }
  if (b.op === "delete") {
    // FK on batch_actions.assigned_stakeholder_id is ON DELETE SET NULL —
    // existing assignments become unassigned rather than orphaned.
    await db.delete(stakeholders).where(eq(stakeholders.id, b.id));
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Unknown op" }, { status: 400 });
}

// ──────────────────────────────────────────────────────────────────
// Users
// ──────────────────────────────────────────────────────────────────
//
// Safeguards (server-enforced; the UI mirrors them for UX):
//   - You can't delete your own user row.
//   - You can't change your own role out of admin (would lock you out).
//   - You can't delete the last admin in the table (anyone would).
//   - You can't demote the last admin.
//   - Passwords must be ≥ 8 chars when set; never stored plaintext.

async function handleUser(b: Extract<Body, { resource: "user" }>, callerId: number) {
  if (b.op === "create") {
    const username = (b.username ?? "").trim();
    const password = b.password ?? "";
    if (username.length < 2) {
      return NextResponse.json({ error: "username must be at least 2 characters" }, { status: 400 });
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json(
        { error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` },
        { status: 400 },
      );
    }
    if (b.role !== "admin" && b.role !== "ops") {
      return NextResponse.json({ error: "role must be 'admin' or 'ops'" }, { status: 400 });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const [row] = await db.insert(users).values({
      username,
      name:  b.name?.trim() || null,
      email: b.email?.trim() || null,
      role:  b.role,
      passwordHash,
    }).returning({
      id: users.id, username: users.username, name: users.name,
      email: users.email, role: users.role, createdAt: users.createdAt,
    });
    return NextResponse.json({ ok: true, row });
  }

  if (b.op === "update") {
    // Pull current row first so we can compare roles + identity for safeguards.
    const [current] = await db.select().from(users).where(eq(users.id, b.id));
    if (!current) {
      return NextResponse.json({ error: "user not found" }, { status: 404 });
    }
    const updates: Partial<typeof users.$inferInsert> = {};
    if (b.username !== undefined) {
      const u = b.username.trim();
      if (u.length < 2) {
        return NextResponse.json({ error: "username must be at least 2 characters" }, { status: 400 });
      }
      updates.username = u;
    }
    if (b.name  !== undefined) updates.name  = b.name?.trim()  || null;
    if (b.email !== undefined) updates.email = b.email?.trim() || null;
    if (b.role  !== undefined) {
      if (b.role !== "admin" && b.role !== "ops") {
        return NextResponse.json({ error: "role must be 'admin' or 'ops'" }, { status: 400 });
      }
      // Caller cannot demote themselves — would lock them out on next refresh.
      if (b.id === callerId && b.role !== "admin") {
        return NextResponse.json(
          { error: "You can't demote your own account out of admin. Ask another admin to do it." },
          { status: 400 },
        );
      }
      // Cannot demote the last remaining admin (regardless of who's asking).
      if (current.role === "admin" && b.role !== "admin") {
        const otherAdmins = await db.select({ id: users.id })
          .from(users)
          .where(and(eq(users.role, "admin"), ne(users.id, b.id)))
          .limit(1);
        if (otherAdmins.length === 0) {
          return NextResponse.json(
            { error: "Can't demote: this is the only admin. Create another admin first." },
            { status: 409 },
          );
        }
      }
      updates.role = b.role;
    }
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "no fields to update" }, { status: 400 });
    }
    await db.update(users).set(updates).where(eq(users.id, b.id));
    return NextResponse.json({ ok: true });
  }

  if (b.op === "reset-password") {
    if (!b.password || b.password.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json(
        { error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` },
        { status: 400 },
      );
    }
    const [current] = await db.select({ id: users.id }).from(users).where(eq(users.id, b.id));
    if (!current) {
      return NextResponse.json({ error: "user not found" }, { status: 404 });
    }
    const passwordHash = await bcrypt.hash(b.password, 10);
    await db.update(users).set({ passwordHash }).where(eq(users.id, b.id));
    return NextResponse.json({ ok: true });
  }

  if (b.op === "delete") {
    if (b.id === callerId) {
      return NextResponse.json(
        { error: "You can't delete your own account. Ask another admin to do it." },
        { status: 400 },
      );
    }
    const [current] = await db.select().from(users).where(eq(users.id, b.id));
    if (!current) {
      return NextResponse.json({ error: "user not found" }, { status: 404 });
    }
    if (current.role === "admin") {
      const otherAdmins = await db.select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, "admin"), ne(users.id, b.id)))
        .limit(1);
      if (otherAdmins.length === 0) {
        return NextResponse.json(
          { error: "Can't delete: this is the only admin. Create another admin first." },
          { status: 409 },
        );
      }
    }
    await db.delete(users).where(eq(users.id, b.id));
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown op" }, { status: 400 });
}

// ──────────────────────────────────────────────────────────────────
// Alert rules
// ──────────────────────────────────────────────────────────────────

const VALID_TRIGGER_TYPES = ["no_vin_before_avail", "action_overdue", "action_pending_before_avail"] as const;
const VALID_SEVERITIES    = ["critical", "high", "medium", "info"] as const;

async function handleAlertRule(b: Extract<Body, { resource: "alert-rule" }>) {
  if (b.op === "create") {
    if (!b.name?.trim()) {
      return NextResponse.json({ error: "name required" }, { status: 400 });
    }
    if (!VALID_TRIGGER_TYPES.includes(b.triggerType as never)) {
      return NextResponse.json({ error: "invalid triggerType" }, { status: 400 });
    }
    if (!VALID_SEVERITIES.includes(b.severity as never)) {
      return NextResponse.json({ error: "invalid severity" }, { status: 400 });
    }
    const days = Number(b.thresholdDays);
    if (!Number.isFinite(days) || days < 0) {
      return NextResponse.json({ error: "thresholdDays must be a non-negative number" }, { status: 400 });
    }

    const [row] = await db.insert(alertRules).values({
      name:          b.name.trim(),
      triggerType:   b.triggerType as typeof VALID_TRIGGER_TYPES[number],
      thresholdDays: days,
      actionTypeId:  b.actionTypeId ?? null,
      severity:      b.severity as typeof VALID_SEVERITIES[number],
      isActive:      true,
    }).returning();
    return NextResponse.json({ ok: true, row });
  }

  if (b.op === "update") {
    const updates: Partial<typeof alertRules.$inferInsert> = {};
    if (b.name !== undefined)         updates.name = b.name.trim();
    if (b.thresholdDays !== undefined) {
      const n = Number(b.thresholdDays);
      if (!Number.isFinite(n) || n < 0) {
        return NextResponse.json({ error: "thresholdDays must be a non-negative number" }, { status: 400 });
      }
      updates.thresholdDays = n;
    }
    if (b.actionTypeId !== undefined) updates.actionTypeId = b.actionTypeId ?? null;
    if (b.severity !== undefined) {
      if (!VALID_SEVERITIES.includes(b.severity as never)) {
        return NextResponse.json({ error: "invalid severity" }, { status: 400 });
      }
      updates.severity = b.severity as typeof VALID_SEVERITIES[number];
    }
    if (b.isActive !== undefined) updates.isActive = b.isActive;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "no fields to update" }, { status: 400 });
    }
    await db.update(alertRules).set(updates).where(eq(alertRules.id, b.id));
    return NextResponse.json({ ok: true });
  }

  if (b.op === "delete") {
    await db.delete(alertRules).where(eq(alertRules.id, b.id));
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown op" }, { status: 400 });
}

async function handleVinStage(b: Extract<Body, { resource: "vin-stage" }>) {
  if (b.op === "create") {
    if (!b.name?.trim() || !b.waitingLabel?.trim() || !b.doneLabel?.trim()) {
      return NextResponse.json(
        { error: "name, waitingLabel, doneLabel are all required" },
        { status: 400 },
      );
    }
    const [row] = await db.insert(vinChaseStages).values({
      name:         b.name.trim(),
      waitingLabel: b.waitingLabel.trim(),
      doneLabel:    b.doneLabel.trim(),
      sortOrder:    b.sortOrder ?? 0,
    }).returning();
    // Backfill: every existing batch gets a `batch_vin_stages` row for
    // this new stage with status="waiting". Without this, batches
    // created before the stage existed would render an incomplete chain.
    const allBatches = await db.select({ id: batches.id }).from(batches);
    for (const ba of allBatches) {
      await db.insert(batchVinStages).values({
        batchId: ba.id,
        stageId: row.id,
        status:  "waiting",
      }).onConflictDoNothing();
    }
    return NextResponse.json({ ok: true, row });
  }

  if (b.op === "update") {
    const updates: Partial<typeof vinChaseStages.$inferInsert> = {};
    if (b.name !== undefined) {
      if (!b.name.trim()) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
      updates.name = b.name.trim();
    }
    if (b.waitingLabel !== undefined) {
      if (!b.waitingLabel.trim()) return NextResponse.json({ error: "waitingLabel cannot be empty" }, { status: 400 });
      updates.waitingLabel = b.waitingLabel.trim();
    }
    if (b.doneLabel !== undefined) {
      if (!b.doneLabel.trim()) return NextResponse.json({ error: "doneLabel cannot be empty" }, { status: 400 });
      updates.doneLabel = b.doneLabel.trim();
    }
    if (b.sortOrder !== undefined) updates.sortOrder = b.sortOrder;
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "no fields to update" }, { status: 400 });
    }
    await db.update(vinChaseStages).set(updates).where(eq(vinChaseStages.id, b.id));
    return NextResponse.json({ ok: true });
  }

  if (b.op === "delete") {
    // FK cascade on batch_vin_stages takes care of per-batch rows.
    await db.delete(vinChaseStages).where(eq(vinChaseStages.id, b.id));
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown op" }, { status: 400 });
}
