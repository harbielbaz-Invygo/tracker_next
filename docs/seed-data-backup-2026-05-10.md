# Seed data backup — 2026-05-10

Snapshot of `scripts/seed.ts` immediately **before** the rewrite that
introduced new scenarios for the locked PO Availability date + auto-floored
Ops Expected Delivery model.

This is a documentation backup only — kept so the prior demo data (and
the prior risk model it exercised) can be reconstructed if needed.

## Reference data

### Users (2)

| username | name           | role  | password |
| -------- | -------------- | ----- | -------- |
| `admin`  | Admin User     | admin | admin123 |
| `ops1`   | Ops Manager    | ops   | ops123   |

### Departments (5)

| sortOrder | name        |
| --------- | ----------- |
| 1         | Specs       |
| 2         | Pricing     |
| 3         | Operations  |
| 4         | Logistics   |
| 5         | Partnership |

### Stakeholders (8)

| Department  | sortOrder | name              |
| ----------- | --------- | ----------------- |
| Specs       | 1         | Eslam Medhat      |
| Specs       | 2         | Mohan Sai         |
| Pricing     | 1         | Abdullah Alamoudi |
| Pricing     | 2         | Mohan Sai         |
| Operations  | 1         | Ahmed Abdulhai    |
| Operations  | 2         | Operations Lead   |
| Logistics   | 1         | Logistics Lead    |
| Partnership | 1         | Partnership Lead  |

### Action types (9)

| sortOrder | name         | waitingLabel       | doneLabel        | defaultDept | offsetDays | offsetAnchor |
| --------- | ------------ | ------------------ | ---------------- | ----------- | ---------- | ------------ |
| 1         | Car Specs    | Waiting Car Specs  | Specs Received   | Specs       | 1          | submission   |
| 2         | Pricing      | Waiting Pricing    | Pricing Received | Pricing     | 1          | submission   |
| 3         | SKU          | Waiting SKU        | SKU Created      | Specs       | 2          | submission   |
| 4         | VIN          | Waiting VIN        | VIN Assigned     | Operations  | 3          | submission   |
| 5         | Plate        | Waiting Plate      | Plate Assigned   | Operations  | 5          | vin          |
| 6         | Customs Card | Waiting Customs    | Customs Received | Logistics   | 7          | vin          |
| 7         | Inspection   | Waiting Inspection | Inspection Done  | Operations  | 10         | vin          |
| 8         | App Listing  | Waiting App Listing| Listed in App    | Operations  | 12         | vin          |
| 9         | Delivery     | Waiting Delivery   | Delivered        | Logistics   | 0          | promised     |

### Action dependencies (4 edges, 5 child rows)

| child        | parents          |
| ------------ | ---------------- |
| Plate        | VIN              |
| Customs Card | Plate            |
| App Listing  | VIN, Plate       |
| Delivery     | App Listing      |

### Dealers (4)

| name                 | type | homeCity | policyStatus | avgResponseDays |
| -------------------- | ---- | -------- | ------------ | --------------- |
| Al-Riyadh Motors     | old  | Riyadh   | existing     | 3.0             |
| Capital Auto Group   | old  | Jeddah   | existing     | 3.0             |
| Dammam Fleet Hub     | new  | Dammam   | pending      | 3.0             |
| Khobar Premier       | new  | Khobar   | provided     | 3.0             |

### Settings (rules)

| key                          | value |
| ---------------------------- | ----- |
| `pre_po_ops_lead_time_days`  | 21    |

## Confidence presets

| Label             | confidenceValue (%) | riskScore |
| ----------------- | ------------------- | --------- |
| High Confidence   | 80                  | 18        |
| 50% Confidence    | 50                  | 62        |
| Low Confidence    | 20                  | 85        |

## Scenarios (7)

All offsets are days relative to the day the seed runs.

