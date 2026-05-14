/**
 * Synthetic data — 8 scenarios covering the locked-PO-Availability +
 * auto-floored-Ops-Expected model end-to-end. Each scenario lands the
 * Plan-vs-Reality timeline + Activity table in a clearly distinct state.
 *
 * The eight cases:
 *   1. 🆕 Pre-PO bet, comfortable runway.
 *   2. 🚨 Pre-PO bet, target PO date already past (low confidence).
 *   3. 🟢 Post-PO mid-ops, Ops Expected matches the dealer promise.
 *   4. ⚠️ Post-PO showcase — dealer promised inside the lead-time window;
 *      Ops Expected was auto-floored to today + leadTime, so Ops trails
 *      the dealer promise. Marks the at_risk path + Slack
 *      "OPS BEHIND PROMISE" callout.
 *   5. 🔵 Post-PO with Ops more aggressive than the dealer (near_done,
 *      completing slightly ahead of plan).
 *   6. 🎉 Delivered exactly on the dealer-promised date.
 *   7. ⚠️ Delivered 7d past the dealer-promised date.
 *   8. ❌ Cancelled mid-way (Plate onward marked skipped).
 *
 * Seeds in order:
 *   1. users (admin, ops1)
 *   2. departments (5 defaults — admin edits in Settings)
 *   3. action_types (9 defaults)
 *   4. action_dependencies (Plate ← VIN, Customs ← Plate, etc.)
 *   5. dealers (4)
 *   6. batches × 8 scenarios + per-batch batch_actions
 *
 * Run:  npm run db:seed
 *
 * The script wipes existing data first. A previous version of the seed
 * (with the older block + override risk model) is documented in
 * `docs/seed-data-backup-2026-05-10.md`.
 *
 * Note: legacy `milestones` writes are still here because some older
 * code paths read from them. They mirror the new `batch_actions` data
 * for back-compat and can be removed once the last consumer migrates.
 */
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import {
  users, dealers, batches, milestones, milestoneEvents, vehicles, alerts,
  departments, stakeholders, actionTypes, actionDependencies, batchActions, settings,
} from "@/lib/db/schema";
import { makeBatchCode } from "@/lib/utils";
import { RULE_KEYS } from "@/lib/rules";
import { computeExpectedDate } from "@/lib/expected-date";

// ──────────────────────────────────────────────────────────────────
// Reference data
// ──────────────────────────────────────────────────────────────────

const SEED_USERS = [
  { username: "admin", name: "Admin User",  role: "admin" as const, email: "admin@invygo.local", password: "admin123" },
  { username: "ops1",  name: "Ops Manager", role: "ops"   as const, email: "ops1@invygo.local",  password: "ops123"   },
];

/** 5 default departments. Admin edits in Settings. */
const SEED_DEPARTMENTS = [
  { name: "Specs",       sortOrder: 1 },
  { name: "Pricing",     sortOrder: 2 },
  { name: "Operations",  sortOrder: 3 },
  { name: "Logistics",   sortOrder: 4 },
  { name: "Partnership", sortOrder: 5 },
];

/**
 * Default stakeholders per department. Each is a person (or sub-team)
 * Ops can assign to actions at Intake. Admin edits in Settings →
 * Departments. Names are the existing tracker_v1 ACTION_ITEMS people
 * plus a couple of generic placeholders.
 */
const SEED_STAKEHOLDERS: { departmentName: string; name: string; sortOrder: number }[] = [
  { departmentName: "Specs",       name: "Eslam Medhat",      sortOrder: 1 },
  { departmentName: "Specs",       name: "Mohan Sai",         sortOrder: 2 },
  { departmentName: "Pricing",     name: "Abdullah Alamoudi", sortOrder: 1 },
  { departmentName: "Pricing",     name: "Mohan Sai",         sortOrder: 2 },
  { departmentName: "Operations",  name: "Ahmed Abdulhai",    sortOrder: 1 },
  { departmentName: "Operations",  name: "Operations Lead",   sortOrder: 2 },
  { departmentName: "Logistics",   name: "Logistics Lead",    sortOrder: 1 },
  { departmentName: "Partnership", name: "Partnership Lead",  sortOrder: 1 },
];

/**
 * 9 default action types. `defaultDepartment` matches the seeded
 * department names. `offsetDays` + `offsetAnchor` describe when the
 * action is expected to complete relative to a known reference point.
 * Admin edits all of these in Settings.
 *
 * Anchoring strategy:
 *   - Pre-VIN admin work (Specs / Pricing / SKU): anchored to submission
 *   - VIN itself: anchored to submission, +3 days (typical commitment)
 *   - Post-VIN dealer/ops work: anchored to VIN actual, with realistic offsets
 *   - Delivery: anchored to the promised date (offsetDays ignored)
 */
