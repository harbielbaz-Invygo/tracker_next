/**
 * Drizzle schema — mirrors `tracker_v1/data_model.py`.
 * One Batch per (PO item × delivery split). Dealers are first-class.
 * Stage codes (request_submitted → delivered) match the Python version
 * so the historical timeline logic is portable.
 */
import { sqliteTable, integer, text, real, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/** Stage codes in journey order. Mirrors data_model.py:STAGES. */
export const STAGES = [
  "request_submitted",
  "contract_signed",
  "po_issued",
  "dealer_policy_resolved",
  "color_matrix_received",
  "dummy_listed",
  "dummy_approved",
  "dealer_confirmation",
  "vin_assigned",
  "plate_assigned",
  "customs_card_received",
  "registration",
  "insurance",
  "inspection",
  "system_setup",
  "app_listing_real",
  "booking_enabled",
  "first_booking",
  "delivered",
] as const;
export type StageCode = (typeof STAGES)[number];

export const PARTNERSHIP_STAGES = new Set<StageCode>([
  "request_submitted", "contract_signed", "po_issued",
  "dealer_policy_resolved", "color_matrix_received",
  "dummy_listed", "dummy_approved",
]);

// ─────────────────────────────────────────────────────────
// Users
// ─────────────────────────────────────────────────────────
export const users = sqliteTable("users", {
  id:           integer("id").primaryKey({ autoIncrement: true }),
  username:     text("username").notNull().unique(),
  name:         text("name"),
  email:        text("email"),
  role:         text("role", { enum: ["admin", "ops"] }).notNull(),
  passwordHash: text("password_hash").notNull(),
  /**
   * Department membership — drives feature gating like "only Partnership
   * users can submit a Forecast". Nullable: admins or users created
   * before the column landed don't carry one. Cleared (not deleted)
   * when the referenced department is removed so the user row survives.
   */
  departmentId: integer("department_id"),
  createdAt:    text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
});

// ─────────────────────────────────────────────────────────
// Dealers
// ─────────────────────────────────────────────────────────
export const dealers = sqliteTable("dealers", {
  id:               integer("id").primaryKey({ autoIncrement: true }),
  name:             text("name").notNull().unique(),
  dealerType:       text("dealer_type", { enum: ["old", "new"] }).default("old"),
  homeCity:         text("home_city").notNull(),
  policyStatus:     text("policy_status",
                         { enum: ["existing", "provided", "borrowed", "pending"] })
                    .default("existing"),
  avgResponseDays:  real("avg_response_days").default(3.0),
});

// ─────────────────────────────────────────────────────────
// Batches  (one per item × split)
// ─────────────────────────────────────────────────────────
export const batches = sqliteTable("batches", {
  id:         integer("id").primaryKey({ autoIncrement: true }),
  batchCode:  text("batch_code").notNull().unique(),
  dealerId:   integer("dealer_id").notNull().references(() => dealers.id),

  model:      text("model"),
  year:       integer("year"),
  category:   text("category").default("Standard"),

  // Commercial terms (extracted from PO)
  buyBackRate:           real("buy_back_rate"),
  contractLengthMonths:  integer("contract_length_months"),
  colorSummary:          text("color_summary"),

  // Per-item pricing
  unitPriceSar:   real("unit_price_sar"),
  lineAmountSar:  real("line_amount_sar"),
  taxPct:         integer("tax_pct"),
  discountPct:    real("discount_pct"),

  // PO document-level
  poNumber:               text("po_number"),
  poReference:            text("po_reference"),
  poTotalSar:             real("po_total_sar"),
  poSubtotalSar:          real("po_subtotal_sar"),
  poTaxTotalSar:          real("po_tax_total_sar"),
  poTermsNotes:           text("po_terms_notes"),
  poEarlyTermination:     text("po_early_termination"),
  poDeliveryAddress:      text("po_delivery_address"),
  poDeliveryPhone:        text("po_delivery_phone"),
  poDeliveryAttention:    text("po_delivery_attention"),
  poDeliveryInstructions: text("po_delivery_instructions"),

  // Quantities
  requestedQuantity:   integer("requested_quantity").notNull(),
  allocatedQuantity:   integer("allocated_quantity").default(0),
  deliveredQuantity:   integer("delivered_quantity").default(0),
  /**
   * VINs actually received from the dealer, per batch. 0 = none yet
   * (default). Captured when ops marks the batch-scope "VIN" External-
   * Phase chip done — the operator types how many of the N cars in
   * the batch actually got a VIN. Caps `deliveredQuantity` at close:
   * you can't deliver more cars than the VINs you've received.
   * Partial (0 < n < requestedQuantity) is normal — dealers often
   * ship VINs in waves.
   */
  vinsReceivedQuantity: integer("vins_received_quantity").notNull().default(0),

  // Dates
  requestedAt:                text("requested_at").notNull(),                 // ISO
  dealerPromisedDeliveryDate: text("dealer_promised_delivery_date").notNull(),// ISO
  /**
   * Dealer's commitment to share the VINs. The system uses this to
   * anchor every post-VIN action's expectedDate. When the actual VIN
   * action completes, the difference (planned vs actual) propagates
   * forward — the dealer's downstream lead time is treated as fixed.
   */
  vinReceivingDate:           text("vin_receiving_date"),                     // ISO
  targetPoDate:               text("target_po_date"),
  expectedPoDate:             text("expected_po_date"),
  actualPoDate:               text("actual_po_date"),
  contractSignedAt:           text("contract_signed_at"),
  currentProjectedDeliveryDate: text("current_projected_delivery_date"),
  deliveryDateRevisionCount:  integer("delivery_date_revision_count").default(0),

  // Cities
  appDisplayCities:           text("app_display_cities"),  // CSV
  /**
   * @deprecated for multi-leg batches — see `batch_delivery_legs`.
   * Kept for back-compat / display when only one leg exists.
   * Single-leg batches still populate this; multi-leg batches set it
   * to a comma-joined hint (e.g. "Riyadh, Khobar") for fast filtering
   * but the legs table is the source of truth for per-city quantities.
   */
  dealerReceivingCity:        text("dealer_receiving_city"),
  requiresInterCityTransit:   integer("requires_inter_city_transit", { mode: "boolean" })
                              .default(false),
  dealerPolicySource:         text("dealer_policy_source"),

  // Confidence + status
  partnershipConfidence:       real("partnership_confidence").default(50),
  partnershipConfidenceAtLock: real("partnership_confidence_at_lock"),
  operationsConfidence:        real("operations_confidence").default(40),
  operationsConfidenceAtLock:  real("operations_confidence_at_lock"),

  feasibilityStatus:  text("feasibility_status",
                           { enum: ["feasible", "at_risk", "infeasible"] })
                      .default("feasible"),
  /**
   * Workflow phase. `pre_po` = exception batch captured before the PO is
   * signed (Forecast page). `post_po` = main flow, captured at Intake.
   * Pre-PO records flip to post_po when the PO arrives and Ops drops the PDF.
   */
  lifecycleState:     text("lifecycle_state", { enum: ["pre_po", "post_po"] })
                      .notNull().default("post_po"),
  /**
   * Batch closure. Null = open. Set when the Delivery action completes
   * (auto, with closureReason="delivered") or when Ops cancels the batch
   * (manual, with closureReason="cancelled" + cancellationNote).
   * `closedAt` is the canonical "Actual Availability Date" shown on the
   * Plan-vs-Reality timeline.
   */
  closedAt:           text("closed_at"),                    // ISO yyyy-mm-dd
  closureReason:      text("closure_reason",
                          { enum: ["delivered", "cancelled"] }),
  cancellationNote:   text("cancellation_note"),
  currentStage:       text("current_stage").default("request_submitted"),
  riskScore:          real("risk_score").default(0),
  delayReason:        text("delay_reason"),
  nextAction:         text("next_action"),
  responsibleOwner:   text("responsible_owner"),
  /**
   * True when ops captured the PO and the VIN at the same intake — the
   * dealer already shared VIN numbers along with the PO PDF. Skips the
   * first two steps of the VIN-chase flow (Send Dealer Confirmation
   * Email + VIN Received) since both are already satisfied. Risk model
   * also treats this batch as post_vin from day one.
   */
  vinReceivedAtIntake: integer("vin_received_at_intake", { mode: "boolean" })
                       .notNull().default(false),
  /**
   * Customer-facing milestone — the moment cars went live in the
   * customer app and pre-bookings became possible. First-class column
   * on the batch row (was: an action_type whose batch_action carried
   * the completedAt). Decoupled from action_types so admin can't
   * rename or delete it through Settings — it's a fixed concept in
   * the system, just like `closedAt`. Mutated only via
   * /api/batch-app-listing. Null = not yet listed.
   */
  appListedAt:         text("app_listed_at"),

  // ── Wave linkage (phase 1 of the scope-aware restructure) ─────
  /**
   * The wave this batch belongs to — its (PO, availability_date)
   * cohort. Nullable for backwards-compat: existing rows from before
   * the restructure are orphans (no wave); new Intake rows from
   * phase 2 onward MUST set this. The wave owns VIN-chase actions;
   * the wave's parent PO owns Internal-phase actions.
   */
  waveId:                integer("wave_id")
                           .references(() => waves.id, { onDelete: "set null" }),

  // ── Forecast linkage ───────────────────────────────────────────
  /**
   * When this batch was created as a child of a Forecast split (one
   * Forecast → multiple Intake batches), points to the parent
   * Forecast batch. Null on standard Intake batches and on Forecast
   * batches that haven't been split.
   */
  parentForecastBatchId: integer("parent_forecast_batch_id"),
  /**
   * Set when a Forecast batch has been superseded by Intake splits.
   * After this point the parent's only role is accuracy tracking —
   * its `requested_quantity` stays as the original promised total,
   * and `sum(children.requested_quantity)` shows what actually
   * fulfilled. Null on all standard batches.
   */
  forecastSupersededAt:  text("forecast_superseded_at"),

  notes:      text("notes"),
  createdAt:  text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt:  text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
}, (t) => ({
  // SQLite (and Postgres) don't auto-index FK columns. These are the
  // hottest filters in the app — Action Center sorts by lifecycle, the dashboard
  // search hits poNumber, every join goes through dealerId.
  byDealer:    index("batches_dealer_idx").on(t.dealerId),
  byPoNumber:  index("batches_po_number_idx").on(t.poNumber),
  byLifecycle: index("batches_lifecycle_idx").on(t.lifecycleState),
  byStage:     index("batches_stage_idx").on(t.currentStage),
  byWave:      index("batches_wave_idx").on(t.waveId),
}));

// ─────────────────────────────────────────────────────────
// Batch delivery legs — per-city breakdown of a batch's quantity.
//
// Replaces the single-city `batches.dealer_receiving_city` model for
// newly-grouped batches. Multiple legs under one batch mean the same
// `(po_number, model, year, availability_date, commercial_terms)` cohort
// is being delivered to different cities — typical when one PO line item
// is split across destinations.
//
// `batches.requested_quantity` is the SUM across legs (kept on the
// parent row for fast filtering). Legs are the source of truth for
// per-city quantities + per-city delivery confirmation.
//
// `batches.dealer_receiving_city` stays for back-compat / display when
// only one leg exists, but the legs table is canonical.
// ─────────────────────────────────────────────────────────
export const batchDeliveryLegs = sqliteTable("batch_delivery_legs", {
  id:                  integer("id").primaryKey({ autoIncrement: true }),
  batchId:             integer("batch_id").notNull()
                         .references(() => batches.id, { onDelete: "cascade" }),
  /** Destination city for this leg (e.g. "Riyadh"). */
  city:                text("city").notNull(),
  /** Cars to deliver to this city. */
  requestedQuantity:   integer("requested_quantity").notNull(),
  /**
   * Cars actually delivered to this city. Captured at batch close via
   * the Car Delivery modal — per-leg breakdown lets ops record partial
   * deliveries cleanly (e.g. 3/3 to Riyadh, 1/2 to Khobar).
   */
  deliveredQuantity:   integer("delivered_quantity").default(0),
  /**
   * VINs the dealer has shared for THIS city's leg of the batch. 0 by
   * default. Sum across legs equals the batch-level VINs received.
   * Caps the per-leg delivered quantity at close — you can't deliver
   * more cars to a city than the VINs assigned to it.
   */
  vinsReceivedQuantity: integer("vins_received_quantity").notNull().default(0),
  /** Optional per-leg note (transit problems, address issues, etc.). */
  notes:               text("notes"),
  createdAt:           text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
}, (t) => ({
  byBatch: index("batch_delivery_legs_batch_idx").on(t.batchId),
}));

// ─────────────────────────────────────────────────────────
// Batch color matrix
// ─────────────────────────────────────────────────────────
export const batchColorMatrix = sqliteTable("batch_color_matrix", {
  id:                 integer("id").primaryKey({ autoIncrement: true }),
  batchId:            integer("batch_id").notNull().references(() => batches.id, { onDelete: "cascade" }),
  color:              text("color").notNull(),
  requestedQuantity:  integer("requested_quantity").notNull(),
  confirmedQuantity:  integer("confirmed_quantity").default(0),
  deliveredQuantity:  integer("delivered_quantity").default(0),
}, (t) => ({
  byBatch: index("batch_color_matrix_batch_idx").on(t.batchId),
}));

// ─────────────────────────────────────────────────────────
// Batch date revisions — one row per shift event of the projected
// availability date. Replaces the `deliveryDateRevisionCount` counter
// on `batches` with a per-event history so we can compute customer
// impact precisely (bookings_at_shift × delay_added_by_shift). Each
// shift also captures WHY it happened (reason text) and WHO applied it.
// ─────────────────────────────────────────────────────────
export const batchDateRevisions = sqliteTable("batch_date_revisions", {
  id:                     integer("id").primaryKey({ autoIncrement: true }),
  batchId:                integer("batch_id").notNull()
                            .references(() => batches.id, { onDelete: "cascade" }),
  /** ISO datetime when ops applied the shift. */
  revisedAt:              text("revised_at").default(sql`(CURRENT_TIMESTAMP)`),
  /** Username of the ops/admin who applied the shift (audit trail). */
  revisedBy:              text("revised_by"),
  /** The projected date BEFORE this shift (ISO yyyy-mm-dd). */
  previousProjectedDate:  text("previous_projected_date").notNull(),
  /** The projected date AFTER this shift (ISO yyyy-mm-dd). */
  newProjectedDate:       text("new_projected_date").notNull(),
  /** newProjectedDate - previousProjectedDate (days, signed; usually positive). */
  delayDays:              integer("delay_days").notNull(),
  /**
   * Number of customer bookings against this batch at the moment of
   * the shift. Manually entered by ops. Drives the customer-impact
   * metric: customer-days lost = bookings × delayDays per shift event.
   * 0 when the shift happens before "App Listing" (no bookings yet).
   */
  bookingsAtShift:        integer("bookings_at_shift").notNull().default(0),
  /** Optional free-text reason captured at the shift moment. */
  reason:                 text("reason"),
}, (t) => ({
  byBatch:     index("batch_date_revisions_batch_idx").on(t.batchId),
  byRevisedAt: index("batch_date_revisions_revised_at_idx").on(t.revisedAt),
}));

// ─────────────────────────────────────────────────────────
// Batch forecasts — Partnership-submitted, pre-PO bets.
//
// 1:1 with a `batches` row whose `lifecycleState = 'pre_po'`. The
// batch carries the Forecast's Qty / City / Expected Delivery Date;
// this table carries the partnership-specific metadata that doesn't
// belong on the batch itself: submission date and submitter.
//
// When a real PO arrives and Ops links it via Intake, the batch
// flips to `post_po` and gains all the standard fields. The
// `batch_forecasts` row stays attached to the same record so
// accuracy metrics (submission → PO drift, listing accuracy, qty
// shortfall) remain computable.
//
// Splits (one Forecast → multiple fulfilling batches) work via
// `batches.parent_forecast_batch_id` on the children + the parent's
// `forecast_superseded_at` marker. The Forecast row on the parent
// remains the authoritative submission record.
// ─────────────────────────────────────────────────────────
export const batchForecasts = sqliteTable("batch_forecasts", {
  id:                  integer("id").primaryKey({ autoIncrement: true }),
  /** The pre_po batch this Forecast lives on. 1:1 — only one Forecast per batch. */
  batchId:             integer("batch_id").notNull().unique()
                         .references(() => batches.id, { onDelete: "cascade" }),
  /**
   * ISO date the Partnership team committed to this bet. Used as the
   * anchor for "Partnership submission → actual PO" drift metric.
   */
  submittedAt:         text("submitted_at").notNull(),
  /**
   * Partnership user (from `users`) who made the commitment. Drives
   * the per-submitter Forecast reliability breakdown on Insights.
   * Source = submitter; we don't track a separate "source partner"
   * dimension at the moment.
   */
  submittedByUserId:   integer("submitted_by_user_id").notNull()
                         .references(() => users.id),
  createdAt:           text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt:           text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
}, (t) => ({
  byBatch:            index("batch_forecasts_batch_idx").on(t.batchId),
  bySubmittedBy:      index("batch_forecasts_submitted_by_idx").on(t.submittedByUserId),
  bySubmittedAt:      index("batch_forecasts_submitted_at_idx").on(t.submittedAt),
}));

// ─────────────────────────────────────────────────────────
// Vehicles  (individual cars within a batch)
// ─────────────────────────────────────────────────────────
export const vehicles = sqliteTable("vehicles", {
  id:               integer("id").primaryKey({ autoIncrement: true }),
  batchId:          integer("batch_id").notNull().references(() => batches.id, { onDelete: "cascade" }),
  vehicleCode:      text("vehicle_code").notNull().unique(),
  color:            text("color"),
  vin:              text("vin"),
  plateNumber:      text("plate_number"),
  customsCardNumber:text("customs_card_number"),
  currentStage:     text("current_stage").default("request_submitted"),
  estimatedAvailabilityDate: text("estimated_availability_date"),
  confidenceScore:  real("confidence_score").default(40),
  riskScore:        real("risk_score").default(0),
  dummyListedAt:    text("dummy_listed_at"),
  dummyApprovedAt:  text("dummy_approved_at"),
  convertedToRealAt:text("converted_to_real_at"),
  deliveredAt:      text("delivered_at"),
  delayReason:      text("delay_reason"),
  nextAction:       text("next_action"),
}, (t) => ({
  byBatch: index("vehicles_batch_idx").on(t.batchId),
}));

// ─────────────────────────────────────────────────────────
// Milestones + events
// ─────────────────────────────────────────────────────────
export const milestones = sqliteTable("milestones", {
  id:               integer("id").primaryKey({ autoIncrement: true }),
  batchId:          integer("batch_id").notNull().references(() => batches.id, { onDelete: "cascade" }),
  vehicleId:        integer("vehicle_id").references(() => vehicles.id),
  stage:            text("stage").notNull(),
  confidenceTrack:  text("confidence_track", { enum: ["partnership", "operations"] }).notNull(),
  expectedStart:    text("expected_start"),
  actualStart:      text("actual_start"),
  expectedEnd:      text("expected_end"),
  actualEnd:        text("actual_end"),
  durationDays:     real("duration_days"),
  isDelayed:        integer("is_delayed", { mode: "boolean" }).default(false),
  delayDays:        real("delay_days").default(0),
  owner:            text("owner"),
  notes:            text("notes"),
}, (t) => ({
  byBatch: index("milestones_batch_idx").on(t.batchId),
  byStage: index("milestones_stage_idx").on(t.stage),
}));

export const milestoneEvents = sqliteTable("milestone_events", {
  id:             integer("id").primaryKey({ autoIncrement: true }),
  batchId:        integer("batch_id").notNull().references(() => batches.id, { onDelete: "cascade" }),
  vehicleId:      integer("vehicle_id").references(() => vehicles.id),
  stage:          text("stage").notNull(),
  eventType:      text("event_type").notNull(),
  occurredAt:     text("occurred_at").default(sql`(CURRENT_TIMESTAMP)`),
  actorUsername:  text("actor_username"),
  note:           text("note"),
}, (t) => ({
  byBatch: index("milestone_events_batch_idx").on(t.batchId),
}));

// ─────────────────────────────────────────────────────────
// Alerts
// ─────────────────────────────────────────────────────────
export const alerts = sqliteTable("alerts", {
  id:             integer("id").primaryKey({ autoIncrement: true }),
  batchId:        integer("batch_id").references(() => batches.id),
  vehicleId:      integer("vehicle_id").references(() => vehicles.id),
  fingerprint:    text("fingerprint").notNull(),
  severity:       text("severity", { enum: ["critical", "high", "medium", "info"] }).notNull(),
  alertType:      text("alert_type").notNull(),
  message:        text("message").notNull(),
  audience:       text("audience"),
  raisedAt:       text("raised_at").default(sql`(CURRENT_TIMESTAMP)`),
  acknowledged:   integer("acknowledged", { mode: "boolean" }).default(false),
  acknowledgedBy: text("acknowledged_by"),
  acknowledgedAt: text("acknowledged_at"),
  resolved:       integer("resolved", { mode: "boolean" }).default(false),
  resolvedAt:     text("resolved_at"),
}, (t) => ({
  byBatch:       index("alerts_batch_idx").on(t.batchId),
  byFingerprint: index("alerts_fingerprint_idx").on(t.fingerprint),
}));

// ─────────────────────────────────────────────────────────
// Alert rules — admin-configured thresholds for the alert engine.
// Each rule defines when an alert should fire on an open batch.
// The engine runs on every Action Center page load, creates new alerts
// (fingerprint-deduped) and auto-resolves ones whose condition cleared.
// ─────────────────────────────────────────────────────────
export const alertRules = sqliteTable("alert_rules", {
  id:            integer("id").primaryKey({ autoIncrement: true }),
  name:          text("name").notNull(),
  /**
   * Trigger logic:
   *  no_vin_before_avail         — VIN action not done, ≤ thresholdDays to availability date
   *  action_overdue              — any waiting/blocked action is past its expectedDate
   *  action_pending_before_avail — a specific actionTypeId not done, ≤ thresholdDays to availability date
   *  listing_overdue             — post_po batch submitted ≥ thresholdDays ago AND not yet
   *                                app-listed. Surfaces stalled Internal Phase work — the
   *                                primary "PO → Listed" KPI alert.
   */
  triggerType:   text("trigger_type", {
                   enum: [
                     "no_vin_before_avail",
                     "action_overdue",
                     "action_pending_before_avail",
                     "listing_overdue",
                   ],
                 }).notNull(),
  /** Days before availability date (or days overdue) at which to fire. */
  thresholdDays: integer("threshold_days").notNull().default(7),
  /** Only for action_pending_before_avail — which action type must be done. */
  actionTypeId:  integer("action_type_id").references(() => actionTypes.id, { onDelete: "set null" }),
  severity:      text("severity", { enum: ["critical", "high", "medium", "info"] })
                   .notNull().default("high"),
  isActive:      integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt:     text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
});

// ─────────────────────────────────────────────────────────
// Settings — single-row key/value (mirrors user_settings.json)
// ─────────────────────────────────────────────────────────
export const settings = sqliteTable("settings", {
  key:   text("key").primaryKey(),
  value: text("value").notNull(),
});

// ─────────────────────────────────────────────────────────
// Departments — admin-configured stakeholder groups
// (e.g. Specs / Pricing / Operations / Logistics / Partnership).
// Replaces the per-person stakeholder model from tracker_v1.
// ─────────────────────────────────────────────────────────
export const departments = sqliteTable("departments", {
  id:        integer("id").primaryKey({ autoIncrement: true }),
  name:      text("name").notNull().unique(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
});

// ─────────────────────────────────────────────────────────
// Stakeholders — named individuals (or sub-teams) within a department.
// Each department has zero or more stakeholders. At Intake the operator
// picks which stakeholder owns the actions assigned to that department.
// ─────────────────────────────────────────────────────────
export const stakeholders = sqliteTable("stakeholders", {
  id:           integer("id").primaryKey({ autoIncrement: true }),
  departmentId: integer("department_id").notNull()
                  .references(() => departments.id, { onDelete: "cascade" }),
  name:         text("name").notNull(),
  sortOrder:    integer("sort_order").notNull().default(0),
  createdAt:    text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
}, (t) => ({
  byDept: index("stakeholders_dept_idx").on(t.departmentId),
}));

// ─────────────────────────────────────────────────────────
// Action types — admin-configured master catalog of work items.
// Each batch picks a subset of these on Intake. Examples:
//   "VIN"     → "Waiting VIN"     → "VIN Assigned"
//   "Plate"   → "Waiting Plate"   → "Plate Assigned"
//   "Pricing" → "Waiting Pricing" → "Pricing Received"
// ─────────────────────────────────────────────────────────
export const actionTypes = sqliteTable("action_types", {
  id:                  integer("id").primaryKey({ autoIncrement: true }),
  name:                text("name").notNull().unique(),     // canonical key
  waitingLabel:        text("waiting_label").notNull(),     // shown while open
  doneLabel:           text("done_label").notNull(),        // shown when complete
  defaultDepartmentId: integer("default_department_id")
                         .references(() => departments.id, { onDelete: "set null" }),
  /**
   * Default expected-date offset for actions of this type.
   *   offsetDays  = whole-day offset (e.g. 3, 5, 21)
   *   offsetAnchor:
   *     - "submission" = batch submitted date + offsetDays
   *     - "vin"        = vinReceivingDate + offsetDays  (post-VIN actions)
   *     - "promised"   = dealerPromisedDeliveryDate (offsetDays ignored;
   *                      used only by the canonical Delivery action)
   *
   * The Settings page lets admin tune these per action type. Used at
   * Intake to pre-populate batch_actions.expectedDate, and in the
   * auto-shift logic when an upstream action slips.
   */
  offsetDays:          integer("offset_days").notNull().default(0),
  offsetAnchor:        text("offset_anchor",
                            { enum: ["submission", "vin", "promised"] })
                       .notNull().default("submission"),
  /**
   * Which entity carries the state for this action_type:
   *   - "po"    → one action per PO (Specs / Pricing / SKU / App Listing)
   *   - "wave"  → one action per (PO, availability_date) cohort
   *               (VIN / Plate / Customs / Tracking / Inspection / Ready)
   *   - "batch" → one action per batch (Delivery, Pre-PO App Listing)
   * Drives both Intake-time action creation and the Action Center
   * drawer's three sections (PO / Wave / Batch). Default "batch" keeps
   * legacy behaviour for any row added before this column existed.
   */
  scope:               text("scope", { enum: ["po", "wave", "batch"] })
                       .notNull().default("batch"),
  sortOrder:           integer("sort_order").notNull().default(0),
  createdAt:           text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
});

// ─────────────────────────────────────────────────────────
// Action dependencies — DAG. `actionTypeId` cannot start until
// `dependsOnActionTypeId` is `done`. Many-to-many.
// Cycle prevention is enforced in application code (Settings editor).
// ─────────────────────────────────────────────────────────
export const actionDependencies = sqliteTable("action_dependencies", {
  id:                    integer("id").primaryKey({ autoIncrement: true }),
  actionTypeId:          integer("action_type_id").notNull()
                           .references(() => actionTypes.id, { onDelete: "cascade" }),
  dependsOnActionTypeId: integer("depends_on_action_type_id").notNull()
                           .references(() => actionTypes.id, { onDelete: "cascade" }),
}, (t) => ({
  uniq: uniqueIndex("action_dep_uniq").on(t.actionTypeId, t.dependsOnActionTypeId),
}));

// ─────────────────────────────────────────────────────────
// Batch actions — per-batch instances of action types.
// Created on Intake; statuses updated on the Ops Action Center.
// ─────────────────────────────────────────────────────────
export const batchActions = sqliteTable("batch_actions", {
  id:           integer("id").primaryKey({ autoIncrement: true }),
  batchId:      integer("batch_id").notNull()
                  .references(() => batches.id, { onDelete: "cascade" }),
  actionTypeId: integer("action_type_id").notNull()
                  .references(() => actionTypes.id, { onDelete: "restrict" }),
  /** Department assigned to do this work — overrides actionTypes.defaultDepartmentId. */
  departmentId: integer("department_id")
                  .references(() => departments.id, { onDelete: "set null" }),
  /** Specific stakeholder (within the assigned department) responsible for this action. */
  assignedStakeholderId: integer("assigned_stakeholder_id")
                  .references(() => stakeholders.id, { onDelete: "set null" }),
  status:       text("status",
                     { enum: ["waiting", "blocked", "done", "skipped"] })
                  .notNull().default("waiting"),
  /**
   * Planned date this action should complete. Computed at Intake from
   * action_types.offsetDays + offsetAnchor + batch dates. Auto-recomputed
   * when an upstream action slips (e.g. VIN late → all post-VIN actions
   * push back). Editable in the Action Center when Ops gets new info.
   */
  expectedDate: text("expected_date"),                       // ISO yyyy-mm-dd
  /** ISO datetime — set when status flips to `done`. Drives the dashboard timeline. */
  completedAt:  text("completed_at"),
  notes:        text("notes"),
  createdAt:    text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt:    text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
}, (t) => ({
  uniq: uniqueIndex("batch_action_uniq").on(t.batchId, t.actionTypeId),
  // Hot-path indexes:
  //  - byBatch: every drawer fetch + Action Center row aggregation queries by batchId.
  //  - byActionType: cascade in /api/batch-action looks up by actionTypeId.
  //  - byStatus: the Action Center's "actions waiting/blocked" counts filter on status.
  byBatch:       index("batch_actions_batch_idx").on(t.batchId),
  byActionType:  index("batch_actions_action_type_idx").on(t.actionTypeId),
  byStatus:      index("batch_actions_status_idx").on(t.status),
  byStakeholder: index("batch_actions_stakeholder_idx").on(t.assignedStakeholderId),
}));

// ─────────────────────────────────────────────────────────
// VIN chase stages — a first-class, canonical chain that lives
// independently from `action_types`. Originally we routed action_types
// into a "VIN chase" cluster by substring matching their names
// (vin / plate / customs / …) which was brittle: admins could rename a
// row and silently break the chain, and the dependency / alert graph
// got entangled with what should be a fixed linear workflow.
//
// Each row is one canonical step (e.g. "VIN", "Plate", "Customs").
// Per-batch state lives in `batch_vin_stages`. Admins reorder + rename
// + add stages from Settings; the drawer renders from this table
// instead of filtering action_types.
// ─────────────────────────────────────────────────────────
export const vinChaseStages = sqliteTable("vin_chase_stages", {
  id:           integer("id").primaryKey({ autoIncrement: true }),
  /** Canonical key — unique. Used in code if a stage needs special-casing. */
  name:         text("name").notNull().unique(),
  /** Label shown while the stage is waiting (e.g. "Awaiting VIN from dealer"). */
  waitingLabel: text("waiting_label").notNull(),
  /** Label shown when the stage is done (e.g. "VIN received"). */
  doneLabel:    text("done_label").notNull(),
  /** Drag-orderable in Settings. Drives stepper render order. */
  sortOrder:    integer("sort_order").notNull().default(0),
  createdAt:    text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
});

// ─────────────────────────────────────────────────────────
// Per-batch VIN chase state. One row per (batchId × stageId).
// Created at Intake (all stages × the new batch) + backfilled for
// pre-existing batches by the migration script. Status flips via
// /api/vin-stage. No dependency DAG — the chain is strictly linear and
// the drawer derives "current" from the first non-done stage.
// ─────────────────────────────────────────────────────────
export const batchVinStages = sqliteTable("batch_vin_stages", {
  id:           integer("id").primaryKey({ autoIncrement: true }),
  batchId:      integer("batch_id").notNull()
                  .references(() => batches.id, { onDelete: "cascade" }),
  stageId:      integer("stage_id").notNull()
                  .references(() => vinChaseStages.id, { onDelete: "cascade" }),
  status:       text("status", { enum: ["waiting", "done", "skipped"] })
                  .notNull().default("waiting"),
  /** ISO datetime — set when status flips to `done`. Powers reports. */
  completedAt:  text("completed_at"),
  notes:        text("notes"),
  createdAt:    text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt:    text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
}, (t) => ({
  uniq:    uniqueIndex("batch_vin_stage_uniq").on(t.batchId, t.stageId),
  byBatch: index("batch_vin_stages_batch_idx").on(t.batchId),
  byStatus:index("batch_vin_stages_status_idx").on(t.status),
}));

// ─────────────────────────────────────────────────────────
// PO — one row per po_number. Header data the whole PO shares.
//
// Phase 1 of the scope-aware restructure. Sits alongside the
// existing `batches` table; lookups still go through batches for
// now. Phase 2 onward wires Intake + Action Center to read/write
// here. Phase 5 drops the duplicated header columns from batches.
// ─────────────────────────────────────────────────────────
export const pos = sqliteTable("pos", {
  id:                          integer("id").primaryKey({ autoIncrement: true }),
  poNumber:                    text("po_number").notNull().unique(),
  dealerId:                    integer("dealer_id").notNull()
                                 .references(() => dealers.id),
  poDate:                      text("po_date"),
  poReference:                 text("po_reference"),
  poTermsNotes:                text("po_terms_notes"),
  /* Commercial terms — PO-wide, same for every batch under it. */
  buyBackRate:                 real("buy_back_rate"),
  contractLengthMonths:        integer("contract_length_months"),
  unitPriceSar:                real("unit_price_sar"),
  taxPct:                      integer("tax_pct"),
  /* Confidence — PO scope per Q-Intake-5. */
  partnershipConfidence:       real("partnership_confidence").default(50),
  partnershipConfidenceAtLock: real("partnership_confidence_at_lock"),
  operationsConfidence:        real("operations_confidence").default(40),
  operationsConfidenceAtLock:  real("operations_confidence_at_lock"),
  notes:                       text("notes"),
  /* Closure — set when every wave + batch under this PO is closed. */
  closedAt:                    text("closed_at"),
  createdAt:                   text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt:                   text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
}, (t) => ({
  byDealer:    index("pos_dealer_idx").on(t.dealerId),
  byPoDate:    index("pos_po_date_idx").on(t.poDate),
  byClosed:    index("pos_closed_at_idx").on(t.closedAt),
}));

// ─────────────────────────────────────────────────────────
// Wave — one row per (PO, availability_date). VIN-chase actions
// scope here; batches sharing a wave share the VIN handoff.
// ─────────────────────────────────────────────────────────
export const waves = sqliteTable("waves", {
  id:                  integer("id").primaryKey({ autoIncrement: true }),
  poId:                integer("po_id").notNull()
                         .references(() => pos.id, { onDelete: "cascade" }),
  availabilityDate:    text("availability_date").notNull(),    // ISO yyyy-mm-dd
  vinReceivingDate:    text("vin_receiving_date"),
  opsExpectedDate:     text("ops_expected_date"),
  vinReceivedAtIntake: integer("vin_received_at_intake", { mode: "boolean" })
                         .notNull().default(false),
  /* Closure — set when every batch + wave action is closed. */
  closedAt:            text("closed_at"),
  createdAt:           text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt:           text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
}, (t) => ({
  byPo:                index("waves_po_idx").on(t.poId),
  byAvailability:      index("waves_availability_idx").on(t.availabilityDate),
  uniqPoAvailability:  uniqueIndex("waves_po_availability_uniq")
                         .on(t.poId, t.availabilityDate),
}));

// ─────────────────────────────────────────────────────────
// Scoped actions — generic action_status table keyed by
// (scope, scope_id, action_type_id). Replaces batch_actions and
// batch_vin_stages once phases 2-5 land. For now both tables
// coexist; the legacy ones stay until Phase 5 drops them.
//
// One row per action instance. Uniqueness on
// (scope, scope_id, action_type_id) — you can't have two "Pricing"
// actions on the same PO.
// ─────────────────────────────────────────────────────────
export const actions = sqliteTable("actions", {
  id:                    integer("id").primaryKey({ autoIncrement: true }),
  scope:                 text("scope", { enum: ["po", "wave", "batch"] }).notNull(),
  /**
   * FK target depends on `scope` — pos.id, waves.id, or batches.id.
   * Drizzle can't model polymorphic FKs, so this is an integer with
   * the join handled in application code.
   */
  scopeId:               integer("scope_id").notNull(),
  actionTypeId:          integer("action_type_id").notNull()
                           .references(() => actionTypes.id, { onDelete: "restrict" }),
  departmentId:          integer("department_id")
                           .references(() => departments.id, { onDelete: "set null" }),
  assignedStakeholderId: integer("assigned_stakeholder_id")
                           .references(() => stakeholders.id, { onDelete: "set null" }),
  status:                text("status",
                              { enum: ["waiting", "blocked", "done", "skipped"] })
                         .notNull().default("waiting"),
  expectedDate:          text("expected_date"),
  completedAt:           text("completed_at"),
  notes:                 text("notes"),
  createdAt:             text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt:             text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
}, (t) => ({
  byScope:    index("actions_scope_idx").on(t.scope, t.scopeId),
  byType:     index("actions_action_type_idx").on(t.actionTypeId),
  byStakeholder: index("actions_stakeholder_idx").on(t.assignedStakeholderId),
  byStatus:   index("actions_status_idx").on(t.status),
  uniq:       uniqueIndex("actions_scope_type_uniq")
                .on(t.scope, t.scopeId, t.actionTypeId),
}));

// Convenient TS types
export type User              = typeof users.$inferSelect;
export type Dealer            = typeof dealers.$inferSelect;
export type Batch             = typeof batches.$inferSelect;
export type Vehicle           = typeof vehicles.$inferSelect;
export type Milestone         = typeof milestones.$inferSelect;
export type Alert             = typeof alerts.$inferSelect;
export type AlertRule         = typeof alertRules.$inferSelect;
export type Department        = typeof departments.$inferSelect;
export type Stakeholder       = typeof stakeholders.$inferSelect;
export type ActionType        = typeof actionTypes.$inferSelect;
export type ActionDependency  = typeof actionDependencies.$inferSelect;
export type BatchAction       = typeof batchActions.$inferSelect;
export type BatchDateRevision = typeof batchDateRevisions.$inferSelect;
export type BatchDeliveryLeg  = typeof batchDeliveryLegs.$inferSelect;
export type VinChaseStage     = typeof vinChaseStages.$inferSelect;
export type BatchVinStage     = typeof batchVinStages.$inferSelect;
