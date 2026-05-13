-- ════════════════════════════════════════════════════════════════════════════
-- TEST DATA — exercises every scenario added in Items 1-4
--
-- 12 batches under dealer "test" covering:
--   • Alert engine — VIN-before-avail (high & critical), action_overdue
--   • Pre-VIN / Post-VIN phase chip + days-to-availability colour escalation
--   • High-risk pre-VIN metric (pre-VIN ≤ 14d to availability)
--   • Customer impact — mild / moderate / severe severity tiers
--   • Customer impact — delivered_late vs projected_late states
--   • Customer impact — re-promise count surfaced per batch
--   • Dealer reliability — date / qty / colour / cancellation dimensions
--
-- Re-runnable: cleanup at the top wipes prior test data, so you can iterate.
-- All rows live under dealer "test" — drop them all with the cleanup block.
--
-- Today (assumed): 2026-05-12. Dates are anchored to this — re-run the
-- script with shifted dates if today drifts far from this.
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────
-- 0. CLEANUP — delete prior test data in FK-safe order
-- ────────────────────────────────────────────────────────────────────────
DELETE FROM alerts
 WHERE batch_id IN (SELECT id FROM batches WHERE dealer_id IN (SELECT id FROM dealers WHERE name='test'));
DELETE FROM batch_actions
 WHERE batch_id IN (SELECT id FROM batches WHERE dealer_id IN (SELECT id FROM dealers WHERE name='test'));
DELETE FROM batch_color_matrix
 WHERE batch_id IN (SELECT id FROM batches WHERE dealer_id IN (SELECT id FROM dealers WHERE name='test'));
DELETE FROM vehicles
 WHERE batch_id IN (SELECT id FROM batches WHERE dealer_id IN (SELECT id FROM dealers WHERE name='test'));
DELETE FROM milestones
 WHERE batch_id IN (SELECT id FROM batches WHERE dealer_id IN (SELECT id FROM dealers WHERE name='test'));
DELETE FROM milestone_events
 WHERE batch_id IN (SELECT id FROM batches WHERE dealer_id IN (SELECT id FROM dealers WHERE name='test'));
DELETE FROM batches
 WHERE dealer_id IN (SELECT id FROM dealers WHERE name='test');

-- ────────────────────────────────────────────────────────────────────────
-- 1. TEST DEALER  (idempotent)
-- ────────────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO dealers (name, dealer_type, home_city, policy_status, avg_response_days)
VALUES ('test', 'new', 'Riyadh', 'existing', 2.5);

-- ────────────────────────────────────────────────────────────────────────
-- 2. DEFAULT ALERT RULES (idempotent — skipped if same name already exists)
--    With these in place, the alert engine fires immediately on relevant
--    test batches.
-- ────────────────────────────────────────────────────────────────────────
INSERT INTO alert_rules (name, trigger_type, threshold_days, severity, is_active)
SELECT 'VIN approaching', 'no_vin_before_avail', 7, 'high', 1
 WHERE NOT EXISTS (SELECT 1 FROM alert_rules WHERE name='VIN approaching');
INSERT INTO alert_rules (name, trigger_type, threshold_days, severity, is_active)
SELECT 'VIN critical', 'no_vin_before_avail', 3, 'critical', 1
 WHERE NOT EXISTS (SELECT 1 FROM alert_rules WHERE name='VIN critical');
INSERT INTO alert_rules (name, trigger_type, threshold_days, severity, is_active)
SELECT 'Action overdue', 'action_overdue', 0, 'medium', 1
 WHERE NOT EXISTS (SELECT 1 FROM alert_rules WHERE name='Action overdue');

-- ────────────────────────────────────────────────────────────────────────
-- 3. BATCHES — twelve scenarios
-- ────────────────────────────────────────────────────────────────────────