/**
 * Two parallel flows that converge at Delivery:
 *
 *   Internal phase (parallel, customizable per batch) — cars get listed
 *   on the app pre-VIN so customers can pre-book against dummies:
 *     1 Car Specs
 *     2 Pricing
 *     3 SKU
 *     4 App Listing   ← pre-VIN dummy listing
 *
 *   VIN-chase flow (linear, mandatory every batch) — turns dummies into
 *   real cars ready for handover. Skip steps 5–6 when the dealer shared
 *   VIN with the PO (`batches.vin_received_at_intake = true`):
 *     5 Send Dealer Confirmation Email
 *     6 VIN
 *     7 Plate
 *     8 Customs Card
 *     9 Tracking System Installed
 *    10 Car Inspection
 *    11 Car Ready in Showroom
 *
 *   Final:
 *    12 Delivery (depends on App Listing AND Car Ready in Showroom)
 */
const SEED_ACTION_TYPES = [
  // Internal phase ────────────────────────────────────────────────
  { name: "Car Specs",                    waitingLabel: "Waiting Car Specs",      doneLabel: "Specs Received",      defaultDepartment: "Specs",      sortOrder:  1, offsetDays:  1, offsetAnchor: "submission" as const },
  { name: "Pricing",                      waitingLabel: "Waiting Pricing",        doneLabel: "Pricing Received",    defaultDepartment: "Pricing",    sortOrder:  2, offsetDays:  1, offsetAnchor: "submission" as const },
  { name: "SKU",                          waitingLabel: "Waiting SKU",            doneLabel: "SKU Created",         defaultDepartment: "Specs",      sortOrder:  3, offsetDays:  2, offsetAnchor: "submission" as const },
  { name: "App Listing",                  waitingLabel: "Waiting App Listing",    doneLabel: "Listed in App",       defaultDepartment: "Operations", sortOrder:  4, offsetDays:  5, offsetAnchor: "submission" as const },
  // VIN-chase flow ────────────────────────────────────────────────
  { name: "Send Dealer Confirmation Email", waitingLabel: "Waiting Dealer Email", doneLabel: "Email Sent",          defaultDepartment: "Operations", sortOrder:  5, offsetDays:  1, offsetAnchor: "submission" as const },
  { name: "VIN",                          waitingLabel: "Waiting VIN",            doneLabel: "VIN Received",        defaultDepartment: "Operations", sortOrder:  6, offsetDays:  5, offsetAnchor: "submission" as const },
  { name: "Plate",                        waitingLabel: "Waiting Plate",          doneLabel: "Plate Assigned",      defaultDepartment: "Operations", sortOrder:  7, offsetDays:  3, offsetAnchor: "vin"        as const },
  { name: "Customs Card",                 waitingLabel: "Waiting Customs",        doneLabel: "Customs Received",    defaultDepartment: "Logistics",  sortOrder:  8, offsetDays:  5, offsetAnchor: "vin"        as const },
  { name: "Tracking System Installed",    waitingLabel: "Waiting Tracking",       doneLabel: "Tracking Installed",  defaultDepartment: "Operations", sortOrder:  9, offsetDays:  6, offsetAnchor: "vin"        as const },
  { name: "Car Inspection",               waitingLabel: "Waiting Inspection",     doneLabel: "Inspection Done",     defaultDepartment: "Operations", sortOrder: 10, offsetDays:  8, offsetAnchor: "vin"        as const },
  { name: "Car Ready in Showroom",        waitingLabel: "Waiting Showroom Ready", doneLabel: "Ready in Showroom",   defaultDepartment: "Operations", sortOrder: 11, offsetDays: 10, offsetAnchor: "vin"        as const },
  // Final ────────────────────────────────────────────────────────
  { name: "Delivery",                     waitingLabel: "Waiting Delivery",       doneLabel: "Delivered",           defaultDepartment: "Logistics",  sortOrder: 12, offsetDays:  0, offsetAnchor: "promised"   as const },
];

/**
 * Dependency DAG. `child` cannot start until every entry in `parents` is done.
 *
 * The VIN-chase flow is a linear chain. The internal phase (Car Specs /
 * Pricing / SKU / App Listing) runs in parallel with no internal deps.
 * Delivery is the convergence point — both flows must reach it before
 * the customer can take the car.
 */
const SEED_DEPENDENCIES: { child: string; parents: string[] }[] = [
  // VIN-chase chain
  { child: "VIN",                       parents: ["Send Dealer Confirmation Email"] },
  { child: "Plate",                     parents: ["VIN"] },
  { child: "Customs Card",              parents: ["Plate"] },
  { child: "Tracking System Installed", parents: ["Plate"] },
  { child: "Car Inspection",            parents: ["Tracking System Installed"] },
  { child: "Car Ready in Showroom",     parents: ["Car Inspection"] },
  // Final convergence — both flows must complete
  { child: "Delivery",                  parents: ["App Listing", "Car Ready in Showroom"] },
];

