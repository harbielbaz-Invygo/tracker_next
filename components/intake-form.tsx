"use client";

/**
 * Intake form — the main Post-PO workflow.
 *
 *   Step 1: Drop signed PO PDF
 *   Step 2: Edit PO header (PO #, dates, dealer, reference)
 *   Step 3: Edit Items × Splits (parser pre-fills; user can adjust qty/city/date)
 *   Step 4: Pick actions to track + assign each to a department
 *   Step 5: Submit → /api/intake/create → success summary with batch codes
 *
 * The form keeps a single canonical state object. Parsed PDF data hydrates
 * the fields once on first parse; later edits stay in the form state.
 */
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { IntakeOptions } from "@/lib/intake-data";
import {
  formatSlackMessage,
  type ParsedPO, type SlackAction, type SlackRisk, type SlackItemSnapshot,
} from "@/lib/po-parser";
import { cn } from "@/lib/utils";

interface Props {
  options: IntakeOptions;
}

// ──────────────────────────────────────────────────────────────────
// Form state shape
// ──────────────────────────────────────────────────────────────────

interface SplitDraft {
  quantity: number;
  city: string;
  /**
   * PO Availability date — the dealer-promised date from the PO.
   * Fixed by partnership; the plan against which Partnership Confidence
   * is measured. Read-only in the form: changing it would mean amending
   * the PO, not editing the row.
   */
  date: string; // ISO yyyy-mm-dd
  /**
   * Ops's expected delivery date — the operational commitment, separate
   * from the dealer's promise. Drives Ops Confidence. Auto-defaulted to
   * `max(date, today + leadTimeDays)` so it always satisfies the lead
   * time floor; Ops can edit it later if they need to push out further.
   */
  opsExpectedDate: string; // ISO yyyy-mm-dd
}

const DAY_MS_LOCAL = 24 * 60 * 60 * 1000;

/**
 * Auto-default for Ops Expected Delivery: the later of the dealer-promised
 * availability date and (today + leadTimeDays). Returns "" when the
 * availability date isn't set yet (rare — newly-added split with no inherit).
 */
function defaultOpsDate(availabilityIso: string, leadTimeDays: number): string {
  if (!availabilityIso) return "";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const earliestIso = new Date(today.getTime() + leadTimeDays * DAY_MS_LOCAL)
    .toISOString().slice(0, 10);
  return availabilityIso < earliestIso ? earliestIso : availabilityIso;
}
interface ItemDraft {
  model: string;
  year: number;
  buyBackRate: number | null;
  contractLength: string;
  contractLengthMonths: number | null;
  colorsRaw: string;
  unitPriceSar: number | null;
  taxPct: number | null;
  splits: SplitDraft[];
}
interface ActionPick {
  actionTypeId: number;
  selected: boolean;
  /**
   * Department is NOT editable at Intake — it's pinned to the action
   * type's `defaultDepartmentId` (configured once in Settings). Per-batch
   * overrides would let intake operators silently change ownership rules
   * the admin set centrally.
   */
}

interface SubmitSummary {
  created: { id: number; batchCode: string; modelYear: string; city: string; quantity: number }[];
}

// ──────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────