-- TEST-001 — Healthy pre-VIN, 60d to avail. Low risk, no alerts.
INSERT INTO batches (
  batch_code, dealer_id, model, year, requested_quantity,
  requested_at, dealer_promised_delivery_date,
  current_stage, lifecycle_state, feasibility_status,
  partnership_confidence, operations_confidence,
  color_summary, app_display_cities, dealer_receiving_city,
  po_number, actual_po_date, notes
) VALUES (
  'TEST-001', (SELECT id FROM dealers WHERE name='test'), 'Sonata', 2026, 2,
  '2026-04-01', '2026-07-12',
  'po_issued', 'post_po', 'feasible',
  80, 75,
  'Black, White', 'Riyadh', 'Riyadh',
  'TEST-PO-001', '2026-04-05', 'Healthy pre-VIN — 60d runway'
);

-- TEST-002 — Pre-VIN, ≤7d to avail → fires "VIN approaching" (high).
INSERT INTO batches (
  batch_code, dealer_id, model, year, requested_quantity,
  requested_at, dealer_promised_delivery_date,
  current_stage, lifecycle_state, feasibility_status,
  partnership_confidence, operations_confidence,
  color_summary, app_display_cities, dealer_receiving_city,
  po_number, actual_po_date, notes
) VALUES (
  'TEST-002', (SELECT id FROM dealers WHERE name='test'), 'Tucson', 2026, 3,
  '2026-04-15', '2026-05-17',
  'po_issued', 'post_po', 'feasible',
  70, 50,
  'Silver, Gray', 'Riyadh, Jeddah', 'Riyadh',
  'TEST-PO-002', '2026-04-18', 'Pre-VIN 5d to avail — high alert'
);

-- TEST-003 — Pre-VIN, ≤3d to avail → fires "VIN critical" (critical).
INSERT INTO batches (
  batch_code, dealer_id, model, year, requested_quantity,
  requested_at, dealer_promised_delivery_date,
  current_stage, lifecycle_state, feasibility_status,
  partnership_confidence, operations_confidence,
  color_summary, app_display_cities, dealer_receiving_city,
  po_number, actual_po_date, notes
) VALUES (
  'TEST-003', (SELECT id FROM dealers WHERE name='test'), 'Elantra', 2026, 1,
  '2026-04-20', '2026-05-14',
  'po_issued', 'post_po', 'at_risk',
  50, 30,
  'Red', 'Dammam', 'Dammam',
  'TEST-PO-003', '2026-04-22', 'Pre-VIN 2d to avail — critical alert'
);

-- TEST-004 — Post-VIN execution zone (VIN action done below).
INSERT INTO batches (
  batch_code, dealer_id, model, year, requested_quantity,
  requested_at, dealer_promised_delivery_date,
  current_stage, lifecycle_state, feasibility_status,
  partnership_confidence, operations_confidence,
  color_summary, app_display_cities, dealer_receiving_city,
  po_number, actual_po_date, vin_receiving_date, notes
) VALUES (
  'TEST-004', (SELECT id FROM dealers WHERE name='test'), 'Kona', 2026, 2,
  '2026-03-15', '2026-06-11',
  'vin_assigned', 'post_po', 'feasible',
  85, 80,
  'Blue', 'Riyadh', 'Riyadh',
  'TEST-PO-004', '2026-03-20', '2026-05-01', 'Post-VIN — VIN received'
);

-- TEST-005 — Delivered 5d late (mild customer impact: 3 × 5 = 15 cust-days).
INSERT INTO batches (
  batch_code, dealer_id, model, year, requested_quantity,
  requested_at, dealer_promised_delivery_date,
  current_stage, lifecycle_state, feasibility_status,
  partnership_confidence, operations_confidence,
  color_summary, app_display_cities, dealer_receiving_city,
  po_number, actual_po_date, vin_receiving_date,
  closed_at, closure_reason, delivered_quantity, notes
) VALUES (
  'TEST-005', (SELECT id FROM dealers WHERE name='test'), 'Sonata', 2026, 3,
  '2026-03-01', '2026-04-12',
  'delivered', 'post_po', 'feasible',
  90, 85,
  'Black', 'Riyadh', 'Riyadh',
  'TEST-PO-005', '2026-03-05', '2026-03-25',
  '2026-04-17', 'delivered', 3, 'Delivered 5d late — mild'
);