const DEALERS = [
  { name: "Al-Riyadh Motors",   dealerType: "old" as const, homeCity: "Riyadh", policyStatus: "existing" as const },
  { name: "Capital Auto Group", dealerType: "old" as const, homeCity: "Jeddah", policyStatus: "existing" as const },
  { name: "Dammam Fleet Hub",   dealerType: "new" as const, homeCity: "Dammam", policyStatus: "pending"  as const },
  { name: "Khobar Premier",     dealerType: "new" as const, homeCity: "Khobar", policyStatus: "provided" as const },
];

type ConfLabel = "High Confidence" | "50% Confidence" | "Low Confidence";

/**
 * Action-progress preset. Each preset enumerates every action_type and
 * the status the seeded batch_action should land in. Iteration order is
 * sortOrder so dependency cascades stay sensible.
 */
type ActionPreset =
  | "none"               // pre-PO — no actions seeded
  | "mid_specs_vin"      // Specs/Pricing/SKU done; VIN waiting; rest blocked or waiting
  | "mid_plate"          // Plate just landed; Customs / App Listing waiting; Delivery blocked
  | "near_done"          // everything done except Delivery
  | "all_done"           // all 9 done (delivered batches)
  | "cancelled_partial"; // through VIN done; Plate onward skipped

interface Scenario {
  label: string;
  dealerIdx: number;
  model: string;
  year: number;
  qty: number;
  category: string;
  submittedOffset: number;
  promisedOffset: number;
  expectedPoOffset: number;
  actualPoOffset: number | null;
  /**
   * Days from today for `currentProjectedDeliveryDate` — i.e. Ops's own
   * commitment, separate from the dealer-promised availability. Null
   * for pre-PO bets where Ops hasn't committed yet. The seed picks this
   * to demonstrate three states: Ops-matches-dealer (feasible),
   * Ops-behind-dealer (at_risk), Ops-ahead-of-dealer (feasible-aggressive).
   */
  opsExpectedOffset: number | null;
  /**
   * Days from today for `vinReceivingDate`. Null on pre-PO and right
   * after Intake — Ops captures it later in the Action Center when the dealer
   * commits a VIN-share date.
   */
  vinReceivingOffset: number | null;
  /** Days from today when the batch closed. Null = still open. */
  closedOffset: number | null;
  closureReason: "delivered" | "cancelled" | null;
  cancellationNote: string | null;
  progress: ActionPreset;
  /**
   * Days added to every done action's `expectedDate` to derive its
   * `completedAt`. 0 = on-time; positive = late; negative = early.
   * Delivery action is special-cased to land on `closedOffset` when
   * the closure reason is "delivered".
   */
  completionDelayDays: number;
  confidence: ConfLabel;
}

/**
 * Eight scenarios covering every state of the new
 * locked-PO-Availability + auto-floored-Ops-Expected model. Specifically:
 *   1. Pre-PO bet with comfortable runway.
 *   2. Pre-PO bet with the target-PO-date already overdue (low confidence).
 *   3. Post-PO mid-ops, Ops Expected matches the dealer promise (feasible).
 *   4. SHOWCASE — Post-PO with the dealer-promise inside the lead-time
 *      window. Ops Expected was auto-floored to today + leadTime, so
 *      Ops trails the dealer promise. Marks the at_risk path + Slack
 *      "OPS BEHIND PROMISE" callout.
 *   5. Post-PO with Ops more aggressive than the dealer (Ops manually
 *      committed earlier than promised — completes ahead-of-plan).
 *   6. Delivered exactly on the dealer-promised date.
 *   7. Delivered 7d past the dealer-promised date.
 *   8. Cancelled mid-way (Plate onward marked skipped; cancellationNote
 *      explains why).
 */