| # | label                                   | dealerIdx | model            | year | qty | category    | submittedOffset | promisedOffset | expectedPoOffset | actualPoOffset | deliveredOffset | confidence       |
| - | --------------------------------------- | --------- | ---------------- | ---- | --- | ----------- | --------------- | -------------- | ---------------- | -------------- | --------------- | ---------------- |
| 1 | 🆕 Fresh — pre-PO bet, no PO yet        | 0         | Toyota Camry     | 2026 | 30  | Standard    | -2              | +48            | +20              | null           | null            | High Confidence  |
| 2 | 🟢 PO on time — currently mid-ops       | 1         | Hyundai Tucson   | 2026 | 25  | Mid Option  | -20             | +16            | -5               | -5             | null            | High Confidence  |
| 3 | 🔴 PO 5d late — delivery slipping       | 0         | MG ZS            | 2026 | 20  | Standard    | -25             | +11            | -10              | -5             | null            | 50% Confidence   |
| 4 | 🔵 PO 7d early — ahead of schedule      | 1         | Kia Cerato       | 2026 | 40  | Standard    | -15             | +26            | +5               | -2             | null            | High Confidence  |
| 5 | 🎉 Delivered exactly on time            | 2         | Nissan Patrol    | 2025 | 15  | Full Option | -50             | -5             | -26              | -26            | -5              | High Confidence  |
| 6 | ⚠️ Delivered 7d late                    | 3         | Chevrolet Tahoe  | 2025 | 10  | Full Option | -65             | -10            | -36              | -31            | -3              | 50% Confidence   |
| 7 | 🚨 Pre-PO bet, target overdue           | 2         | BMW X5           | 2026 | 8   | Full Option | -14             | +5             | -3               | null           | null            | Low Confidence   |

### Action progress per scenario

- **Pre-PO scenarios** (1, 7): no actions yet (Intake creates them when PO arrives).
- **Mid-ops scenarios** (2, 3, 4): Specs / Pricing / SKU `done` (completed on `actualPo + 2`); VIN `waiting`; Plate / Customs / Inspection / App Listing / Delivery `blocked` (auto-promote when parent done).
- **Delivered scenarios** (5, 6): all 9 actions `done`, `completed_at` distributed evenly between `actualPoDate` and `deliveredOffset` in dependency order.

## Old risk model (the one this rewrite replaced)

Captured for context. Drove the form risk-assessment + Slack header.

- **Block** when `daysFromToday(promised) < leadTimeDays`.
  - Submission blocked unless Ops checked the override box.
  - Override → `feasibilityStatus = "at_risk"` + Slack header
    `⚠️ HIGH RISK — Pre PO Ops Lead Time was overridden at Intake`.
- **Caution** when `leadTimeDays ≤ daysFromToday(promised) < leadTimeDays + 4`.
  - Submission allowed; Slack header
    `⚠️ TIGHT WINDOW — Any VIN delay will push availability past the promise`.
  - `feasibilityStatus = "at_risk"`.
- **PO date gap** = `today − poDate` — informational only.

The Intake form had:
- A red block banner with an "I acknowledge the risk" checkbox.
- A gold caution banner shown automatically when in the tight window.
- Per-split inline messages (`🚫 Only Nd to availability` / `⚠️ Only Nd to availability`).
- A `riskOverride` field in the create-batch payload.

Server `app/api/intake/create/route.ts`:
- Re-validated the lead time floor and returned `422` if breached without override.
- Set `feasibilityStatus = "at_risk"` whenever block-overridden or in caution.

## What changed in the rewrite

- **PO Availability date** is now read-only in Intake (locked from PDF / first manual entry).
- **Ops Expected Delivery** is a separate per-split field, auto-defaulted to
  `max(POAvailability, today + leadTimeDays)`. Editable by Ops.
- The hard "Pre PO Ops Lead Time floor breached" block + override checkbox is gone.
- A softer "⚠️ Ops ETA is behind the dealer promise" caution is shown when
  any split's Ops Expected sits past its PO Availability.
- Slack header reads `⚠️ OPS BEHIND PROMISE — {model → city: Ops ETA +Nd past dealer promise}`.
- Server drops the lead-time block + `riskOverride`; sets
  `feasibilityStatus = "at_risk"` when any split has Ops > Availability.
- `batches.currentProjectedDeliveryDate` now stores Ops's commitment (not a copy of the dealer date).
- VIN receiving date is no longer captured at Intake — Ops fills it later in Cockpit.
