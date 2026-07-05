/**
 * Characterization tests for the pure planning helpers extracted from
 * POST /api/intake/create. Each expectation encodes the ORIGINAL inline
 * behaviour, so a regression in the extracted function fails here.
 *
 * Run: node --import tsx --test lib/intake-planning.test.ts
 * (node:test + node:assert are built-in — no new dependencies.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveRequestedAt,
  computeFeasibility,
  buildParentDepSet,
  groupItemsIntoBatches,
  type IntakeItem,
} from "./intake-planning";

// ── resolveRequestedAt ────────────────────────────────────────────
test("resolveRequestedAt: empty / whitespace / null → today", () => {
  assert.equal(resolveRequestedAt(undefined, "2026-07-01"), "2026-07-01");
  assert.equal(resolveRequestedAt(null, "2026-07-01"), "2026-07-01");
  assert.equal(resolveRequestedAt("", "2026-07-01"), "2026-07-01");
  assert.equal(resolveRequestedAt("   ", "2026-07-01"), "2026-07-01");
});
test("resolveRequestedAt: valid past date passes through (trimmed)", () => {
  assert.equal(resolveRequestedAt("2026-06-15", "2026-07-01"), "2026-06-15");
  assert.equal(resolveRequestedAt("  2026-06-15  ", "2026-07-01"), "2026-06-15");
});
test("resolveRequestedAt: today itself passes", () => {
  assert.equal(resolveRequestedAt("2026-07-01", "2026-07-01"), "2026-07-01");
});
test("resolveRequestedAt: future date → today", () => {
  assert.equal(resolveRequestedAt("2026-08-01", "2026-07-01"), "2026-07-01");
});
test("resolveRequestedAt: bad format → today (never throws)", () => {
  assert.equal(resolveRequestedAt("July 1", "2026-07-01"), "2026-07-01");
  assert.equal(resolveRequestedAt("2026/07/01", "2026-07-01"), "2026-07-01");
  assert.equal(resolveRequestedAt("26-07-01", "2026-07-01"), "2026-07-01");
});

// ── computeFeasibility ────────────────────────────────────────────
const split = (city: string, date: string, ops: string) =>
  ({ quantity: 1, city, date, opsExpectedDate: ops });

test("computeFeasibility: all ops on/before promise → feasible", () => {
  const items: IntakeItem[] = [{ model: "A", year: 2026, splits: [split("R", "2026-07-05", "2026-07-05")] }];
  assert.equal(computeFeasibility(items), "feasible");
});
test("computeFeasibility: any ops after promise → at_risk", () => {
  const items: IntakeItem[] = [{
    model: "A", year: 2026,
    splits: [split("R", "2026-07-05", "2026-07-05"), split("J", "2026-07-05", "2026-07-10")],
  }];
  assert.equal(computeFeasibility(items), "at_risk");
});
test("computeFeasibility: empty opsExpectedDate falls back to date → feasible", () => {
  const items: IntakeItem[] = [{ model: "A", year: 2026, splits: [split("R", "2026-07-05", "")] }];
  assert.equal(computeFeasibility(items), "feasible");
});
test("computeFeasibility: no items → feasible", () => {
  assert.equal(computeFeasibility([]), "feasible");
});

// ── buildParentDepSet ─────────────────────────────────────────────
test("buildParentDepSet: child blocked only when its parent is ALSO picked", () => {
  const deps = [
    { actionTypeId: 2, dependsOnActionTypeId: 1 },   // parent 1 is picked
    { actionTypeId: 3, dependsOnActionTypeId: 99 },  // parent 99 NOT picked
  ];
  const set = buildParentDepSet([1, 2, 3], deps);
  assert.equal(set.has(2), true);
  assert.equal(set.has(3), false); // dormant dep → child starts waiting
  assert.equal(set.has(1), false);
});
test("buildParentDepSet: multi-parent child stays waiting if any picked parent present", () => {
  const deps = [
    { actionTypeId: 5, dependsOnActionTypeId: 4 },   // picked
    { actionTypeId: 5, dependsOnActionTypeId: 88 },  // not picked
  ];
  assert.equal(buildParentDepSet([4, 5], deps).has(5), true);
});
test("buildParentDepSet: no deps → empty", () => {
  assert.equal(buildParentDepSet([1, 2], []).size, 0);
});

// ── groupItemsIntoBatches ─────────────────────────────────────────
test("groupItemsIntoBatches: same key, different cities → one group, sibling legs (order preserved)", () => {
  const items: IntakeItem[] = [{
    model: "Accent", year: 2025, unitPriceSar: 100, taxPct: 15, buyBackRate: 30000, contractLengthMonths: 36,
    splits: [split("Riyadh", "2026-07-20", "2026-07-20"), split("Jeddah", "2026-07-20", "2026-07-20")],
  }];
  const groups = groupItemsIntoBatches(items);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].availabilityDate, "2026-07-20");
  assert.deepEqual(groups[0].legs.map((l) => l.city), ["Riyadh", "Jeddah"]);
});
test("groupItemsIntoBatches: different dates → separate groups", () => {
  const items: IntakeItem[] = [{
    model: "Accent", year: 2025,
    splits: [split("Riyadh", "2026-07-20", "2026-07-20"), split("Riyadh", "2026-08-08", "2026-08-08")],
  }];
  assert.equal(groupItemsIntoBatches(items).length, 2);
});
test("groupItemsIntoBatches: commercial-term mismatch splits same model+date", () => {
  const items: IntakeItem[] = [
    { model: "Accent", year: 2025, unitPriceSar: 100, splits: [split("Riyadh", "2026-07-20", "2026-07-20")] },
    { model: "Accent", year: 2025, unitPriceSar: 200, splits: [split("Riyadh", "2026-07-20", "2026-07-20")] },
  ];
  assert.equal(groupItemsIntoBatches(items).length, 2);
});
test("groupItemsIntoBatches: multi-item multi-window PO (PO-0121-shaped) → distinct-key count", () => {
  const mk = (model: string): IntakeItem => ({
    model, year: 2026,
    splits: [
      split("Riyadh", "2026-07-20", "2026-07-20"),
      split("Jeddah", "2026-07-20", "2026-07-20"),
      split("Riyadh", "2026-08-08", "2026-08-08"),
    ],
  });
  // Each model → 2 date-groups (07-20 w/ 2 legs, 08-08 w/ 1 leg) → 2 models × 2 = 4.
  assert.equal(groupItemsIntoBatches([mk("A"), mk("B")]).length, 4);
});
test("groupItemsIntoBatches: null vs undefined commercial terms collapse to same key", () => {
  const items: IntakeItem[] = [
    { model: "X", year: 2026, unitPriceSar: null, splits: [split("R", "2026-07-20", "2026-07-20")] },
    { model: "X", year: 2026, /* unitPriceSar undefined */ splits: [split("J", "2026-07-20", "2026-07-20")] },
  ];
  assert.equal(groupItemsIntoBatches(items).length, 1); // ?? null makes them equal
});