const SCENARIOS: Scenario[] = [
  {
    label: "🆕 Pre-PO bet — 60d runway, comfortable",
    dealerIdx: 1, // Capital Auto Group
    model: "Toyota Camry", year: 2026, qty: 30, category: "Standard",
    submittedOffset: -2, promisedOffset: +60, expectedPoOffset: +35,
    actualPoOffset: null, opsExpectedOffset: null, vinReceivingOffset: null,
    closedOffset: null, closureReason: null, cancellationNote: null,
    progress: "none",
    completionDelayDays: 0,
    confidence: "High Confidence",
  },
  {
    label: "🚨 Pre-PO bet — target PO date already past",
    dealerIdx: 2, // Dammam Fleet Hub
    model: "BMW X5", year: 2026, qty: 8, category: "Full Option",
    submittedOffset: -14, promisedOffset: +5, expectedPoOffset: -3,
    actualPoOffset: null, opsExpectedOffset: null, vinReceivingOffset: null,
    closedOffset: null, closureReason: null, cancellationNote: null,
    progress: "none",
    completionDelayDays: 0,
    confidence: "Low Confidence",
  },
  {
    label: "🟢 Post-PO — Ops matches dealer promise (mid-ops, plate done)",
    dealerIdx: 1, // Capital Auto Group
    model: "Hyundai Tucson", year: 2026, qty: 25, category: "Mid Option",
    submittedOffset: -20, promisedOffset: +25, expectedPoOffset: -15,
    actualPoOffset: -15, opsExpectedOffset: +25, vinReceivingOffset: -10,
    closedOffset: null, closureReason: null, cancellationNote: null,
    progress: "mid_plate",
    completionDelayDays: 0,
    confidence: "High Confidence",
  },
  {
    label: "⚠️ SHOWCASE — Ops ETA +6d past dealer promise (locked PO + auto-floor)",
    dealerIdx: 0, // Al-Riyadh Motors
    model: "MG ZS", year: 2026, qty: 20, category: "Standard",
    submittedOffset: -10, promisedOffset: +5, expectedPoOffset: -7,
    actualPoOffset: -7, opsExpectedOffset: +11, vinReceivingOffset: -2,
    closedOffset: null, closureReason: null, cancellationNote: null,
    progress: "mid_specs_vin",
    completionDelayDays: 0,
    confidence: "50% Confidence",
  },
  {
    label: "🔵 Post-PO — Ops 12d ahead of dealer promise (near_done, on-pace)",
    dealerIdx: 1, // Capital Auto Group
    model: "Kia Cerato", year: 2026, qty: 40, category: "Standard",
    submittedOffset: -25, promisedOffset: +30, expectedPoOffset: -20,
    actualPoOffset: -22, opsExpectedOffset: +18, vinReceivingOffset: -15,
    closedOffset: null, closureReason: null, cancellationNote: null,
    progress: "near_done",
    completionDelayDays: -1,
    confidence: "High Confidence",
  },
  {
    label: "🎉 Delivered exactly on dealer promise",
    dealerIdx: 3, // Khobar Premier
    model: "Nissan Patrol", year: 2025, qty: 15, category: "Full Option",
    submittedOffset: -50, promisedOffset: -5, expectedPoOffset: -28,
    actualPoOffset: -26, opsExpectedOffset: -5, vinReceivingOffset: -45,
    closedOffset: -5, closureReason: "delivered", cancellationNote: null,
    progress: "all_done",
    completionDelayDays: 0,
    confidence: "High Confidence",
  },
  {
    label: "⚠️ Delivered 7d past dealer promise",
    dealerIdx: 3, // Khobar Premier
    model: "Chevrolet Tahoe", year: 2025, qty: 10, category: "Full Option",
    submittedOffset: -65, promisedOffset: -10, expectedPoOffset: -38,
    actualPoOffset: -31, opsExpectedOffset: -10, vinReceivingOffset: -55,
    closedOffset: -3, closureReason: "delivered", cancellationNote: null,
    progress: "all_done",
    completionDelayDays: 2,
    confidence: "50% Confidence",
  },
  {
    label: "❌ Cancelled mid-way — color matrix unavailable",
    dealerIdx: 0, // Al-Riyadh Motors
    model: "Honda Accord", year: 2026, qty: 12, category: "Mid Option",
    submittedOffset: -40, promisedOffset: +20, expectedPoOffset: -32,
    actualPoOffset: -35, opsExpectedOffset: +20, vinReceivingOffset: -28,
    closedOffset: -3, closureReason: "cancelled",
    cancellationNote: "Dealer pulled out — requested color matrix unavailable for the year-end SKU.",
    progress: "cancelled_partial",
    completionDelayDays: 0,
    confidence: "50% Confidence",
  },
];

/**
 * Per-action statuses for each preset. Keys must match `SEED_ACTION_TYPES.name`.
 * Iteration order matches the SEED_ACTION_TYPES order — used by the
 * Delivery / non-Delivery completion logic below.
 */