export default function IntakeForm({ options }: Props) {
  const router = useRouter();

  // ── PDF state
  const [parsed, setParsed]   = useState<ParsedPO | null>(null);
  const [parsing, setParsing] = useState<boolean>(false);
  const [parseError, setParseError] = useState<string | null>(null);

  // ── Editable header
  const [poNumber, setPoNumber] = useState<string>("");
  const [poDate,   setPoDate]   = useState<string>("");
  const [reference,setReference]= useState<string>("");

  // Dealer: choose existing or type new
  const [dealerId, setDealerId] = useState<number | null>(null);
  const [dealerName, setDealerName] = useState<string>("");

  // Items × splits
  const [items, setItems] = useState<ItemDraft[]>([]);

  // Actions — only the checkbox is mutable at Intake.
  // Default unchecked: Ops explicitly opts in to each action this batch needs.
  // The department is fixed by the action type's Settings-configured default;
  // the stakeholder is picked once per department (see `pickedStakeholders` below).
  const [actions, setActions] = useState<ActionPick[]>(
    options.actionTypes.map((t) => ({
      actionTypeId: t.id,
      selected: false,
    })),
  );

  /**
   * One stakeholder picked per department, applied to every checked action
   * in that column. Map keys are department ids; null value means
   * "department exists but no stakeholder picked yet" (action will be
   * created unassigned). Departments with no stakeholders configured
   * never appear here.
   */
  const [pickedStakeholders, setPickedStakeholders] = useState<Record<number, number | null>>({});

  /**
   * Group action types by their Settings-configured department, ordered
   * by department.sortOrder. Unassigned actions (no default department)
   * land in a final column tagged for admin attention.
   *
   * Each column carries the department's stakeholder list so the column
   * header can render a stakeholder dropdown.
   */
  const actionColumns = useMemo(() => {
    type Col = {
      deptId: number | null;
      deptName: string;
      actions: IntakeOptions["actionTypes"];
      stakeholders: IntakeOptions["departments"][number]["stakeholders"];
    };
    const byDept = new Map<number | null, IntakeOptions["actionTypes"]>();
    for (const t of options.actionTypes) {
      const arr = byDept.get(t.defaultDepartmentId) ?? [];
      arr.push(t);
      byDept.set(t.defaultDepartmentId, arr);
    }
    const stakeholdersByDept = new Map(options.departments.map((d) => [d.id, d.stakeholders]));
    const ordered: Col[] = [];
    for (const d of options.departments) {
      const arr = byDept.get(d.id);
      if (arr && arr.length > 0) ordered.push({
        deptId: d.id,
        deptName: d.name,
        actions: arr,
        stakeholders: stakeholdersByDept.get(d.id) ?? [],
      });
    }
    const unassigned = byDept.get(null);
    if (unassigned && unassigned.length > 0) {
      ordered.push({ deptId: null, deptName: "Unassigned", actions: unassigned, stakeholders: [] });
    }
    return ordered;
  }, [options.actionTypes, options.departments]);

  const [notes, setNotes] = useState<string>("");

  // Submit state
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [summary, setSummary] = useState<SubmitSummary | null>(null);

  // ── Parse PDF
  async function onFile(file: File | null) {
    if (!file) return;
    setParsing(true);
    setParseError(null);
    setSummary(null); // clear any prior submit summary
    try {
      const fd = new FormData();
      fd.append("pdf", file);
      const res = await fetch("/api/po-parse", { method: "POST", body: fd });
      if (!res.ok) throw new Error(await res.text());
      setParsed((await res.json()) as ParsedPO);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
      setParsed(null);
    } finally {
      setParsing(false);
    }
  }

  // ── Hydrate form once parsed PDF arrives
  useEffect(() => {
    if (!parsed) return;
    setPoNumber(parsed.poNumber ?? "");
    setPoDate(parsed.poDate ?? "");
    setReference(parsed.reference ?? "");

    // Dealer auto-match
    const matched = parsed.dealerName
      ? options.dealers.find(
          (d) => d.name.trim().toLowerCase() === parsed.dealerName!.trim().toLowerCase(),
        )
      : null;
    if (matched) {
      setDealerId(matched.id);
      setDealerName(matched.name);
    } else {
      setDealerId(null);
      setDealerName(parsed.dealerName ?? "");
    }

    // Items
    setItems(parsed.items.map<ItemDraft>((it) => ({
      model: it.model ?? "",
      year:  it.year  ?? new Date().getFullYear(),
      buyBackRate: it.buyBackRate ?? null,
      contractLength: it.contractLength ?? "",
      contractLengthMonths: it.contractLengthMonths ?? null,
      colorsRaw: it.colorsRaw ?? "",
      unitPriceSar: it.unitPriceSar ?? null,
      taxPct: it.taxPct ?? null,
      splits: it.deliverySplits.length > 0
        ? it.deliverySplits.map((s) => ({
            quantity: s.quantity,
            city: s.city,
            date: s.date,
            // Default Ops's ETA to max(dealer date, today + lead time)
            // so the field always satisfies the operational floor.
            opsExpectedDate: defaultOpsDate(s.date, options.leadTimeDays),
          }))
        : [{
            quantity: it.quantity ?? 1,
            city: parsed.deliveryAddress?.split("\n")[0]?.trim() ?? "",
            date: parsed.deliveryDate ?? "",
            opsExpectedDate: defaultOpsDate(parsed.deliveryDate ?? "", options.leadTimeDays),
          }],
    })));
  }, [parsed, options.dealers]);

  // ── Mutators (small helpers to keep updates immutable)
  function updateItem(i: number, partial: Partial<ItemDraft>) {
    setItems((curr) => curr.map((it, idx) => (idx === i ? { ...it, ...partial } : it)));
  }
  function updateSplit(i: number, j: number, partial: Partial<SplitDraft>) {
    setItems((curr) => curr.map((it, idx) =>
      idx === i
        ? { ...it, splits: it.splits.map((s, jdx) => (jdx === j ? { ...s, ...partial } : s)) }
        : it,
    ));
  }
  function addSplit(i: number) {
    // Availability is locked once set, so a new split inherits the
    // existing availability from the first split in the same item.
    // Ops expected re-defaults from there.
    setItems((curr) => curr.map((it, idx) => {
      if (idx !== i) return it;
      const inheritedAvail = it.splits[0]?.date ?? "";
      return {
        ...it,
        splits: [...it.splits, {
          quantity: 1,
          city: "",
          date: inheritedAvail,
          opsExpectedDate: defaultOpsDate(inheritedAvail, options.leadTimeDays),
        }],
      };
    }));
  }
  function removeSplit(i: number, j: number) {
    setItems((curr) => curr.map((it, idx) =>
      idx === i ? { ...it, splits: it.splits.filter((_, jdx) => jdx !== j) } : it,
    ));
  }
  function addItem() {
    setItems((curr) => [...curr, {
      model: "", year: new Date().getFullYear(),
      buyBackRate: null, contractLength: "", contractLengthMonths: null,
      colorsRaw: "", unitPriceSar: null, taxPct: null,
      splits: [{ quantity: 1, city: "", date: "", opsExpectedDate: "" }],
    }]);
  }
  function removeItem(i: number) {
    setItems((curr) => curr.filter((_, idx) => idx !== i));
  }

  function setActionSelected(actionTypeId: number, selected: boolean) {
    setActions((curr) => curr.map((a) =>
      a.actionTypeId === actionTypeId ? { ...a, selected } : a,
    ));
  }

  // ── Submit
  async function onSubmit() {
    setSubmitError(null);
    setSubmitting(true);
    try {
      const payload = {
        po: {
          number: poNumber.trim(),
          date: poDate,
          reference: reference.trim() || null,
        },
        dealerId: dealerId ?? undefined,
        dealerName: dealerId ? undefined : dealerName.trim(),
        items: items.map((it) => ({
          model: it.model.trim(),
          year:  it.year,
          buyBackRate: it.buyBackRate,
          contractLength: it.contractLength.trim() || null,
          contractLengthMonths: it.contractLengthMonths,
          colorsRaw: it.colorsRaw.trim() || null,
          unitPriceSar: it.unitPriceSar,
          taxPct: it.taxPct,
          splits: it.splits.map((s) => ({
            quantity: Number(s.quantity),
            city: s.city.trim(),
            date: s.date,
            opsExpectedDate: s.opsExpectedDate,
          })),
        })),
        actions: actions
          .filter((a) => a.selected)
          .map((a) => {
            // Department is fixed to the Settings-configured default for
            // this action type — never overridable per batch. Stakeholder
            // is the one picked for that department (or null).
            const type = options.actionTypes.find((t) => t.id === a.actionTypeId);
            const departmentId = type?.defaultDepartmentId ?? null;
            const assignedStakeholderId = departmentId
              ? (pickedStakeholders[departmentId] ?? null)
              : null;
            return {
              actionTypeId: a.actionTypeId,
              departmentId,
              assignedStakeholderId,
            };
          }),
        notes: notes.trim() || null,
      };

      const res = await fetch("/api/intake/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as SubmitSummary;
      setSummary(data);
      router.refresh();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function resetForm() {
    setParsed(null);
    setParseError(null);
    setSummary(null);
    setPoNumber(""); setPoDate(""); setReference("");
    setDealerId(null); setDealerName("");
    setItems([]);
    setNotes("");
    setActions(options.actionTypes.map((t) => ({
      actionTypeId: t.id, selected: false,
    })));
    setPickedStakeholders({});
  }

  /**
   * Live risk assessment — recomputes whenever dates change.
   *
   * New model (after locking availability + auto-padding Ops):
   *   - **Behind promise** when `opsExpectedDate > availability` for any
   *     split. Surfaced as a caution; submission is always allowed since
   *     Ops has already committed to the later date.
   *   - **PO date gap** = `today − poDate`. Pre-tracking delay we caused
   *     ourselves before uploading; informational, never blocks.
   *
   * The old hard "lead time floor" block + override checkbox is gone:
   * the lead time is now folded into the Ops Expected default, so it's
   * impossible to commit to less than the floor.
   */
  const riskAssessment = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayMs = today.getTime();
    const DAY_MS = 24 * 60 * 60 * 1000;

    type SplitRisk = {
      itemIndex: number; splitIndex: number;
      itemModel: string; splitCity: string;
      /** Days Ops's commitment trails the dealer-promised availability. 0 = on promise. */
      behindDays: number;
      level: "ok" | "behind";
    };
    const perSplit: SplitRisk[] = [];
    let hasBehind = false;

    for (const [i, it] of items.entries()) {
      for (const [j, s] of it.splits.entries()) {
        if (!s.date || !s.opsExpectedDate) continue;
        const behindDays = Math.max(
          0,
          Math.round((new Date(s.opsExpectedDate).getTime() - new Date(s.date).getTime()) / DAY_MS),
        );
        const level: "ok" | "behind" = behindDays > 0 ? "behind" : "ok";
        if (level === "behind") hasBehind = true;
        perSplit.push({
          itemIndex: i, splitIndex: j,
          itemModel: it.model, splitCity: s.city,
          behindDays, level,
        });
      }
    }

    // Pre-tracking gap (PO issued vs uploaded today).
    let poGapDays = 0;
    if (poDate) {
      poGapDays = Math.round((todayMs - new Date(poDate).getTime()) / DAY_MS);
      if (poGapDays < 0) poGapDays = 0;   // future PO date doesn't count as a gap
    }

    return { perSplit, hasBehind, poGapDays };
  }, [items, poDate]);

  // ── Derived: validity gate for submit button
  const canSubmit = useMemo(() => {
    if (!poNumber.trim() || !poDate) return false;
    if (!dealerId && !dealerName.trim()) return false;
    if (items.length === 0) return false;
    if (items.some((it) => !it.model.trim() || !it.year || it.splits.length === 0)) return false;
    if (items.some((it) => it.splits.some((s) =>
      !s.city.trim() || !s.date || !s.opsExpectedDate || !(s.quantity > 0)
    ))) return false;
    if (!actions.some((a) => a.selected)) return false;
    return true;
  }, [poNumber, poDate, dealerId, dealerName, items, actions]);

  // Map each checked action to its Slack-ready shape (label + dept + stakeholder).
  // Lookups are O(1) via two pre-built indices.
  const slackActions = useMemo<SlackAction[]>(() => {
    const deptNameById = new Map(options.departments.map((d) => [d.id, d.name]));
    const stakeholderNameById = new Map<number, string>();
    for (const d of options.departments) {
      for (const s of d.stakeholders) stakeholderNameById.set(s.id, s.name);
    }

    return actions
      .filter((a) => a.selected)
      .map((a) => {
        const type = options.actionTypes.find((t) => t.id === a.actionTypeId);
        const departmentId   = type?.defaultDepartmentId ?? null;
        const departmentName = departmentId ? (deptNameById.get(departmentId) ?? null) : null;
        const stakeholderId  = departmentId ? (pickedStakeholders[departmentId] ?? null) : null;
        const stakeholderName = stakeholderId ? (stakeholderNameById.get(stakeholderId) ?? null) : null;
        return {
          actionLabel: type?.waitingLabel ?? "(unknown action)",
          departmentName,
          stakeholderName,
        };
      });
  }, [actions, options.actionTypes, options.departments, pickedStakeholders]);

  // Slack-message risk header — emitted only when Ops's commitment is
  // behind the dealer-promised availability on at least one split. The
  // reason summarises the worst-behind split so partnership knows which
  // delivery is at risk.
  const slackRisk = useMemo<SlackRisk | undefined>(() => {
    if (!riskAssessment.hasBehind) return undefined;
    const worst = riskAssessment.perSplit
      .filter((r) => r.level === "behind")
      .sort((a, b) => b.behindDays - a.behindDays)[0];
    return {
      level: "caution",
      reason: worst
        ? `${worst.itemModel} → ${worst.splitCity}: Ops ETA +${worst.behindDays}d past dealer promise`
        : "Ops ETA past dealer-promised availability",
    };
  }, [riskAssessment]);

  // Snapshot the form's current items (with the new opsExpectedDate)
  // so the Slack message reflects what Ops actually entered, including
  // their per-split commitment.
  const slackItems = useMemo<SlackItemSnapshot[]>(() => items.map((it) => ({
    model: it.model.trim() || "—",
    year:  Number.isFinite(it.year) ? it.year : null,
    quantity: it.splits.reduce((a, s) => a + (Number(s.quantity) || 0), 0),
    contractLength: it.contractLength.trim() || null,
    buyBackRate:    it.buyBackRate,
    colorsRaw:      it.colorsRaw.trim() || null,
    deliverySplits: it.splits.map((s) => ({
      quantity: Number(s.quantity) || 0,
      city: s.city.trim(),
      date: s.date,
      opsExpectedDate: s.opsExpectedDate || null,
    })),
  })), [items]);

  const slackText = parsed
    ? formatSlackMessage(parsed, slackActions, slackRisk, slackItems)
    : "";

  // ──────────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────────

  // Success summary takes over the page.
  if (summary) {
    return (
      <SuccessPanel summary={summary} onAnother={resetForm} />
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Step 1: PDF drop ───────────────────────────────────── */}
      <div className="card">
        <h2 className="text-base font-bold mb-2">📎 Step 1 · Upload PO PDF</h2>
        <input
          type="file" accept="application/pdf"
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm file:mr-4 file:py-2 file:px-4
                     file:rounded-md file:border file:border-ink-300
                     file:text-sm file:font-medium file:bg-white
                     file:text-midnight hover:file:border-brand"
          disabled={parsing}
        />
        {parsing && <p className="text-xs text-ink-500 mt-2">Parsing…</p>}
        {parseError && (
          <p
            role="alert"
            className="text-sm text-flame-dark bg-flame-pale border border-flame
                       px-3 py-2 rounded-md mt-3"
          >
            Could not parse PDF: {parseError}
          </p>
        )}
        {parsed && (
          <p className="text-xs text-green-dark mt-2">
            ✓ Parsed — fields below auto-filled. Edit anything that&apos;s off, then submit.
          </p>
        )}
      </div>

      {/* Everything from here on requires a parse. */}
      {!parsed && (
        <p className="text-sm text-ink-500 px-1">
          Drop a PO PDF above to start. The header, items, and delivery splits will
          auto-fill into editable fields below.
        </p>
      )}

      {parsed && (
        <>
          {/* ── Step 2: PO header ──────────────────────────────── */}
          <div className="card">
            <h2 className="text-base font-bold mb-3">📄 Step 2 · PO Header</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <FormField label="PO Number" required>
                <input className="input" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} />
              </FormField>
              <FormField label="PO Date" required>
                <input type="date" className="input" value={poDate} onChange={(e) => setPoDate(e.target.value)} />
              </FormField>
              <FormField label="Reference">
                <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} />
              </FormField>
              <FormField label="Dealer" required hint={dealerId ? "Existing dealer" : "Will create new"}>
                <DealerSelect
                  options={options.dealers}
                  dealerId={dealerId}
                  dealerName={dealerName}
                  onPickExisting={(id, name) => { setDealerId(id); setDealerName(name); }}
                  onCreateNew={(name) => { setDealerId(null); setDealerName(name); }}
                />
              </FormField>
            </div>
          </div>

          {/* ── Step 3: Items × Splits ─────────────────────────── */}
          <div className="card">
            <div className="flex items-baseline justify-between mb-3 gap-3">
              <h2 className="text-base font-bold">🚗 Step 3 · Items & Delivery Splits</h2>
              <button type="button" className="btn text-xs" onClick={addItem}>+ Add item</button>
            </div>

            {items.length === 0 && (
              <p className="text-sm text-ink-500">No items parsed. Add one to continue.</p>
            )}

            <div className="space-y-4">
              {items.map((it, i) => (
                <ItemEditor
                  key={i}
                  index={i}
                  item={it}
                  splitRisks={riskAssessment.perSplit.filter((r) => r.itemIndex === i)}
                  leadTimeDays={options.leadTimeDays}
                  onChange={(partial) => updateItem(i, partial)}
                  onSplitChange={(j, partial) => updateSplit(i, j, partial)}
                  onAddSplit={() => addSplit(i)}
                  onRemoveSplit={(j) => removeSplit(i, j)}
                  onRemove={() => removeItem(i)}
                  removable={items.length > 1}
                />
              ))}
            </div>
          </div>

          {/* ── Step 4: Actions ────────────────────────────────── */}
          <div className="card">
            <h2 className="text-base font-bold mb-1">✅ Step 4 · Actions to track</h2>
            <p className="text-xs text-ink-500 mb-3">
              Pick what this batch needs. Actions are grouped by the department
              that owns them (configured in Settings → Action Types).
              Dependencies are auto-respected — actions with parents start as
              &quot;blocked&quot; and unlock when their parents are marked done in Cockpit.
            </p>

            <div
              className="grid gap-4"
              style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}
            >
              {actionColumns.map((col) => (
                <ActionDepartmentColumn
                  key={col.deptId ?? "unassigned"}
                  deptId={col.deptId}
                  deptName={col.deptName}
                  actions={col.actions}
                  stakeholders={col.stakeholders}
                  pickedStakeholderId={col.deptId != null ? (pickedStakeholders[col.deptId] ?? null) : null}
                  onPickStakeholder={(stakeholderId) => {
                    if (col.deptId == null) return;
                    setPickedStakeholders((curr) => ({ ...curr, [col.deptId!]: stakeholderId }));
                  }}
                  picks={actions}
                  onToggle={setActionSelected}
                />
              ))}
            </div>
          </div>

          {/* ── Step 5: Notes + Submit ─────────────────────────── */}
          <div className="card">
            <h2 className="text-base font-bold mb-3">📝 Step 5 · Submit</h2>

            {/* PO-issued vs uploaded gap — informational only. */}
            {riskAssessment.poGapDays > 0 && (
              <p className="text-xs px-3 py-2 mb-3 rounded-md bg-ink-100 border border-ink-200 text-midnight leading-snug">
                ℹ️ <strong>Pre-tracking gap +{riskAssessment.poGapDays}d</strong> —
                this PO was issued on {poDate}, uploaded today. The dashboard
                timeline will show this as time lost before tracking began.
              </p>
            )}

            {/* Ops-behind-dealer caution. No override needed — Ops's
                commitment was already auto-floored to today + {leadTimeDays}d,
                which is later than the dealer's promised date. Submitting
                marks the batch feasibility=at_risk so dashboards flag it. */}
            {riskAssessment.hasBehind && (
              <div role="status"
                   className="rounded-md border border-gold bg-gold-pale px-3 py-3 mb-3">
                <p className="font-bold text-sm text-midnight mb-1">
                  ⚠️ Ops ETA is behind the dealer promise
                </p>
                <p className="text-xs text-midnight leading-snug">
                  At least one split has the dealer-promised availability inside
                  the {options.leadTimeDays}-day Pre PO Ops Lead Time window, so
                  Ops Expected Delivery has been auto-pushed to today +
                  {" "}{options.leadTimeDays}d. Partnership will see this as Ops
                  trailing the promise — the Slack message includes a callout.
                </p>
                <ul className="mt-2 text-xs text-midnight leading-snug space-y-0.5">
                  {riskAssessment.perSplit
                    .filter((r) => r.level === "behind")
                    .map((r) => (
                      <li key={`${r.itemIndex}-${r.splitIndex}`}>
                        • <strong>{r.itemModel || "(item)"}</strong> → {r.splitCity || "—"}
                        : Ops <span className="tabular-nums">+{r.behindDays}d</span> past dealer promise.
                      </li>
                    ))}
                </ul>
              </div>
            )}

            <FormField label="Notes (optional)">
              <textarea className="input min-h-[80px]" value={notes}
                        onChange={(e) => setNotes(e.target.value)} />
            </FormField>

            <div className="flex flex-wrap items-center justify-between gap-3 mt-4">
              <p className="text-xs text-ink-500">
                {countSummary(items, actions)}
              </p>
              <button
                type="button"
                onClick={onSubmit}
                disabled={!canSubmit || submitting}
                className="btn btn-primary"
              >
                {submitting ? "Creating…" : "Create batches"}
              </button>
            </div>
            {submitError && (
              <p
                role="alert"
                className="text-sm text-flame-dark bg-flame-pale border border-flame
                           px-3 py-2 rounded-md mt-3"
              >
                Could not submit: {submitError}
              </p>
            )}
          </div>

          {/* Slack announcement (post-submit reference) */}
          <div className="card">
            <div className="flex items-baseline justify-between mb-2 gap-3">
              <h2 className="text-base font-bold">📣 Slack announcement</h2>
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(slackText)}
                className="btn text-xs"
              >📋 Copy</button>
            </div>
            <p className="text-xs text-ink-500 mb-2">
              Slack-ready text. Paste into the partnership channel after creating the batches.
            </p>
            <pre className="bg-ink-100 border border-ink-200 rounded-md p-3 text-xs
                            whitespace-pre-wrap font-mono text-midnight overflow-x-auto">
              {slackText}
            </pre>
          </div>
        </>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────────

function FormField({
  label, required = false, hint, children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-ink-600 mb-1">
        {label}
        {required && <span className="text-flame-dark ml-0.5" aria-hidden="true">*</span>}
        {hint && <span className="text-ink-400 ml-2 font-normal">· {hint}</span>}
      </span>
      {children}
    </label>
  );
}

function DealerSelect({
  options, dealerId, dealerName,
  onPickExisting, onCreateNew,
}: {
  options: IntakeOptions["dealers"];
  dealerId: number | null;
  dealerName: string;
  onPickExisting: (id: number, name: string) => void;
  onCreateNew: (name: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <select
        className="input"
        value={dealerId ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "") {
            onCreateNew(dealerName); // keep typed name
          } else {
            const id = parseInt(v, 10);
            const found = options.find((d) => d.id === id);
            if (found) onPickExisting(found.id, found.name);
          }
        }}
      >
        <option value="">— Create new dealer —</option>
        {options.map((d) => (
          <option key={d.id} value={d.id}>{d.name} · {d.homeCity}</option>
        ))}
      </select>
      {!dealerId && (
        <input
          className="input"
          placeholder="New dealer name"
          value={dealerName}
          onChange={(e) => onCreateNew(e.target.value)}
        />
      )}
    </div>
  );
}