-- TEST-006 — Delivered 15d late (moderate: 5 × 15 = 75 cust-days).
INSERT INTO batches (
  batch_code, dealer_id, model, year, requested_quantity,
  requested_at, dealer_promised_delivery_date,
  current_stage, lifecycle_state, feasibility_status,
  partnership_confidence, operations_confidence,
  color_summary, app_display_cities, dealer_receiving_city,
  po_number, actual_po_date, vin_receiving_date,
  closed_at, closure_reason, delivered_quantity, notes
) VALUES (
  'TEST-006', (SELECT id FROM dealers WHERE name='test'), 'Tucson', 2026, 5,
  '2026-02-15', '2026-04-12',
  'delivered', 'post_po', 'feasible',
  75, 65,
  'White, Black', 'Jeddah', 'Jeddah',
  'TEST-PO-006', '2026-02-20', '2026-03-10',
  '2026-04-27', 'delivered', 5, 'Delivered 15d late — moderate'
);

-- TEST-007 — Delivered 30d late (SEVERE: 10 × 30 = 300 cust-days).
INSERT INTO batches (
  batch_code, dealer_id, model, year, requested_quantity,
  requested_at, dealer_promised_delivery_date,
  current_stage, lifecycle_state, feasibility_status,
  partnership_confidence, operations_confidence,
  color_summary, app_display_cities, dealer_receiving_city,
  po_number, actual_po_date, vin_receiving_date,
  closed_at, closure_reason, delivered_quantity,
  delivery_date_revision_count, notes
) VALUES (
  'TEST-007', (SELECT id FROM dealers WHERE name='test'), 'Sonata', 2026, 10,
  '2026-01-20', '2026-04-01',
  'delivered', 'post_po', 'feasible',
  55, 45,
  'Various', 'Riyadh, Jeddah', 'Riyadh',
  'TEST-PO-007', '2026-01-25', '2026-02-15',
  '2026-05-01', 'delivered', 10,
  2, 'Delivered 30d late — severe, 2 re-promises'
);

-- TEST-008 — Open, projected 16d late (moderate: 4 × 16 = 64 cust-days).
INSERT INTO batches (
  batch_code, dealer_id, model, year, requested_quantity,
  requested_at, dealer_promised_delivery_date, current_projected_delivery_date,
  current_stage, lifecycle_state, feasibility_status,
  partnership_confidence, operations_confidence,
  color_summary, app_display_cities, dealer_receiving_city,
  po_number, actual_po_date, vin_receiving_date,
  delivery_date_revision_count, notes
) VALUES (
  'TEST-008', (SELECT id FROM dealers WHERE name='test'), 'Kona', 2026, 4,
  '2026-03-20', '2026-05-20', '2026-06-05',
  'vin_assigned', 'post_po', 'at_risk',
  60, 40,
  'Black', 'Riyadh', 'Riyadh',
  'TEST-PO-008', '2026-03-25', '2026-04-30',
  1, 'Open, projected 16d late — moderate'
);

-- TEST-009 — Cancelled batch (counts against cancellation rate).
INSERT INTO batches (
  batch_code, dealer_id, model, year, requested_quantity,
  requested_at, dealer_promised_delivery_date,
  current_stage, lifecycle_state, feasibility_status,
  partnership_confidence, operations_confidence,
  color_summary, app_display_cities, dealer_receiving_city,
  po_number, actual_po_date,
  closed_at, closure_reason, cancellation_note, notes
) VALUES (
  'TEST-009', (SELECT id FROM dealers WHERE name='test'), 'Elantra', 2026, 5,
  '2026-03-15', '2026-05-15',
  'request_submitted', 'post_po', 'infeasible',
  20, 15,
  'Black', 'Riyadh', 'Riyadh',
  'TEST-PO-009', '2026-03-20',
  '2026-04-10', 'cancelled',
  'Dealer pulled out — colour matrix mismatch',
  'Cancelled — counts in cancellation rate, NOT customer impact'
);