type ActionStatus = "waiting" | "blocked" | "done" | "skipped";
const PROGRESS_PRESETS: Record<ActionPreset, Record<string, ActionStatus>> = {
  none: {},
  mid_specs_vin: {
    "Car Specs":                       "done",
    "Pricing":                         "done",
    "SKU":                             "done",
    "App Listing":                     "waiting",      // pre-VIN dummy listing in flight
    "Send Dealer Confirmation Email":  "done",
    "VIN":                             "waiting",
    "Plate":                           "blocked",
    "Customs Card":                    "blocked",
    "Tracking System Installed":       "blocked",
    "Car Inspection":                  "blocked",
    "Car Ready in Showroom":           "blocked",
    "Delivery":                        "blocked",
  },
  mid_plate: {
    "Car Specs":                       "done",
    "Pricing":                         "done",
    "SKU":                             "done",
    "App Listing":                     "done",         // dummies are listed pre-VIN
    "Send Dealer Confirmation Email":  "done",
    "VIN":                             "done",
    "Plate":                           "done",
    "Customs Card":                    "waiting",      // Plate just landed — Customs unblocked
    "Tracking System Installed":       "waiting",      // Plate just landed — Tracking unblocked
    "Car Inspection":                  "blocked",      // waits on Tracking
    "Car Ready in Showroom":           "blocked",      // waits on Inspection
    "Delivery":                        "blocked",
  },
  near_done: {
    "Car Specs":                       "done",
    "Pricing":                         "done",
    "SKU":                             "done",
    "App Listing":                     "done",
    "Send Dealer Confirmation Email":  "done",
    "VIN":                             "done",
    "Plate":                           "done",
    "Customs Card":                    "done",
    "Tracking System Installed":       "done",
    "Car Inspection":                  "done",
    "Car Ready in Showroom":           "done",
    "Delivery":                        "waiting",      // ready to ship
  },
  all_done: {
    "Car Specs":                       "done",
    "Pricing":                         "done",
    "SKU":                             "done",
    "App Listing":                     "done",
    "Send Dealer Confirmation Email":  "done",
    "VIN":                             "done",
    "Plate":                           "done",
    "Customs Card":                    "done",
    "Tracking System Installed":       "done",
    "Car Inspection":                  "done",
    "Car Ready in Showroom":           "done",
    "Delivery":                        "done",
  },
  cancelled_partial: {
    "Car Specs":                       "done",
    "Pricing":                         "done",
    "SKU":                             "done",
    "App Listing":                     "skipped",
    "Send Dealer Confirmation Email":  "done",
    "VIN":                             "done",
    "Plate":                           "skipped",
    "Customs Card":                    "skipped",
    "Tracking System Installed":       "skipped",
    "Car Inspection":                  "skipped",
    "Car Ready in Showroom":           "skipped",
    "Delivery":                        "skipped",
  },
};

const CONF_VALUE: Record<ConfLabel, number> = {
  "High Confidence": 80,
  "50% Confidence":  50,
  "Low Confidence":  20,
};

const RISK_VALUE: Record<ConfLabel, number> = {
  "High Confidence": 18,
  "50% Confidence":  62,
  "Low Confidence":  85,
};

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

const PRE_PO_OPS_LEAD_TIME_DAYS = 21;
const DAY_MS = 24 * 60 * 60 * 1000;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoFromOffset(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
}

function isoNullable(days: number | null): string | null {
  return days == null ? null : isoFromOffset(days);
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(a).getTime() - new Date(b).getTime()) / DAY_MS);
}

// ──────────────────────────────────────────────────────────────────
// Per-scenario action progress
// ──────────────────────────────────────────────────────────────────

type ActionState = {
  actionTypeName: string;
  status: ActionStatus;
  completedAt: string | null;
};

/**
 * Compute the seeded batch_action rows for a scenario.
 *   - `progress: "none"`               → empty (pre-PO; actions land at Intake).
 *   - any other progress preset        → one row per action_type using the preset's status.
 *
 * For done actions, `completedAt = expectedDate + scn.completionDelayDays`.
 * The Delivery action gets a special case: when the closure reason is
 * "delivered", its completedAt is `closedOffset` exactly so the timeline
 * marker lines up with the canonical delivered date.
 */
function actionsForScenario(scn: Scenario): ActionState[] {
  const preset = PROGRESS_PRESETS[scn.progress];
  if (Object.keys(preset).length === 0) return [];

  const submitted = isoFromOffset(scn.submittedOffset);
  const promised  = isoFromOffset(scn.promisedOffset);
  const vin       = scn.vinReceivingOffset != null ? isoFromOffset(scn.vinReceivingOffset) : null;
  const closedIso = scn.closedOffset != null ? isoFromOffset(scn.closedOffset) : null;

  return Object.entries(preset).map(([name, status]) => {
    if (status !== "done") {
      return { actionTypeName: name, status, completedAt: null };
    }

    // Delivery-on-delivered batches: exact match with closedAt.
    if (name === "Delivery" && scn.closureReason === "delivered" && closedIso) {
      return { actionTypeName: name, status, completedAt: closedIso };
    }

    const at = SEED_ACTION_TYPES.find((a) => a.name === name)!;
    const expected = computeExpectedDate({
      anchor:     at.offsetAnchor,
      offsetDays: at.offsetDays,
      submission: submitted,
      vin,
      promised,
    });
    const baseIso = expected ?? submitted;
    const completedMs = new Date(baseIso).getTime() + scn.completionDelayDays * DAY_MS;
    const completedAt = new Date(completedMs).toISOString().slice(0, 10);
    return { actionTypeName: name, status, completedAt };
  });
}

// ──────────────────────────────────────────────────────────────────
// Seed
// ──────────────────────────────────────────────────────────────────

