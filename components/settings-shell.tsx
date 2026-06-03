"use client";

/**
 * Settings page — five collapsible editors, all collapsed by default:
 *
 *   1. Departments        (CRUD + inline stakeholders)
 *   2. Action Types       (CRUD + per-row dependency editor)
 *   3. Rules              (single tunable: Pre PO Ops Lead Time days)
 *   4. Users              (CRUD + password reset; self-actions guarded)
 *   5. Batches            (admin override, in settings-batches.tsx)
 *
 * Mutations all flow through the consolidated `/api/settings` endpoint;
 * after each successful mutation we router.refresh() so the server-rendered
 * page re-fetches the canonical state.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { SettingsData, SettingsUser, AlertRuleSetting } from "@/lib/settings-data";
import SettingsBatches from "./settings-batches";
import MaintenancePanel from "./settings-maintenance";
import { cn } from "@/lib/utils";

interface Props {
  data: SettingsData;
  /**
   * Numeric id of the currently signed-in admin. Used to disable
   * self-destructive actions in the Users editor (delete self, demote
   * self). Server enforces the same checks; this is purely UX.
   */
  currentUserId: number | null;
}

export default function SettingsShell({ data, currentUserId }: Props) {
  return (
    <div className="space-y-3">
      <DepartmentsEditor data={data} />
      <ActionTypesEditor data={data} />
      <VinChaseStagesEditor data={data} />
      <RulesEditor data={data} />
      <AlertRulesEditor data={data} />
      <UsersEditor users={data.users} currentUserId={currentUserId} />
      <SettingsBatches data={data} />
      <MaintenancePanel />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// CollapsibleCard — shared shell for each Settings section.
// All sections collapse by default; click the header to expand.
// ──────────────────────────────────────────────────────────────────

export function CollapsibleCard({
  title, description, defaultCollapsed = true, children,
}: {
  title: string;
  description?: string;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  return (
    <div className="card p-0 overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        className={cn(
          "w-full text-left px-4 py-3 flex items-center justify-between gap-3",
          "hover:bg-ink-50 transition-colors outline-none",
          "focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-[-2px]",
        )}
      >
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-midnight">{title}</h2>
          {description && (
            <p className="text-xs text-ink-500 mt-0.5">{description}</p>
          )}
        </div>
        <span
          aria-hidden="true"
          className={cn(
            "text-ink-500 text-sm shrink-0 transition-transform duration-200",
            !collapsed && "rotate-90",
          )}
        >
          ▸
        </span>
      </button>
      {!collapsed && (
        <div className="px-4 py-4 border-t border-ink-200">
          {children}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Shared API helper
// ──────────────────────────────────────────────────────────────────

async function callApi(body: unknown): Promise<void> {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Prefer the JSON `error` field when the server returns one — keeps
    // raw {"error":"…","nonWaitingCount":3,…} payloads from leaking into
    // the editor's red banner. Falls back to plain text for non-JSON
    // responses (rare; usually crash pages).
    const text = await res.text();
    let message = text || `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.error === "string") message = parsed.error;
    } catch { /* not JSON — keep the raw text */ }
    throw new Error(message);
  }
}

// ──────────────────────────────────────────────────────────────────
// 1 · Departments
// ──────────────────────────────────────────────────────────────────

function DepartmentsEditor({ data }: { data: SettingsData }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Per-row name draft (sortOrder is handled by the up/down arrow
  // buttons; no draft state required for it).
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [newName, setNewName] = useState("");

  function refresh() { router.refresh(); }

  function run(promise: Promise<void>) {
    startTransition(async () => {
      try { await promise; refresh(); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    });
  }

  /**
   * Move a department up or down. Renumbers every department to 1..N
   * in the new display order — N parallel updates. This is dumber than
   * a two-row swap, but a swap is a silent no-op when neighbours have
   * the same sort_order (a tie), which is how Partnership + Pricing
   * both ended up at 0 historically. Renumbering eliminates ties as a
   * side effect; values are guaranteed unique 1..N after every move.
   */
  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= data.departments.length) return;
    const next = [...data.departments];
    [next[index], next[target]] = [next[target], next[index]];
    run((async () => {
      await Promise.all(next.map((d, i) =>
        callApi({ resource: "department", op: "update", id: d.id, sortOrder: i + 1 }),
      ));
    })());
  }

  return (
    <CollapsibleCard
      title="Departments"
      description="Stakeholder groups that get assigned to actions. Add stakeholders inside each department — Ops picks one of them at Intake to own the work. Use ▲/▼ to reorder; the number between the arrows is the current sort_order value."
    >
      {/* Two-column grid on xl+ screens — was a vertical stack. The
          inline stakeholders editor inside each card keeps working as
          before; cards expand vertically to fit their stakeholder list. */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {data.departments.map((d, idx) => {
          const draftName = drafts[d.id] ?? d.name;
          const dirty = draftName !== d.name;
          const isFirst = idx === 0;
          const isLast  = idx === data.departments.length - 1;
          return (
            <div key={d.id} className="border border-ink-200 rounded-md p-3 bg-white">
              {/* Department header row */}
              <div className="grid grid-cols-1 md:grid-cols-[auto,1fr,auto] gap-3 items-end">
                {/* Reorder + position column — ▲ / current sort_order / ▼. */}
                <div className="flex flex-col items-center gap-0.5">
                  <button
                    type="button"
                    disabled={isFirst || pending}
                    className="btn text-xs px-2 py-0.5"
                    onClick={() => move(idx, -1)}
                    aria-label={`Move ${d.name} up`}
                    title="Move up"
                  >▲</button>
                  <span
                    className="text-[0.65rem] font-medium text-ink-500 tabular-nums leading-none px-1 py-0.5"
                    title={`Current sort_order: ${d.sortOrder}`}
                    aria-label={`Sort position ${d.sortOrder}`}
                  >
                    {d.sortOrder}
                  </span>
                  <button
                    type="button"
                    disabled={isLast || pending}
                    className="btn text-xs px-2 py-0.5"
                    onClick={() => move(idx, 1)}
                    aria-label={`Move ${d.name} down`}
                    title="Move down"
                  >▼</button>
                </div>
                <label className="block">
                  <span className="block text-xs font-medium text-ink-600 mb-1">Name</span>
                  <input
                    className="input"
                    value={draftName}
                    onChange={(e) => setDrafts((s) => ({ ...s, [d.id]: e.target.value }))}
                  />
                </label>
                <div className="inline-flex gap-1.5">
                  <button
                    type="button"
                    disabled={!dirty || pending}
                    className="btn btn-primary text-xs"
                    onClick={() => run((async () => {
                      await callApi({
                        resource: "department", op: "update",
                        id: d.id, name: draftName.trim(),
                      });
                      setDrafts((s) => { const n = { ...s }; delete n[d.id]; return n; });
                    })())}
                  >Save</button>
                  <button
                    type="button"
                    disabled={pending}
                    className="btn text-xs"
                    onClick={() => {
                      if (!confirm(`Delete department "${d.name}"? Its stakeholders will be removed and any actions assigned to it become unassigned.`)) return;
                      run(callApi({ resource: "department", op: "delete", id: d.id }));
                    }}
                  >Delete</button>
                </div>
              </div>

              {/* Stakeholders sub-section */}
              <StakeholdersInline
                departmentId={d.id}
                stakeholders={d.stakeholders}
                onChanged={refresh}
              />
            </div>
          );
        })}
        {data.departments.length === 0 && (
          <p className="text-sm text-ink-500 text-center py-6 col-span-full">No departments yet.</p>
        )}
      </div>

      {/* Add new */}
      <div className="mt-3 flex gap-2 items-end">
        <label className="block flex-1">
          <span className="block text-xs font-medium text-ink-600 mb-1">Add department</span>
          <input
            className="input"
            value={newName}
            placeholder="e.g. Finance"
            onChange={(e) => setNewName(e.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={!newName.trim() || pending}
          className="btn btn-primary"
          onClick={() => run((async () => {
            await callApi({
              resource: "department", op: "create",
              name: newName.trim(),
              sortOrder: (data.departments.at(-1)?.sortOrder ?? 0) + 1,
            });
            setNewName("");
          })())}
        >+ Add</button>
      </div>

      {error && <p className="mt-3 text-sm text-flame-dark" role="alert">{error}</p>}
    </CollapsibleCard>
  );
}

/**
 * Inline stakeholder editor — renders inside a department card.
 * Shows existing stakeholders as removable chips + an "Add" form.
 */
function StakeholdersInline({
  departmentId, stakeholders, onChanged,
}: {
  departmentId: number;
  stakeholders: SettingsData["departments"][number]["stakeholders"];
  onChanged: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Track per-stakeholder name draft so admin can edit existing ones in place.
  const [drafts, setDrafts] = useState<Record<number, string>>({});

  function run(promise: Promise<void>) {
    startTransition(async () => {
      try { await promise; setError(null); onChanged(); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    });
  }

  return (
    <div className="mt-3 pt-3 border-t border-ink-200">
      <p className="text-[0.7rem] font-medium text-ink-600 uppercase tracking-wide mb-2">
        Stakeholders
      </p>

      {stakeholders.length === 0 ? (
        <p className="text-xs text-ink-500 italic mb-2">
          No stakeholders yet — add at least one so Ops can assign actions to a person.
        </p>
      ) : (
        <ul className="space-y-1.5 mb-2">
          {stakeholders.map((s) => {
            const draftName = drafts[s.id] ?? s.name;
            const dirty = draftName !== s.name;
            return (
              <li key={s.id} className="flex items-center gap-2">
                <input
                  className="input flex-1 max-w-[20rem] py-1 text-sm"
                  value={draftName}
                  onChange={(e) => setDrafts((d) => ({ ...d, [s.id]: e.target.value }))}
                  aria-label={`Stakeholder name`}
                />
                <button
                  type="button"
                  disabled={!dirty || pending}
                  className="btn btn-primary text-xs"
                  onClick={() => run((async () => {
                    await callApi({
                      resource: "stakeholder", op: "update",
                      id: s.id, name: draftName.trim(),
                    });
                    setDrafts((d) => { const n = { ...d }; delete n[s.id]; return n; });
                  })())}
                >Save</button>
                <button
                  type="button"
                  disabled={pending}
                  className="btn text-xs"
                  onClick={() => {
                    if (!confirm(`Remove stakeholder "${s.name}"? Any actions currently assigned to them will become unassigned.`)) return;
                    run(callApi({ resource: "stakeholder", op: "delete", id: s.id }));
                  }}
                >Remove</button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex items-end gap-2">
        <input
          className="input flex-1 max-w-[20rem] py-1 text-sm"
          value={adding}
          placeholder="Add stakeholder name…"
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && adding.trim()) {
              e.preventDefault();
              run((async () => {
                await callApi({
                  resource: "stakeholder", op: "create",
                  departmentId,
                  name: adding.trim(),
                  sortOrder: (stakeholders.at(-1)?.sortOrder ?? 0) + 1,
                });
                setAdding("");
              })());
            }
          }}
        />
        <button
          type="button"
          disabled={!adding.trim() || pending}
          className="btn text-xs"
          onClick={() => run((async () => {
            await callApi({
              resource: "stakeholder", op: "create",
              departmentId,
              name: adding.trim(),
              sortOrder: (stakeholders.at(-1)?.sortOrder ?? 0) + 1,
            });
            setAdding("");
          })())}
        >+ Add</button>
      </div>

      {error && <p className="mt-2 text-xs text-flame-dark" role="alert">{error}</p>}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// 2 · Action Types (with per-row dependency editor)
// ──────────────────────────────────────────────────────────────────

function ActionTypesEditor({ data }: { data: SettingsData }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  type Draft = {
    name: string;
    waitingLabel: string;
    doneLabel: string;
    defaultDepartmentId: number | null;
    slaHours: number | null;
  };
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [creating, setCreating] = useState<Draft>({
    name: "", waitingLabel: "", doneLabel: "",
    defaultDepartmentId: null, slaHours: null,
  });

  function getDraft(id: number, fallback: Draft) { return drafts[id] ?? fallback; }
  function setDraft(id: number, patch: Partial<Draft>) {
    setDrafts((d) => ({ ...d, [id]: { ...getDraft(id, fallbackForId(id)), ...patch } }));
  }
  function fallbackForId(id: number): Draft {
    const t = data.actionTypes.find((x) => x.id === id);
    return {
      name: t?.name ?? "",
      waitingLabel: t?.waitingLabel ?? "",
      doneLabel: t?.doneLabel ?? "",
      defaultDepartmentId: t?.defaultDepartmentId ?? null,
      slaHours: t?.slaHours ?? null,
    };
  }
  function clearDraft(id: number) {
    setDrafts((d) => { const next = { ...d }; delete next[id]; return next; });
  }
  function refresh() { router.refresh(); }
  function run(promise: Promise<void>) {
    startTransition(async () => {
      try { await promise; refresh(); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    });
  }

  /**
   * Move an action type up or down. Renumbers every action type to
   * 1..N in the new display order — N parallel updates. A two-row
   * swap is a silent no-op when neighbours share the same sort_order
   * (a tie), so we renumber every move to guarantee uniqueness 1..N.
   * Matches the DepartmentsEditor implementation.
   */
  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= data.actionTypes.length) return;
    const next = [...data.actionTypes];
    [next[index], next[target]] = [next[target], next[index]];
    run((async () => {
      await Promise.all(next.map((t, i) =>
        callApi({ resource: "action-type", op: "update", id: t.id, sortOrder: i + 1 }),
      ));
    })());
  }

  return (
    <CollapsibleCard
      title="Action Types"
      description="The master catalog Ops picks from at Intake. Each action has a default department, two display labels (waiting / done), and optional dependencies on other actions. Use ▲/▼ to reorder; the number between the arrows is the current sort_order. Cards lay out two-per-row on wide screens."
    >
      {/* Two-column grid on wide screens — was a vertical stack of full-width rows. */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {data.actionTypes.map((t, idx) => {
          const fb = fallbackForId(t.id);
          const draft = getDraft(t.id, fb);
          const dirty = JSON.stringify(draft) !== JSON.stringify(fb);
          const isFirst = idx === 0;
          const isLast  = idx === data.actionTypes.length - 1;
          // The canonical batch-closing action. Hard-referenced by name
          // in /api/batch-close, /api/batch-action's auto-close cascade,
          // and the dashboard timeline — renaming or deleting it would
          // silently break batch closure. So we lock the Name input +
          // Delete button on this row. Labels, department, sort order,
          // and dependencies stay freely editable.
          const isClosingAction = t.name === "Delivery";
          // If admin tampered with the name in the draft, drop the
          // attempted change when computing "dirty" so the Save button
          // doesn't enable from a no-op rename attempt on a locked row.
          const effectiveDraft = isClosingAction
            ? { ...draft, name: t.name }
            : draft;
          const effectiveDirty = JSON.stringify(effectiveDraft) !== JSON.stringify(fb);
          return (
            <div key={t.id} className="border border-ink-200 rounded-md p-3 bg-white flex flex-col gap-3">
              {/* Header: reorder arrows + sort_order · name · save/delete */}
              <div className="grid grid-cols-[auto,1fr,auto] gap-2 items-end">
                <div className="flex flex-col items-center gap-0.5">
                  <button
                    type="button"
                    disabled={isFirst || pending}
                    className="btn text-xs px-2 py-0.5"
                    onClick={() => move(idx, -1)}
                    aria-label={`Move ${t.name} up`}
                    title="Move up"
                  >▲</button>
                  <span
                    className="text-[0.65rem] font-medium text-ink-500 tabular-nums leading-none px-1 py-0.5"
                    title={`Current sort_order: ${t.sortOrder}`}
                    aria-label={`Sort position ${t.sortOrder}`}
                  >
                    {t.sortOrder}
                  </span>
                  <button
                    type="button"
                    disabled={isLast || pending}
                    className="btn text-xs px-2 py-0.5"
                    onClick={() => move(idx, 1)}
                    aria-label={`Move ${t.name} down`}
                    title="Move down"
                  >▼</button>
                </div>
                <Field label={
                  isClosingAction
                    ? <span className="inline-flex items-center gap-1.5">
                        <span>Name</span>
                        <span className="text-[0.6rem] uppercase tracking-wide font-semibold text-green-dark
                                         bg-green-pale border border-green/40 rounded-sm px-1.5 py-0.5"
                              title="This action_type is hard-referenced by name across batch-close logic. Renaming it would break batch closure.">
                          🔒 Closes the batch
                        </span>
                      </span>
                    : "Name"
                }>
                  <input className="input"
                         value={draft.name}
                         readOnly={isClosingAction}
                         aria-readonly={isClosingAction || undefined}
                         title={isClosingAction
                           ? "Name is locked — this row is the canonical batch-closing action. Labels and other fields are still editable."
                           : undefined}
                         onChange={(e) => setDraft(t.id, { name: e.target.value })} />
                </Field>
                <div className="inline-flex gap-1.5 self-end">
                  <button
                    type="button"
                    disabled={!effectiveDirty || pending}
                    className="btn btn-primary text-xs"
                    onClick={() => run((async () => {
                      await callApi({
                        resource: "action-type", op: "update",
                        id: t.id,
                        // Submit the locked name verbatim — server-side
                        // guard would refuse a rename anyway, but
                        // sending the canonical value avoids a 409.
                        name: isClosingAction ? t.name : draft.name.trim(),
                        waitingLabel: draft.waitingLabel.trim(),
                        doneLabel: draft.doneLabel.trim(),
                        defaultDepartmentId: draft.defaultDepartmentId,
                        slaHours: draft.slaHours,
                      });
                      clearDraft(t.id);
                    })())}
                  >Save</button>
                  <button
                    type="button"
                    disabled={pending || isClosingAction}
                    className="btn text-xs"
                    title={isClosingAction
                      ? "Cannot delete — this is the canonical batch-closing action."
                      : undefined}
                    onClick={() => {
                      if (isClosingAction) return;
                      if (!confirm(`Delete action type "${t.name}"?`)) return;
                      run(callApi({ resource: "action-type", op: "delete", id: t.id }));
                    }}
                  >Delete</button>
                </div>
              </div>

              {/* Labels — two side-by-side */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Waiting label">
                  <input className="input"
                         value={draft.waitingLabel}
                         onChange={(e) => setDraft(t.id, { waitingLabel: e.target.value })} />
                </Field>
                <Field label="Done label">
                  <input className="input"
                         value={draft.doneLabel}
                         onChange={(e) => setDraft(t.id, { doneLabel: e.target.value })} />
                </Field>
              </div>

              {/* Default department + SLA — side by side */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Default department">
                  <select className="input"
                          value={draft.defaultDepartmentId ?? ""}
                          onChange={(e) => setDraft(t.id, {
                            defaultDepartmentId: e.target.value ? parseInt(e.target.value, 10) : null,
                          })}>
                    <option value="">— none —</option>
                    {data.departments.map((d) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                </Field>
                <Field label="SLA (hours)">
                  <input className="input" type="number" min={1} step={1}
                         placeholder="no SLA"
                         value={draft.slaHours ?? ""}
                         onChange={(e) => setDraft(t.id, {
                           slaHours: e.target.value ? Math.max(1, parseInt(e.target.value, 10) || 0) || null : null,
                         })} />
                  <SlaHint hours={draft.slaHours} />
                </Field>
              </div>

              {/* Dependencies */}
              <DependencyEditor
                actionTypeId={t.id}
                allTypes={data.actionTypes}
                currentParentIds={t.dependsOnIds}
                onChanged={refresh}
              />
            </div>
          );
        })}
      </div>

      {/* Add new action type */}
      <div className="mt-5 border-t border-ink-200 pt-4">
        <p className="text-xs font-medium text-ink-600 mb-2 uppercase tracking-wide">
          Add new action type
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Name">
            <input className="input" placeholder="e.g. Inspection"
                   value={creating.name}
                   onChange={(e) => setCreating((c) => ({ ...c, name: e.target.value }))} />
          </Field>
          <Field label="Default department">
            <select className="input"
                    value={creating.defaultDepartmentId ?? ""}
                    onChange={(e) => setCreating((c) => ({
                      ...c, defaultDepartmentId: e.target.value ? parseInt(e.target.value, 10) : null,
                    }))}>
              <option value="">— none —</option>
              {data.departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Waiting label">
            <input className="input" placeholder="Waiting Inspection"
                   value={creating.waitingLabel}
                   onChange={(e) => setCreating((c) => ({ ...c, waitingLabel: e.target.value }))} />
          </Field>
          <Field label="Done label">
            <input className="input" placeholder="Inspection Done"
                   value={creating.doneLabel}
                   onChange={(e) => setCreating((c) => ({ ...c, doneLabel: e.target.value }))} />
          </Field>
          <Field label="SLA (hours)">
            <input className="input" type="number" min={1} step={1} placeholder="no SLA"
                   value={creating.slaHours ?? ""}
                   onChange={(e) => setCreating((c) => ({
                     ...c,
                     slaHours: e.target.value ? Math.max(1, parseInt(e.target.value, 10) || 0) || null : null,
                   }))} />
            <SlaHint hours={creating.slaHours} />
          </Field>
        </div>
        <div className="flex justify-end mt-3">
          <button
            type="button"
            disabled={pending || !creating.name.trim() || !creating.waitingLabel.trim() || !creating.doneLabel.trim()}
            className="btn btn-primary"
            onClick={() => run((async () => {
              // New action types land at the end of the order. Sort
              // adjustments happen post-create via the ▲/▼ arrows.
              const nextSort = (data.actionTypes.at(-1)?.sortOrder ?? 0) + 1;
              await callApi({
                resource: "action-type", op: "create",
                name: creating.name.trim(),
                waitingLabel: creating.waitingLabel.trim(),
                doneLabel: creating.doneLabel.trim(),
                defaultDepartmentId: creating.defaultDepartmentId,
                sortOrder: nextSort,
                slaHours: creating.slaHours,
              });
              setCreating({
                name: "", waitingLabel: "", doneLabel: "",
                defaultDepartmentId: null, slaHours: null,
              });
            })())}
          >+ Add action type</button>
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-flame-dark" role="alert">{error}</p>}
    </CollapsibleCard>
  );
}

/**
 * Tiny helper under the SLA-hours input: shows the day/hour equivalent
 * of a whole-hour budget, or an "exempt" note when there's no SLA.
 */
function SlaHint({ hours }: { hours: number | null }) {
  if (hours == null || hours <= 0) {
    return <span className="mt-1 block text-[0.65rem] text-ink-400">No SLA — exempt from the countdown</span>;
  }
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  return (
    <span className="mt-1 block text-[0.65rem] text-ink-500 tabular-nums">
      = {parts.join(" ") || `${hours}h`} countdown
    </span>
  );
}

function DependencyEditor({
  actionTypeId, allTypes, currentParentIds, onChanged,
}: {
  actionTypeId: number;
  allTypes: SettingsData["actionTypes"];
  currentParentIds: number[];
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState<number | "">("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const eligibleParents = allTypes.filter(
    (t) => t.id !== actionTypeId && !currentParentIds.includes(t.id),
  );

  function run(promise: Promise<void>) {
    startTransition(async () => {
      try { await promise; setError(null); onChanged(); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    });
  }

  return (
    <div className="mt-3 pt-3 border-t border-ink-200">
      <p className="text-[0.7rem] font-medium text-ink-600 uppercase tracking-wide mb-2">
        Depends on
      </p>
      <div className="flex flex-wrap gap-1.5 items-center">
        {currentParentIds.length === 0 && (
          <span className="text-xs text-ink-500 italic">No dependencies — starts as Waiting on creation.</span>
        )}
        {currentParentIds.map((pid) => {
          const parent = allTypes.find((t) => t.id === pid);
          if (!parent) return null;
          return (
            <span
              key={pid}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md
                         text-xs font-medium bg-ink-100 text-midnight border border-ink-200"
            >
              {parent.name}
              <button
                type="button"
                disabled={pending}
                aria-label={`Remove dependency on ${parent.name}`}
                className="hover:text-flame-dark text-ink-400"
                onClick={() => run(
                  // call dependency remove
                  (async () => {
                    await callApi({
                      resource: "dependency", op: "remove",
                      actionTypeId, dependsOnActionTypeId: pid,
                    });
                  })(),
                )}
              >×</button>
            </span>
          );
        })}
        {eligibleParents.length > 0 && (
          <>
            <select
              className="input max-w-[12rem] py-1 text-xs"
              value={adding === "" ? "" : adding}
              onChange={(e) => setAdding(e.target.value ? parseInt(e.target.value, 10) : "")}
            >
              <option value="">+ Add parent…</option>
              {eligibleParents.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <button
              type="button"
              disabled={!adding || pending}
              className="btn text-xs"
              onClick={() => run((async () => {
                if (!adding) return;
                await callApi({
                  resource: "dependency", op: "add",
                  actionTypeId, dependsOnActionTypeId: adding as number,
                });
                setAdding("");
              })())}
            >Add</button>
          </>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-flame-dark" role="alert">{error}</p>}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// 3 · Rules
// ──────────────────────────────────────────────────────────────────

function RulesEditor({ data }: { data: SettingsData }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [leadTime, setLeadTime] = useState<number>(data.rules.prePoOpsLeadTimeDays);
  const [error, setError] = useState<string | null>(null);
  const [savedNow, setSavedNow] = useState(false);

  const dirty = leadTime !== data.rules.prePoOpsLeadTimeDays;

  function save() {
    startTransition(async () => {
      try {
        await callApi({
          resource: "rule", op: "set",
          key: "pre_po_ops_lead_time_days", value: leadTime,
        });
        setSavedNow(true);
        setTimeout(() => setSavedNow(false), 1400);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <CollapsibleCard
      title="Rules"
      description="System-wide tunables. Changes apply immediately for new batches."
    >
      <div className="grid grid-cols-1 md:grid-cols-[12rem,1fr,auto] gap-3 items-end">
        <Field label="Pre PO Ops Lead Time (days)">
          <input
            type="number" min={1} max={365}
            className="input tabular-nums"
            value={leadTime}
            onChange={(e) => setLeadTime(parseInt(e.target.value, 10) || 0)}
          />
        </Field>
        <p className="text-xs text-ink-500 leading-snug pb-2">
          The number of days Operations needs after a PO is signed to deliver. Drives the
          per-batch <code className="text-midnight">target_po_date</code> = promised − this value.
        </p>
        <button
          type="button"
          disabled={!dirty || pending}
          className="btn btn-primary"
          onClick={save}
        >
          {savedNow ? "✓ Saved" : pending ? "Saving…" : "Save"}
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-flame-dark" role="alert">{error}</p>}
    </CollapsibleCard>
  );
}

// ──────────────────────────────────────────────────────────────────
// 4 · Alert Rules
// ──────────────────────────────────────────────────────────────────

const TRIGGER_LABELS: Record<AlertRuleSetting["triggerType"], string> = {
  no_vin_before_avail:          "VIN not received before availability date",
  action_overdue:               "Any action is overdue (past expected date)",
  action_pending_before_avail:  "Specific action not done before availability date",
  listing_overdue:              "Batch not listed in the app within N days of PO submission",
};

const SEVERITY_OPTIONS: { value: AlertRuleSetting["severity"]; label: string }[] = [
  { value: "critical", label: "🚨 Critical" },
  { value: "high",     label: "⚠️ High" },
  { value: "medium",   label: "⚡ Medium" },
  { value: "info",     label: "ℹ️ Info" },
];

function AlertRulesEditor({ data }: { data: SettingsData }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  type NewRule = {
    name: string;
    triggerType: AlertRuleSetting["triggerType"];
    thresholdDays: number;
    actionTypeId: number | null;
    severity: AlertRuleSetting["severity"];
  };

  const [creating, setCreating] = useState<NewRule>({
    name: "",
    triggerType: "no_vin_before_avail",
    thresholdDays: 7,
    actionTypeId: null,
    severity: "high",
  });

  function refresh() { router.refresh(); }
  function run(promise: Promise<void>) {
    startTransition(async () => {
      try { await promise; setError(null); refresh(); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    });
  }

  return (
    <CollapsibleCard
      title="Alert Rules"
      description="Configure when the Action Center alert engine fires. Each rule evaluates all open batches on every Action Center page load. Alerts auto-resolve when conditions clear."
    >
      {/* Existing rules */}
      {data.alertRules.length === 0 ? (
        <p className="text-sm text-ink-500 italic mb-4">
          No alert rules configured — add one below to start receiving alerts in the Action Center.
        </p>
      ) : (
        <div className="space-y-2 mb-5">
          {data.alertRules.map((rule) => (
            <AlertRuleRow
              key={rule.id}
              rule={rule}
              actionTypes={data.actionTypes}
              onChanged={refresh}
            />
          ))}
        </div>
      )}

      {/* Create new rule */}
      <div className="border-t border-ink-200 pt-4">
        <p className="text-xs font-medium text-ink-600 mb-3 uppercase tracking-wide">
          Add new alert rule
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Rule name">
            <input
              className="input"
              placeholder="e.g. VIN overdue — 7 days warning"
              value={creating.name}
              onChange={(e) => setCreating((c) => ({ ...c, name: e.target.value }))}
            />
          </Field>
          <Field label="Trigger">
            <select
              className="input"
              value={creating.triggerType}
              onChange={(e) => setCreating((c) => ({
                ...c,
                triggerType: e.target.value as AlertRuleSetting["triggerType"],
                actionTypeId: null,
              }))}
            >
              {(Object.entries(TRIGGER_LABELS) as [AlertRuleSetting["triggerType"], string][]).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </Field>
          {creating.triggerType !== "action_overdue" && (
            <Field
              label={
                creating.triggerType === "listing_overdue"
                  ? "Threshold (days since PO submission)"
                  : "Threshold (days before availability date)"
              }
            >
              <input
                type="number"
                min={0}
                max={365}
                className="input tabular-nums"
                value={creating.thresholdDays}
                onChange={(e) => setCreating((c) => ({ ...c, thresholdDays: parseInt(e.target.value, 10) || 0 }))}
              />
            </Field>
          )}
          {creating.triggerType === "action_pending_before_avail" && (
            <Field label="Target action type">
              <select
                className="input"
                value={creating.actionTypeId ?? ""}
                onChange={(e) => setCreating((c) => ({
                  ...c,
                  actionTypeId: e.target.value ? parseInt(e.target.value, 10) : null,
                }))}
              >
                <option value="">— pick an action —</option>
                {data.actionTypes.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Severity">
            <select
              className="input"
              value={creating.severity}
              onChange={(e) => setCreating((c) => ({ ...c, severity: e.target.value as AlertRuleSetting["severity"] }))}
            >
              {SEVERITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="flex justify-end mt-3">
          <button
            type="button"
            disabled={pending || !creating.name.trim() || (creating.triggerType === "action_pending_before_avail" && !creating.actionTypeId)}
            className="btn btn-primary"
            onClick={() => run((async () => {
              await callApi({
                resource: "alert-rule",
                op: "create",
                name:          creating.name.trim(),
                triggerType:   creating.triggerType,
                thresholdDays: creating.thresholdDays,
                actionTypeId:  creating.actionTypeId,
                severity:      creating.severity,
              });
              setCreating({ name: "", triggerType: "no_vin_before_avail", thresholdDays: 7, actionTypeId: null, severity: "high" });
            })())}
          >
            + Add rule
          </button>
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-flame-dark" role="alert">{error}</p>}
    </CollapsibleCard>
  );
}

function AlertRuleRow({
  rule, actionTypes, onChanged,
}: {
  rule: AlertRuleSetting;
  actionTypes: SettingsData["actionTypes"];
  onChanged: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(promise: Promise<void>) {
    startTransition(async () => {
      try { await promise; setError(null); onChanged(); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    });
  }

  const severityColor =
    rule.severity === "critical" ? "text-flame-dark bg-flame-pale border-flame"
    : rule.severity === "high"   ? "text-gold-dark bg-gold-pale/60 border-gold/60"
    : rule.severity === "medium" ? "text-gold-dark bg-gold-pale border-gold"
    :                               "text-ink-600 bg-ink-100 border-ink-200";

  return (
    <div className={`border rounded-md px-3 py-2.5 flex flex-wrap items-center gap-3 ${rule.isActive ? "bg-white" : "bg-ink-50 opacity-70"}`}>
      <div className="flex-1 min-w-[12rem]">
        <p className="text-sm font-medium text-midnight">{rule.name}</p>
        <p className="text-[0.7rem] text-ink-500 mt-0.5">
          {TRIGGER_LABELS[rule.triggerType]}
          {rule.triggerType !== "action_overdue" && (
            <> · <span className="tabular-nums font-medium text-midnight">{rule.thresholdDays}d</span> threshold</>
          )}
          {rule.actionTypeName && (
            <> · target: <span className="font-medium text-midnight">{rule.actionTypeName}</span></>
          )}
        </p>
      </div>
      <span className={`inline-block px-2 py-0.5 rounded-md text-[0.7rem] font-medium border ${severityColor}`}>
        {SEVERITY_OPTIONS.find((o) => o.value === rule.severity)?.label ?? rule.severity}
      </span>
      <button
        type="button"
        disabled={pending}
        className="btn text-xs"
        onClick={() => run(callApi({
          resource: "alert-rule",
          op: "update",
          id: rule.id,
          isActive: !rule.isActive,
        }))}
        title={rule.isActive ? "Pause this rule" : "Activate this rule"}
      >
        {rule.isActive ? "⏸ Pause" : "▶ Activate"}
      </button>
      <button
        type="button"
        disabled={pending}
        className="btn text-xs"
        onClick={() => {
          if (!confirm(`Delete alert rule "${rule.name}"? Existing alerts from this rule will remain until resolved.`)) return;
          run(callApi({ resource: "alert-rule", op: "delete", id: rule.id }));
        }}
      >
        Delete
      </button>
      {error && <p className="w-full text-xs text-flame-dark" role="alert">{error}</p>}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// 5 · Users (accounts + roles + passwords)
// ──────────────────────────────────────────────────────────────────

const MIN_PASSWORD_LENGTH = 8;

function UsersEditor({
  users, currentUserId,
}: {
  users: SettingsUser[];
  currentUserId: number | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Per-row metadata drafts (username/name/email/role).
  type Draft = { username: string; name: string; email: string; role: "admin" | "ops" };
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  // Per-row password-reset drafts. Empty / undefined when the panel
  // isn't expanded for that row.
  const [pwDrafts, setPwDrafts] = useState<Record<number, string>>({});
  // Which rows have the reset-password panel open.
  const [pwOpen, setPwOpen] = useState<Record<number, boolean>>({});

  // New-user form state.
  const [creating, setCreating] = useState<Draft & { password: string }>({
    username: "", name: "", email: "", role: "ops", password: "",
  });

  // Last admin? Used to disable the "demote self" / "delete last admin"
  // controls in the UI; server enforces the same.
  const adminCount = users.filter((u) => u.role === "admin").length;

  function fallbackFor(u: SettingsUser): Draft {
    return {
      username: u.username,
      name:     u.name  ?? "",
      email:    u.email ?? "",
      role:     u.role,
    };
  }
  function getDraft(u: SettingsUser): Draft {
    return drafts[u.id] ?? fallbackFor(u);
  }
  function setDraft(id: number, patch: Partial<Draft>) {
    setDrafts((d) => ({ ...d, [id]: { ...(d[id] ?? fallbackFor(users.find((x) => x.id === id)!)), ...patch } }));
  }
  function clearDraft(id: number) {
    setDrafts((d) => { const n = { ...d }; delete n[id]; return n; });
  }

  function run(promise: Promise<void>) {
    startTransition(async () => {
      try { await promise; setError(null); router.refresh(); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    });
  }

  return (
    <CollapsibleCard
      title="Users"
      description="Application accounts. Admin can do everything; Ops can read and update batches/actions but can't change Settings. Passwords are bcrypt-hashed server-side."
    >
      {users.length === 0 ? (
        <p className="text-sm text-ink-500 text-center py-4">
          No users yet — add one below so someone can sign in.
        </p>
      ) : (
        <div className="space-y-3">
          {users.map((u) => {
            const draft = getDraft(u);
            const isSelf = currentUserId === u.id;
            const lastAdmin = u.role === "admin" && adminCount === 1;
            const dirty =
              draft.username !== u.username ||
              draft.name     !== (u.name ?? "") ||
              draft.email    !== (u.email ?? "") ||
              draft.role     !== u.role;
            const showPwPanel = !!pwOpen[u.id];
            const pwDraft = pwDrafts[u.id] ?? "";
            const pwValid = pwDraft.length >= MIN_PASSWORD_LENGTH;

            return (
              <div key={u.id} className="border border-ink-200 rounded-md p-3 bg-white">
                <div className="grid grid-cols-1 md:grid-cols-[1fr,1fr,1.5fr,7rem,auto] gap-3 items-end">
                  <Field label={
                    <span>
                      Username
                      {isSelf && (
                        <span className="ml-2 text-[0.65rem] uppercase tracking-wide font-medium text-brand-dark bg-brand-pastel border border-brand px-1.5 py-0.5 rounded">
                          you
                        </span>
                      )}
                    </span>
                  }>
                    <input
                      className="input"
                      value={draft.username}
                      autoComplete="off"
                      onChange={(e) => setDraft(u.id, { username: e.target.value })}
                    />
                  </Field>
                  <Field label="Name">
                    <input
                      className="input"
                      value={draft.name}
                      placeholder="Display name"
                      onChange={(e) => setDraft(u.id, { name: e.target.value })}
                    />
                  </Field>
                  <Field label="Email">
                    <input
                      className="input"
                      type="email"
                      value={draft.email}
                      placeholder="user@invygo.com"
                      onChange={(e) => setDraft(u.id, { email: e.target.value })}
                    />
                  </Field>
                  <Field label="Role">
                    <select
                      className="input"
                      value={draft.role}
                      disabled={isSelf || lastAdmin}
                      title={
                        isSelf    ? "You can't change your own role." :
                        lastAdmin ? "This is the only admin — create another admin before demoting." :
                        undefined
                      }
                      onChange={(e) => setDraft(u.id, { role: e.target.value as "admin" | "ops" })}
                    >
                      <option value="admin">admin</option>
                      <option value="ops">ops</option>
                    </select>
                  </Field>
                  <div className="inline-flex gap-1.5">
                    <button
                      type="button"
                      disabled={!dirty || pending}
                      className="btn btn-primary text-xs"
                      onClick={() => run((async () => {
                        await callApi({
                          resource: "user", op: "update",
                          id: u.id,
                          username: draft.username.trim(),
                          name:  draft.name.trim()  || null,
                          email: draft.email.trim() || null,
                          role:  draft.role,
                        });
                        clearDraft(u.id);
                      })())}
                    >Save</button>
                    <button
                      type="button"
                      disabled={pending || isSelf || lastAdmin}
                      className="btn text-xs"
                      title={
                        isSelf    ? "You can't delete your own account." :
                        lastAdmin ? "Can't delete the only admin — create another admin first." :
                        undefined
                      }
                      onClick={() => {
                        if (!confirm(`Delete user "${u.username}"? They will lose access immediately. This can't be undone.`)) return;
                        run(callApi({ resource: "user", op: "delete", id: u.id }));
                      }}
                    >Delete</button>
                  </div>
                </div>

                {/* Reset password — collapsed by default, click to expand */}
                <div className="mt-3 pt-3 border-t border-ink-200">
                  {!showPwPanel ? (
                    <button
                      type="button"
                      className="btn text-xs"
                      onClick={() => setPwOpen((s) => ({ ...s, [u.id]: true }))}
                    >🔑 Reset password</button>
                  ) : (
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="block flex-1 min-w-[14rem]">
                        <span className="block text-xs font-medium text-ink-600 mb-1">
                          New password for <code className="text-midnight">{u.username}</code>
                          <span className="text-ink-400 ml-2 font-normal">
                            · min {MIN_PASSWORD_LENGTH} chars
                          </span>
                        </span>
                        <input
                          className="input"
                          type="text"
                          value={pwDraft}
                          autoComplete="new-password"
                          placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                          onChange={(e) => setPwDrafts((s) => ({ ...s, [u.id]: e.target.value }))}
                        />
                      </label>
                      <button
                        type="button"
                        disabled={!pwValid || pending}
                        className="btn btn-primary text-xs"
                        onClick={() => run((async () => {
                          await callApi({
                            resource: "user", op: "reset-password",
                            id: u.id, password: pwDraft,
                          });
                          setPwDrafts((s) => { const n = { ...s }; delete n[u.id]; return n; });
                          setPwOpen((s) => { const n = { ...s }; delete n[u.id]; return n; });
                        })())}
                      >Set password</button>
                      <button
                        type="button"
                        className="btn text-xs"
                        onClick={() => {
                          setPwDrafts((s) => { const n = { ...s }; delete n[u.id]; return n; });
                          setPwOpen((s) => { const n = { ...s }; delete n[u.id]; return n; });
                        }}
                      >Cancel</button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create new user */}
      <div className="mt-5 border-t border-ink-200 pt-4">
        <p className="text-xs font-medium text-ink-600 mb-2 uppercase tracking-wide">
          Add new user
        </p>
        <div className="grid grid-cols-1 md:grid-cols-[1fr,1fr,1.5fr,7rem,1fr,auto] gap-3 items-end">
          <Field label="Username">
            <input
              className="input"
              value={creating.username}
              autoComplete="off"
              placeholder="harbi"
              onChange={(e) => setCreating((c) => ({ ...c, username: e.target.value }))}
            />
          </Field>
          <Field label="Name">
            <input
              className="input"
              value={creating.name}
              placeholder="Harbi Elbaz"
              onChange={(e) => setCreating((c) => ({ ...c, name: e.target.value }))}
            />
          </Field>
          <Field label="Email">
            <input
              className="input"
              type="email"
              value={creating.email}
              placeholder="harbi@invygo.com"
              onChange={(e) => setCreating((c) => ({ ...c, email: e.target.value }))}
            />
          </Field>
          <Field label="Role">
            <select
              className="input"
              value={creating.role}
              onChange={(e) => setCreating((c) => ({ ...c, role: e.target.value as "admin" | "ops" }))}
            >
              <option value="ops">ops</option>
              <option value="admin">admin</option>
            </select>
          </Field>
          <Field label={`Password (≥ ${MIN_PASSWORD_LENGTH} chars)`}>
            <input
              className="input"
              type="text"
              value={creating.password}
              autoComplete="new-password"
              placeholder="Strong password"
              onChange={(e) => setCreating((c) => ({ ...c, password: e.target.value }))}
            />
          </Field>
          <button
            type="button"
            disabled={
              pending ||
              creating.username.trim().length < 2 ||
              creating.password.length < MIN_PASSWORD_LENGTH
            }
            className="btn btn-primary"
            onClick={() => run((async () => {
              await callApi({
                resource: "user", op: "create",
                username: creating.username.trim(),
                name:     creating.name.trim()  || null,
                email:    creating.email.trim() || null,
                role:     creating.role,
                password: creating.password,
              });
              setCreating({ username: "", name: "", email: "", role: "ops", password: "" });
            })())}
          >+ Add</button>
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-flame-dark" role="alert">{error}</p>}
    </CollapsibleCard>
  );
}

// ──────────────────────────────────────────────────────────────────
// VinChaseStagesEditor — admin CRUD for the linear VIN chase chain.
// ──────────────────────────────────────────────────────────────────
//
// The VIN chase chain is its own catalogue (see `vin_chase_stages` +
// `batch_vin_stages` in schema.ts), independent of `action_types`. This
// editor lets admin add / rename / reorder / delete stages without
// touching the rest of the action graph.
//
// Creating a new stage backfills every existing batch with a waiting
// row (server-side). Deleting cascades to batch_vin_stages via FK.

function VinChaseStagesEditor({ data }: { data: SettingsData }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  type Draft = { name: string; waitingLabel: string; doneLabel: string };
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [creating, setCreating] = useState<Draft>({ name: "", waitingLabel: "", doneLabel: "" });

  function fb(id: number): Draft {
    const s = data.vinChaseStages.find((x) => x.id === id);
    return { name: s?.name ?? "", waitingLabel: s?.waitingLabel ?? "", doneLabel: s?.doneLabel ?? "" };
  }
  function getDraft(id: number) { return drafts[id] ?? fb(id); }
  function setDraft(id: number, patch: Partial<Draft>) {
    setDrafts((d) => ({ ...d, [id]: { ...getDraft(id), ...patch } }));
  }
  function clearDraft(id: number) {
    setDrafts((d) => { const next = { ...d }; delete next[id]; return next; });
  }
  function run(promise: Promise<void>) {
    startTransition(async () => {
      try { await promise; router.refresh(); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    });
  }
  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= data.vinChaseStages.length) return;
    const next = [...data.vinChaseStages];
    [next[index], next[target]] = [next[target], next[index]];
    run((async () => {
      // Renumber 10, 20, 30, ... so future inserts can squeeze between.
      await Promise.all(next.map((s, i) =>
        callApi({ resource: "vin-stage", op: "update", id: s.id, sortOrder: (i + 1) * 10 }),
      ));
    })());
  }

  return (
    <CollapsibleCard
      title="VIN Chase Stages"
      description="The strict linear chain shown in the Action Center drawer's VIN chase section. Independent of Action Types — admins can add, rename, reorder, or delete stages here. Rename + Reorder are safe: completed (done) stages on every batch always display in real chronological order, so reorder only affects how upcoming stages on still-open batches appear. Add backfills only OPEN batches (delivered + cancelled batches are frozen). Delete is blocked when batches have done/skipped state on the stage."
    >
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {data.vinChaseStages.map((s, idx) => {
          const fallback = fb(s.id);
          const draft = getDraft(s.id);
          const dirty = JSON.stringify(draft) !== JSON.stringify(fallback);
          const isFirst = idx === 0;
          const isLast = idx === data.vinChaseStages.length - 1;
          return (
            <div key={s.id} className="border border-ink-200 rounded-md p-3 bg-white flex flex-col gap-3">
              <div className="grid grid-cols-[auto,1fr,auto] gap-2 items-end">
                <div className="flex flex-col items-center gap-0.5">
                  <button
                    type="button" disabled={isFirst || pending} className="btn text-xs px-2 py-0.5"
                    onClick={() => move(idx, -1)} aria-label={`Move ${s.name} up`} title="Move up"
                  >▲</button>
                  <span className="text-[0.65rem] font-medium text-ink-500 tabular-nums leading-none px-1 py-0.5"
                        title={`Current sort_order: ${s.sortOrder}`}>{s.sortOrder}</span>
                  <button
                    type="button" disabled={isLast || pending} className="btn text-xs px-2 py-0.5"
                    onClick={() => move(idx, 1)} aria-label={`Move ${s.name} down`} title="Move down"
                  >▼</button>
                </div>
                <Field label="Name (canonical key)">
                  <input className="input" value={draft.name}
                         onChange={(e) => setDraft(s.id, { name: e.target.value })} />
                </Field>
                <div className="inline-flex gap-1.5 self-end">
                  <button
                    type="button" disabled={!dirty || pending} className="btn btn-primary text-xs"
                    onClick={() => run((async () => {
                      await callApi({
                        resource: "vin-stage", op: "update",
                        id: s.id,
                        name:         draft.name.trim(),
                        waitingLabel: draft.waitingLabel.trim(),
                        doneLabel:    draft.doneLabel.trim(),
                      });
                      clearDraft(s.id);
                    })())}
                  >Save</button>
                  <button
                    type="button" disabled={pending} className="btn text-xs"
                    onClick={() => {
                      if (!confirm(`Delete VIN stage "${s.name}"? This removes it from every batch's chain.`)) return;
                      run(callApi({ resource: "vin-stage", op: "delete", id: s.id }));
                    }}
                  >Delete</button>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label="Waiting label (shown while in progress)">
                  <input className="input" value={draft.waitingLabel}
                         onChange={(e) => setDraft(s.id, { waitingLabel: e.target.value })} />
                </Field>
                <Field label="Done label (shown when complete)">
                  <input className="input" value={draft.doneLabel}
                         onChange={(e) => setDraft(s.id, { doneLabel: e.target.value })} />
                </Field>
              </div>
            </div>
          );
        })}
      </div>

      {/* + Add a new stage */}
      <div className="border-t border-ink-200 mt-4 pt-3">
        <p className="text-xs font-medium text-ink-600 mb-2">+ Add stage</p>
        <div className="grid grid-cols-1 md:grid-cols-[1fr,1fr,1fr,auto] gap-2 items-end">
          <Field label="Name">
            <input className="input" value={creating.name}
                   onChange={(e) => setCreating((c) => ({ ...c, name: e.target.value }))} />
          </Field>
          <Field label="Waiting label">
            <input className="input" value={creating.waitingLabel}
                   onChange={(e) => setCreating((c) => ({ ...c, waitingLabel: e.target.value }))} />
          </Field>
          <Field label="Done label">
            <input className="input" value={creating.doneLabel}
                   onChange={(e) => setCreating((c) => ({ ...c, doneLabel: e.target.value }))} />
          </Field>
          <button
            type="button" disabled={pending || !creating.name.trim()} className="btn btn-primary text-sm self-end"
            onClick={() => run((async () => {
              await callApi({
                resource: "vin-stage", op: "create",
                name:         creating.name.trim(),
                waitingLabel: creating.waitingLabel.trim() || creating.name.trim(),
                doneLabel:    creating.doneLabel.trim()    || creating.name.trim(),
                sortOrder:    (data.vinChaseStages.length + 1) * 10,
              });
              setCreating({ name: "", waitingLabel: "", doneLabel: "" });
            })())}
          >+ Add</button>
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-flame-dark" role="alert">{error}</p>}
    </CollapsibleCard>
  );
}

// ──────────────────────────────────────────────────────────────────
// Tiny helpers
// ──────────────────────────────────────────────────────────────────

function Field({
  label, colSpan = 1, children,
}: {
  /** String or a JSX node — Users editor passes a "you" badge inline. */
  label: React.ReactNode;
  colSpan?: 1 | 2 | 3;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("block", colSpan === 2 && "md:col-span-2", colSpan === 3 && "md:col-span-3")}>
      <span className="block text-xs font-medium text-ink-600 mb-1">{label}</span>
      {children}
    </label>
  );
}