-- TEST-010 — Delivered 2d EARLY (on-time control; should NOT appear in impact).
INSERT INTO batches (
  batch_code, dealer_id, model, year, requested_quantity,
  requested_at, dealer_promised_delivery_date,
  current_stage, lifecycle_state, feasibility_status,
  partnership_confidence, operations_confidence,
  color_summary, app_display_cities, dealer_receiving_city,
  po_number, actual_po_date, vin_receiving_date,
  closed_at, closure_reason, delivered_quantity, notes
) VALUES (
  'TEST-010', (SELECT id FROM dealers WHERE name='test'), 'Tucson', 2026, 2,
  '2026-02-20', '2026-04-12',
  'delivered', 'post_po', 'feasible',
  95, 90,
  'White', 'Riyadh', 'Riyadh',
  'TEST-PO-010', '2026-02-25', '2026-03-15',
  '2026-04-10', 'delivered', 2, 'Delivered 2d early — control'
);

-- TEST-011 — Open with an overdue waiting action → fires "Action overdue".
INSERT INTO batches (
  batch_code, dealer_id, model, year, requested_quantity,
  requested_at, dealer_promised_delivery_date,
  current_stage, lifecycle_state, feasibility_status,
  partnership_confidence, operations_confidence,
  color_summary, app_display_cities, dealer_receiving_city,
  po_number, actual_po_date, notes
) VALUES (
  'TEST-011', (SELECT id FROM dealers WHERE name='test'), 'Sonata', 2026, 2,
  '2026-04-01', '2026-06-12',
  'po_issued', 'post_po', 'feasible',
  70, 60,
  'Black', 'Riyadh', 'Riyadh',
  'TEST-PO-011', '2026-04-05', 'Has overdue action — fires action_overdue alert'
);

-- TEST-012 — Heavy re-promise (revision count = 3, projected 15d late).
INSERT INTO batches (
  batch_code, dealer_id, model, year, requested_quantity,
  requested_at, dealer_promised_delivery_date, current_projected_delivery_date,
  current_stage, lifecycle_state, feasibility_status,
  partnership_confidence, operations_confidence,
  color_summary, app_display_cities, dealer_receiving_city,
  po_number, actual_po_date, vin_receiving_date,
  delivery_date_revision_count, notes
) VALUES (
  'TEST-012', (SELECT id FROM dealers WHERE name='test'), 'Kona', 2026, 6,
  '2026-03-25', '2026-06-20', '2026-07-05',
  'po_issued', 'post_po', 'at_risk',
  55, 40,
  'Black, Silver', 'Jeddah', 'Jeddah',
  'TEST-PO-012', '2026-03-28', '2026-05-25',
  3, 'Open, projected 15d late, re-promised 3× — moderate'
);

-- ────────────────────────────────────────────────────────────────────────
-- 4. BATCH ACTIONS — actions that drive phase chips + alert firing
--    Uses INSERT...SELECT so missing action_types are silently skipped.
-- ────────────────────────────────────────────────────────────────────────

-- TEST-004: VIN done → Post-VIN execution zone chip
INSERT INTO batch_actions (batch_id, action_type_id, status, completed_at, expected_date)
SELECT b.id, t.id, 'done', '2026-05-01T10:00:00Z', '2026-05-01'
  FROM batches b CROSS JOIN action_types t
 WHERE b.batch_code = 'TEST-004' AND t.name = 'VIN';

-- TEST-005..007 + TEST-010: Delivery action done = batch marked delivered
INSERT INTO batch_actions (batch_id, action_type_id, status, completed_at, expected_date)
SELECT b.id, t.id, 'done', b.closed_at || 'T15:00:00Z', b.dealer_promised_delivery_date
  FROM batches b CROSS JOIN action_types t
 WHERE b.batch_code IN ('TEST-005', 'TEST-006', 'TEST-007', 'TEST-010')
   AND t.name = 'Delivery';

-- TEST-005..007 + TEST-010: also mark VIN done (delivered batches must be post-VIN)
INSERT INTO batch_actions (batch_id, action_type_id, status, completed_at, expected_date)
SELECT b.id, t.id, 'done', b.vin_receiving_date || 'T12:00:00Z', b.vin_receiving_date
  FROM batches b CROSS JOIN action_types t
 WHERE b.batch_code IN ('TEST-005', 'TEST-006', 'TEST-007', 'TEST-010')
   AND t.name = 'VIN';