async function seed() {
  // Hard guard — refuse to wipe and re-seed against a production database.
  // Set ALLOW_PROD_SEED=yes-i-am-sure if you genuinely intend it (e.g. a
  // brand-new prod environment that needs the synthetic demo).
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_PROD_SEED !== "yes-i-am-sure") {
    console.error("❌ Refusing to seed against a production database.");
    console.error("   This script DELETES all existing batches/users/etc.");
    console.error("   If you really want to run it in production, set:");
    console.error("     ALLOW_PROD_SEED=yes-i-am-sure");
    process.exit(1);
  }

  console.log("🌱 Seeding synthetic data…\n");

  // Wipe in dependency order. SQLite cascades take care of children
  // (milestones / vehicles / alerts / batch_actions) when batches are deleted.
  await db.delete(milestoneEvents);
  await db.delete(milestones);
  await db.delete(vehicles);
  await db.delete(alerts);
  await db.delete(batchActions);
  await db.delete(batches);
  await db.delete(actionDependencies);
  await db.delete(actionTypes);
  await db.delete(stakeholders);
  await db.delete(departments);
  await db.delete(dealers);
  await db.delete(users);
  await db.delete(settings);
  console.log("  ✓ Cleared existing data");

  // ── Rules (key/value settings) ─────────────────────────────────
  await db.insert(settings).values([
    { key: RULE_KEYS.PRE_PO_OPS_LEAD_TIME_DAYS, value: String(PRE_PO_OPS_LEAD_TIME_DAYS) },
  ]);
  console.log("  ✓ Inserted default rules");

  // ── Users ──────────────────────────────────────────────────────
  for (const u of SEED_USERS) {
    const passwordHash = await bcrypt.hash(u.password, 10);
    await db.insert(users).values({
      username: u.username, name: u.name, email: u.email, role: u.role, passwordHash,
    });
  }
  console.log(`  ✓ Inserted ${SEED_USERS.length} users (admin / ops1)`);

  // ── Departments ────────────────────────────────────────────────
  const departmentIdByName = new Map<string, number>();
  for (const d of SEED_DEPARTMENTS) {
    const [row] = await db.insert(departments).values(d).returning({ id: departments.id });
    departmentIdByName.set(d.name, row.id);
  }
  console.log(`  ✓ Inserted ${SEED_DEPARTMENTS.length} departments`);

  // ── Stakeholders ───────────────────────────────────────────────
  // Track default (first sortOrder) stakeholder per department so we can
  // pre-assign each seeded batch_action below.
  const defaultStakeholderIdByDept = new Map<number, number>();
  for (const s of SEED_STAKEHOLDERS) {
    const deptId = departmentIdByName.get(s.departmentName);
    if (!deptId) continue;
    const [row] = await db.insert(stakeholders).values({
      departmentId: deptId,
      name:         s.name,
      sortOrder:    s.sortOrder,
    }).returning({ id: stakeholders.id });
    if (s.sortOrder === 1) defaultStakeholderIdByDept.set(deptId, row.id);
  }
  console.log(`  ✓ Inserted ${SEED_STAKEHOLDERS.length} stakeholders`);

  // ── Action types ───────────────────────────────────────────────
  const actionTypeIdByName = new Map<string, number>();
  for (const a of SEED_ACTION_TYPES) {
    const [row] = await db.insert(actionTypes).values({
      name: a.name,
      waitingLabel: a.waitingLabel,
      doneLabel: a.doneLabel,
      defaultDepartmentId: departmentIdByName.get(a.defaultDepartment) ?? null,
      offsetDays: a.offsetDays,
      offsetAnchor: a.offsetAnchor,
      sortOrder: a.sortOrder,
    }).returning({ id: actionTypes.id });
    actionTypeIdByName.set(a.name, row.id);
  }
  console.log(`  ✓ Inserted ${SEED_ACTION_TYPES.length} action types`);

  // ── Dependencies ───────────────────────────────────────────────
  let depCount = 0;
  for (const dep of SEED_DEPENDENCIES) {
    const childId = actionTypeIdByName.get(dep.child)!;
    for (const parent of dep.parents) {
      await db.insert(actionDependencies).values({
        actionTypeId:          childId,
        dependsOnActionTypeId: actionTypeIdByName.get(parent)!,
      });
      depCount++;
    }
  }
  console.log(`  ✓ Inserted ${depCount} action dependencies`);

  // ── Dealers ────────────────────────────────────────────────────
  const dealerIds: number[] = [];
  for (const d of DEALERS) {
    const [row] = await db.insert(dealers)
      .values({ ...d, avgResponseDays: 3.0 })
      .returning({ id: dealers.id });
    dealerIds.push(row.id);
  }
  console.log(`  ✓ Inserted ${DEALERS.length} dealers`);

  // ── Batches + batch_actions + (legacy) milestones ──────────────
  for (let i = 0; i < SCENARIOS.length; i++) {
    const scn       = SCENARIOS[i];
    const dealer    = DEALERS[scn.dealerIdx];
    const dealerId  = dealerIds[scn.dealerIdx];

    const submitted  = isoFromOffset(scn.submittedOffset);
    const promised   = isoFromOffset(scn.promisedOffset);
    const expectedPo = isoFromOffset(scn.expectedPoOffset);
    const actualPo   = isoNullable(scn.actualPoOffset);
    const closed     = isoNullable(scn.closedOffset);
    const opsExpected = isoNullable(scn.opsExpectedOffset);
    const vinReceiving = isoNullable(scn.vinReceivingOffset);

    const targetPoDate = isoFromOffset(scn.promisedOffset - PRE_PO_OPS_LEAD_TIME_DAYS);

    /**
     * `currentProjectedDeliveryDate` now stores Ops's commitment, not a
     * heuristic copy of the dealer date. Three sources, in order:
     *   - closed batch  → the closedAt date itself (final state)
     *   - post-PO batch → the scenario's opsExpectedOffset
     *   - pre-PO batch  → the dealer-promised date as a placeholder
     *                     (Ops hasn't committed yet)
     */
    const projected: string = closed ?? opsExpected ?? promised;

    /**
     * Stage codes — kept for the legacy timeline. `cancelled` doesn't
     * exist as a stage (closure happens via closureReason on the batch),
     * so cancelled scenarios use `dealer_confirmation` as the last stage
     * Ops actually reached.
     */
    let currentStage = "request_submitted";
    if (scn.closureReason === "delivered") currentStage = "delivered";
    else if (actualPo)                     currentStage = "dealer_confirmation";

    const lifecycleState = actualPo ? "post_po" : "pre_po";

    /**
     * Feasibility flag — at_risk whenever Ops's commitment trails the
     * dealer-promised availability. Pre-PO bets default to feasible
     * (no Ops commitment yet); the showcase scenario (Ops behind) lands
     * on at_risk via this rule rather than via confidence label.
     */
    const feasibilityStatus: "feasible" | "at_risk" =
      opsExpected != null && opsExpected > promised ? "at_risk" : "feasible";

    // Synthetic PO numbers — `S` prefix marks them as seed data, not real POs.
    const syntheticPoNumber = `PO-S${String(i + 1).padStart(3, "0")}`;
    const batchCode = makeBatchCode({
      poNumber:   syntheticPoNumber,
      dealerName: dealer.name,
      splitN:     1,
      splitTotal: 1,
      city:       dealer.homeCity,
      model:      scn.model,
      qty:        scn.qty,
    });

    const [{ id: batchId }] = await db.insert(batches).values({
      batchCode,
      dealerId,
      model:    scn.model,
      year:     scn.year,
      category: scn.category,
      requestedQuantity: scn.qty,
      requestedAt: submitted,
      dealerPromisedDeliveryDate: promised,
      targetPoDate,
      expectedPoDate: expectedPo,
      actualPoDate:   actualPo ?? undefined,
      // Ops commitment (separate column from the dealer promise).
      currentProjectedDeliveryDate: projected,
      currentStage,
      lifecycleState,
      // Closure — drives the dashboard "Delivered" / "Cancelled" chip
      // and the Plan-vs-Reality SVG end-of-track marker.
      closedAt:         closed ?? undefined,
      closureReason:    scn.closureReason ?? undefined,
      cancellationNote: scn.cancellationNote ?? undefined,
      // VIN receiving date — null at Intake by design; Ops captures it
      // later in the Action Center. Seeded here for scenarios that have already
      // moved past that point (mid-ops, near-done, delivered, cancelled).
      vinReceivingDate: vinReceiving ?? undefined,
      poNumber: syntheticPoNumber,   // populate so the dashboard table can show it
      appDisplayCities: dealer.homeCity,
      dealerReceivingCity: dealer.homeCity,
      requiresInterCityTransit: false,
      dealerPolicySource: dealer.name,
      partnershipConfidence:        CONF_VALUE[scn.confidence],
      partnershipConfidenceAtLock:  CONF_VALUE[scn.confidence],
      operationsConfidence:         CONF_VALUE[scn.confidence],
      operationsConfidenceAtLock:   actualPo ? CONF_VALUE[scn.confidence] : null,
      feasibilityStatus,
      riskScore: RISK_VALUE[scn.confidence],
      deliveredQuantity: scn.closureReason === "delivered" ? scn.qty : 0,
      allocatedQuantity: scn.closureReason === "delivered" ? scn.qty : 0,
      notes: scn.label,
    }).returning({ id: batches.id });

    // ── Per-batch actions (new model) ────────────────────────
    const actionStates = actionsForScenario(scn);
    for (const a of actionStates) {
      const actionTypeId = actionTypeIdByName.get(a.actionTypeName)!;
      const seedDef = SEED_ACTION_TYPES.find((s) => s.name === a.actionTypeName)!;
      const deptId = departmentIdByName.get(seedDef.defaultDepartment) ?? null;
      // Compute initial expectedDate from offset + anchor. Vin-anchored
      // actions get a null expectedDate when the scenario hasn't captured
      // a VIN receiving date yet — mirrors what /api/intake/create does.
      const expectedDate = computeExpectedDate({
        anchor:     seedDef.offsetAnchor,
        offsetDays: seedDef.offsetDays,
        submission: submitted,
        vin:        vinReceiving,
        promised,
      });
      await db.insert(batchActions).values({
        batchId,
        actionTypeId,
        departmentId: deptId,
        // Pre-assign each seeded action to the first stakeholder of its
        // department so the demo data is realistic out of the box.
        assignedStakeholderId: deptId ? (defaultStakeholderIdByDept.get(deptId) ?? null) : null,
        status: a.status,
        expectedDate,
        completedAt: a.completedAt ?? undefined,
      });
    }

    // ── Legacy milestones (kept until dashboard timeline migrates) ─
    await addMilestone(batchId, "request_submitted", "partnership",
                       submitted, submitted, "Partnership", submitted);
    if (actualPo) {
      const cs = isoFromOffset(scn.expectedPoOffset - 5);
      await addMilestone(batchId, "contract_signed", "partnership",
                         cs, cs, "Partnership", submitted);
      await addMilestone(batchId, "po_issued", "partnership",
                         expectedPo, actualPo, "Partnership", submitted);
      await db.insert(milestoneEvents).values({
        batchId, stage: "po_issued", eventType: "completed", actorUsername: "ops1",
      });
    }
    if (scn.closureReason === "delivered" && closed) {
      await addMilestone(batchId, "delivered", "operations",
                         promised, closed, "Operations", submitted);
      await db.insert(milestoneEvents).values({
        batchId, stage: "delivered", eventType: "completed", actorUsername: "ops1",
      });
    } else if (actualPo) {
      const dc = isoFromOffset(scn.actualPoOffset! + 1);
      if (daysBetween(todayIso(), dc) >= 0) {
        await addMilestone(batchId, "dealer_confirmation", "operations",
                           dc, dc, "Operations", submitted);
      }
    }

    // ── State label for the seed log ───────────────────────────
    const stateLabel = (() => {
      if (scn.closureReason === "delivered" && closed) {
        const d = daysBetween(closed, promised);
        return `delivered ${d >= 0 ? "+" + d : d}d vs promise`;
      }
      if (scn.closureReason === "cancelled") return "cancelled";
      if (opsExpected) {
        const d = daysBetween(opsExpected, promised);
        return d > 0 ? `Ops +${d}d behind dealer`
             : d < 0 ? `Ops ${-d}d ahead of dealer`
             : "on dealer promise";
      }
      return "pre-PO";
    })();
    const lc = lifecycleState === "pre_po" ? "[pre-PO]" : "[post-PO]";
    console.log(`  ✓ ${batchCode}  ${lc} ${scn.model} ${scn.year} (${scn.qty}×) — ${stateLabel}`
              + ` · ${actionStates.length} actions`
              + (feasibilityStatus === "at_risk" ? " · 🚩 at_risk" : ""));
  }

  console.log(`\n✅ Seed complete. ${SCENARIOS.length} batches across ${DEALERS.length} dealers.\n`);
  console.log("Demo accounts:");
  console.log("  admin / admin123 · full access");
  console.log("  ops1  / ops123   · Operations\n");
  console.log("Open http://localhost:3000/dashboard — every scenario should appear.");
  console.log("Click a row to verify its Plan-vs-Reality timeline.");
}

// ── milestones helper (legacy) ───────────────────────────────────

async function addMilestone(
  batchId: number,
  stage: string,
  track: "partnership" | "operations",
  expectedDate: string,
  actualDate: string | null,
  owner: string,
  batchSubmitted: string,
) {
  const isDelayed = !!(actualDate && expectedDate && actualDate > expectedDate);
  const delayDays = actualDate && expectedDate ? daysBetween(actualDate, expectedDate) : 0;
  const duration  = actualDate ? daysBetween(actualDate, batchSubmitted) : null;

  await db.insert(milestones).values({
    batchId,
    stage,
    confidenceTrack: track,
    expectedStart: expectedDate,
    expectedEnd:   expectedDate,
    actualStart:   actualDate ?? undefined,
    actualEnd:     actualDate ?? undefined,
    isDelayed,
    delayDays,
    durationDays: duration ?? undefined,
    owner,
  });
}

// ──────────────────────────────────────────────────────────────────
seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n❌ Seed failed:", err);
    process.exit(1);
  });