function ItemEditor({
  index, item, splitRisks, leadTimeDays,
  onChange, onSplitChange, onAddSplit, onRemoveSplit, onRemove, removable,
}: {
  index: number;
  item: ItemDraft;
  splitRisks: { splitIndex: number; behindDays: number; level: "ok" | "behind" }[];
  leadTimeDays: number;
  onChange: (partial: Partial<ItemDraft>) => void;
  onSplitChange: (j: number, partial: Partial<SplitDraft>) => void;
  onAddSplit: () => void;
  onRemoveSplit: (j: number) => void;
  onRemove: () => void;
  removable: boolean;
}) {
  const splitsTotal = item.splits.reduce((a, s) => a + (Number(s.quantity) || 0), 0);
  return (
    <div className="border border-ink-200 rounded-md p-3 bg-white">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h3 className="text-sm font-bold text-midnight">
          Item {index + 1}
          <span className="text-ink-400 ml-2 font-normal">
            · <span className="tabular-nums">{splitsTotal}</span> total
          </span>
        </h3>
        {removable && (
          <button type="button" onClick={onRemove} className="btn text-xs">Remove item</button>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <FormField label="Model" required>
          <input className="input" value={item.model}
                 onChange={(e) => onChange({ model: e.target.value })} />
        </FormField>
        <FormField label="Year" required>
          <input type="number" className="input" value={item.year}
                 onChange={(e) => onChange({ year: parseInt(e.target.value, 10) })} />
        </FormField>
        <FormField label="Buy-back (SAR)">
          <input type="number" className="input" value={item.buyBackRate ?? ""}
                 onChange={(e) => onChange({ buyBackRate: numberOrNull(e.target.value) })} />
        </FormField>
        <FormField label="Contract length">
          <input className="input" value={item.contractLength}
                 onChange={(e) => onChange({ contractLength: e.target.value })} />
        </FormField>
        <FormField label="Colors">
          <input className="input" value={item.colorsRaw}
                 onChange={(e) => onChange({ colorsRaw: e.target.value })} />
        </FormField>
        <FormField label="Unit price (SAR)">
          <input type="number" step="0.01" className="input" value={item.unitPriceSar ?? ""}
                 onChange={(e) => onChange({ unitPriceSar: numberOrNull(e.target.value) })} />
        </FormField>
        <FormField label="Tax %">
          <input type="number" className="input" value={item.taxPct ?? ""}
                 onChange={(e) => onChange({ taxPct: numberOrNull(e.target.value) })} />
        </FormField>
      </div>

      {/* Splits */}
      <div className="mt-4">
        <div className="flex items-baseline justify-between gap-3 mb-2">
          <h4 className="text-xs font-medium text-ink-600 uppercase tracking-wide">
            Delivery Splits
          </h4>
          <button type="button" onClick={onAddSplit} className="btn text-xs">+ Add split</button>
        </div>
        <p className="text-[0.7rem] text-ink-500 mb-2 leading-snug">
          <strong>PO Availability date</strong> 🔒 = the dealer-promised date from the PO.
          Fixed by partnership; used to measure <em>Partnership Confidence</em>.
          Cannot be edited here — amend the PO if it's wrong.{" "}
          <strong>Ops expected delivery</strong> = the operational commitment for when this split
          actually lands. Auto-set to <code className="text-midnight">max(PO date, today + {leadTimeDays}d)</code>{" "}
          so it always satisfies the Pre PO Ops Lead Time. Editable — used to measure <em>Ops Confidence</em>.
        </p>
        {/* Column headers (md+ only) */}
        <div className="hidden md:grid md:grid-cols-[5rem,1fr,9rem,9rem,5rem] gap-2 px-1 mb-1
                        text-[0.65rem] font-medium uppercase tracking-wide text-ink-500">
          <span>Qty</span>
          <span>City</span>
          <span>PO Availability date</span>
          <span>Ops expected delivery</span>
          <span></span>
        </div>
        <div className="space-y-3">
          {item.splits.map((s, j) => {
            const risk = splitRisks.find((r) => r.splitIndex === j);
            return (
              <div key={j}>
                <div className="grid grid-cols-1 md:grid-cols-[5rem,1fr,9rem,9rem,5rem] gap-2">
                  <input type="number" className="input" placeholder="Qty" value={s.quantity}
                         aria-label="Quantity"
                         onChange={(e) => onSplitChange(j, { quantity: parseInt(e.target.value, 10) || 0 })} />
                  <input className="input" placeholder="City" value={s.city}
                         aria-label="City"
                         onChange={(e) => onSplitChange(j, { city: e.target.value })} />
                  <input
                    type="date"
                    className="input bg-ink-50 text-midnight cursor-not-allowed"
                    value={s.date}
                    readOnly
                    aria-label="PO Availability date (locked — set by the PO)"
                    title="PO Availability date — fixed by partnership. Amend the PO to change."
                  />
                  <input type="date" className="input" value={s.opsExpectedDate}
                         aria-label="Ops expected delivery date"
                         onChange={(e) => onSplitChange(j, { opsExpectedDate: e.target.value })} />
                  <button type="button" onClick={() => onRemoveSplit(j)}
                          disabled={item.splits.length === 1}
                          className="btn text-xs">Remove</button>
                </div>
                {risk?.level === "behind" && (
                  <p className="text-[0.7rem] mt-1.5 px-2 py-1 rounded-md leading-snug
                                bg-gold-pale border border-gold text-midnight">
                    ⚠️ <strong>Ops ETA +{risk.behindDays}d past dealer promise</strong>
                    {" — "}
                    PO availability sits inside the {leadTimeDays}d Pre PO Ops Lead Time, so
                    Ops Expected was auto-floored to today + {leadTimeDays}d.
                    Adjust the Ops date if you have a tighter commitment.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Per-department column. Header has the department name + a count of
 * picked-vs-total actions, plus a stakeholder dropdown that scopes the
 * "who owns this work" choice once for every checked action below it.
 */
function ActionDepartmentColumn({
  deptId, deptName, actions, stakeholders, pickedStakeholderId,
  onPickStakeholder, picks, onToggle,
}: {
  deptId: number | null;
  deptName: string;
  actions: IntakeOptions["actionTypes"];
  stakeholders: IntakeOptions["departments"][number]["stakeholders"];
  pickedStakeholderId: number | null;
  onPickStakeholder: (id: number | null) => void;
  picks: ActionPick[];
  onToggle: (actionTypeId: number, selected: boolean) => void;
}) {
  const checkedCount = actions.reduce((n, t) => {
    const p = picks.find((x) => x.actionTypeId === t.id);
    return n + (p?.selected ? 1 : 0);
  }, 0);
  const isUnassigned = deptId == null;
  const noStakeholders = !isUnassigned && stakeholders.length === 0;

  return (
    <section
      aria-label={`Actions for ${deptName}`}
      className="flex flex-col"
    >
      <header className="mb-2">
        <div className="flex items-baseline gap-2">
          <h3 className={cn(
            "text-xs font-medium uppercase tracking-wide",
            isUnassigned ? "text-flame-dark" : "text-midnight",
          )}>
            {deptName}
          </h3>
          <span className="text-[0.7rem] text-ink-400 tabular-nums">
            ({checkedCount}/{actions.length})
          </span>
        </div>
        {/* Stakeholder dropdown — applies to every checked action in this column. */}
        {!isUnassigned && (
          stakeholders.length > 0 ? (
            <select
              className="input mt-1.5 py-1 text-xs"
              value={pickedStakeholderId ?? ""}
              onChange={(e) => onPickStakeholder(e.target.value ? parseInt(e.target.value, 10) : null)}
              aria-label={`Stakeholder for ${deptName}`}
            >
              <option value="">— pick stakeholder —</option>
              {stakeholders.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          ) : (
            <p className="text-[0.65rem] text-flame-dark mt-1.5 leading-snug">
              ⚠️ No stakeholders. Add one in
              <span className="font-medium"> Settings → Departments</span> to assign owners.
            </p>
          )
        )}
      </header>

      <ul className="space-y-1.5">
        {actions.map((t) => {
          const pick = picks.find((p) => p.actionTypeId === t.id)!;
          // If the column has stakeholders configured but Ops hasn't picked
          // one yet, allow the check (stakeholder remains null and the
          // action is created unassigned). The hint below the column makes
          // this visible.
          return (
            <li key={t.id}>
              <ActionCheckRow
                type={t}
                pick={pick}
                onToggle={(s) => onToggle(t.id, s)}
              />
            </li>
          );
        })}
      </ul>

      {checkedCount > 0 && !isUnassigned && stakeholders.length > 0 && pickedStakeholderId == null && (
        <p className="text-[0.65rem] text-flame-dark mt-2 leading-snug">
          ⚠️ Checked actions but no stakeholder picked — they&apos;ll be created unassigned.
        </p>
      )}
      {isUnassigned && (
        <p className="text-[0.65rem] text-flame-dark mt-2 leading-snug">
          ⚠️ These actions don&apos;t have a department.
          Set one in <span className="font-medium">Settings → Action Types</span> to
          route them automatically.
        </p>
      )}
      {noStakeholders && checkedCount > 0 && (
        <p className="text-[0.65rem] text-flame-dark mt-2 leading-snug">
          (No stakeholder will be assigned — fix in Settings then re-pick this column.)
        </p>
      )}
    </section>
  );
}

/**
 * A single action checkbox card. Shows the waiting label and, when this
 * action depends on others, a small "blocked → X, Y" hint so Ops know
 * the action will start blocked at creation.
 */
function ActionCheckRow({
  type, pick, onToggle,
}: {
  type: IntakeOptions["actionTypes"][number];
  pick: ActionPick;
  onToggle: (selected: boolean) => void;
}) {
  const startsBlocked = type.dependsOnNames.length > 0;
  return (
    <label
      className={cn(
        "flex items-start gap-2 cursor-pointer rounded-md border bg-white px-3 py-2",
        pick.selected ? "border-ink-200" : "border-ink-200 opacity-60",
      )}
    >
      <input
        type="checkbox"
        checked={pick.selected}
        onChange={(e) => onToggle(e.target.checked)}
        className="h-4 w-4 accent-brand mt-0.5 shrink-0"
      />
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium text-midnight">{type.waitingLabel}</span>
        {startsBlocked && (
          <p
            title={`Will start as Blocked. Unlocks when these parents are marked done: ${type.dependsOnNames.join(", ")}`}
            className="text-[0.65rem] uppercase tracking-wide font-medium text-ink-500 mt-0.5"
          >
            blocked → {type.dependsOnNames.join(", ")}
          </p>
        )}
      </div>
    </label>
  );
}

function SuccessPanel({
  summary, onAnother,
}: {
  summary: SubmitSummary;
  onAnother: () => void;
}) {
  return (
    <div className="card">
      <h2 className="text-lg font-bold text-green-dark mb-1">
        ✅ Created {summary.created.length} batch{summary.created.length === 1 ? "" : "es"}
      </h2>
      <p className="text-sm text-ink-500 mb-4">
        Each batch is now visible in the Dashboard and the Cockpit.
        Mark its actions as Ops makes progress.
      </p>
      <div className="space-y-2 mb-5">
        {summary.created.map((b) => (
          <div key={b.id} className="flex items-baseline gap-3 text-sm">
            <code className="font-mono text-midnight font-medium">{b.batchCode}</code>
            <span className="text-ink-400" aria-hidden="true">·</span>
            <span className="text-midnight">{b.modelYear}</span>
            <span className="text-ink-400" aria-hidden="true">·</span>
            <span className="tabular-nums text-midnight">{b.quantity}</span>
            <span className="text-ink-500">cars in</span>
            <span className="text-midnight">{b.city}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <a href="/cockpit" className="btn btn-primary">Open Cockpit</a>
        <a href="/dashboard" className="btn">View Dashboard</a>
        <button type="button" onClick={onAnother} className="btn">+ Submit another PO</button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

function numberOrNull(s: string): number | null {
  if (!s.trim()) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function countSummary(items: ItemDraft[], actions: ActionPick[]): string {
  const itemCount = items.length;
  const splitCount = items.reduce((a, it) => a + it.splits.length, 0);
  const totalQty = items.reduce(
    (a, it) => a + it.splits.reduce((b, s) => b + (Number(s.quantity) || 0), 0),
    0,
  );
  const actionCount = actions.filter((a) => a.selected).length;
  return `Will create ${splitCount} batch${splitCount === 1 ? "" : "es"}` +
         ` (${itemCount} item${itemCount === 1 ? "" : "s"} × ${totalQty} cars total)` +
         ` with ${actionCount} action${actionCount === 1 ? "" : "s"} each.`;
}