-- TEST-008 + TEST-012: VIN done (these are open but post-VIN)
INSERT INTO batch_actions (batch_id, action_type_id, status, completed_at, expected_date)
SELECT b.id, t.id, 'done', b.vin_receiving_date || 'T12:00:00Z', b.vin_receiving_date
  FROM batches b CROSS JOIN action_types t
 WHERE b.batch_code IN ('TEST-008', 'TEST-012')
   AND t.name = 'VIN';

-- TEST-011: A waiting action with expected_date 14 days in the past
-- Picks the first available action_type that isn't VIN or Delivery,
-- so this seed is robust regardless of which specific catalog exists.
INSERT INTO batch_actions (batch_id, action_type_id, status, expected_date)
SELECT b.id,
       (SELECT id FROM action_types
         WHERE name NOT IN ('VIN', 'Delivery')
         ORDER BY sort_order LIMIT 1),
       'waiting',
       '2026-04-28'
  FROM batches b
 WHERE b.batch_code = 'TEST-011'
   AND EXISTS (SELECT 1 FROM action_types WHERE name NOT IN ('VIN','Delivery'));

-- ────────────────────────────────────────────────────────────────────────
-- 5. COLOR MATRIX — exercises dealer colour reliability metric
--    TEST-006: requested 5 (3 Black + 2 White), confirmed 4 (2+2)  → 80%
--    TEST-007: requested 10 (6 Black + 4 Silver), confirmed 10     → 100%
-- ────────────────────────────────────────────────────────────────────────
INSERT INTO batch_color_matrix (batch_id, color, requested_quantity, confirmed_quantity, delivered_quantity)
SELECT id, 'Black', 3, 2, 2 FROM batches WHERE batch_code = 'TEST-006';
INSERT INTO batch_color_matrix (batch_id, color, requested_quantity, confirmed_quantity, delivered_quantity)
SELECT id, 'White', 2, 2, 2 FROM batches WHERE batch_code = 'TEST-006';
INSERT INTO batch_color_matrix (batch_id, color, requested_quantity, confirmed_quantity, delivered_quantity)
SELECT id, 'Black', 6, 6, 6 FROM batches WHERE batch_code = 'TEST-007';
INSERT INTO batch_color_matrix (batch_id, color, requested_quantity, confirmed_quantity, delivered_quantity)
SELECT id, 'Silver', 4, 4, 4 FROM batches WHERE batch_code = 'TEST-007';

-- ════════════════════════════════════════════════════════════════════════════
-- DONE. Expected outcomes after this script:
--
-- Dashboard (force-dynamic, refresh):
--   • Active batches:       8   (TEST-001..004, 008, 011, 012, and TEST-009 is cancelled but not delivered)
--     correction: cancelled counts as "not delivered" in summary unless we exclude it
--   • Pre-VIN critical:     2-3 (TEST-002, TEST-003, possibly TEST-011 depending on its days-to-avail)
--
-- Action Center (alerts fire on page load):
--   • TEST-002:    🚨/⚠️ "VIN approaching"  (high)
--   • TEST-003:    🚨    "VIN critical"     (critical)
--   • TEST-011:    ⚡    "Action overdue"   (medium)
--
-- Reports → Customer Impact:
--   • Affected batches:        5  (TEST-005, 006, 007, 008, 012)
--   • Affected customers:     28  (3+5+10+4+6)
--   • Customer-days lost:    544  (15+75+300+64+90)
--   • Avg delay:           ~16.2  ((5+15+30+16+15)/5)
--   • Re-promises:             6  (2 from TEST-007 + 1 from TEST-008 + 3 from TEST-012)
--   • Severity:    mild 1 / mod 3 / severe 1
--   • Delivered-late: 3 (005,006,007)  ·  Projected-late: 2 (008,012)
--
-- Reports → Dealer Reliability (dealer "test"):
--   • Total: 12  ·  Open: 7  ·  Delivered: 4  ·  Cancelled: 1
--   • Date reliability: 25%  (1 of 4 delivered on time = TEST-010)
--   • Avg variance:    ~+12d  (+5 +15 +30 −2 = +48 / 4)
--   • Cancellation:    8.3%
-- ════════════════════════════════════════════════════════════════════════════
