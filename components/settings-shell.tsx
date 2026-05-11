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
import type { SettingsData, SettingsUser } from "@/lib/settings-data";
import SettingsBatches from "./settings-batches";
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
      <RulesEditor data={data} />
      <UsersEditor users={data.users} currentUserId={currentUserId} />
      <SettingsBatches data={data} />
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
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
}

// ──────────────────────────────────────────────────────────────────
// 1 · Departments
// ──────────────────────────────────────────────────────────────────

function DepartmentsEditor({ data }: { data: SettingsData }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // local in-progress drafts for each row, keyed by id
  const [drafts, setDrafts] = useState<Record<number, { name: string; sortOrder: number }>>({});
  const [newName, setNewName] = useState("");

  function getDraft(id: number, fallback: { name: string; sortOrder: number }) {
    return drafts[id] ?? fallback;
  }
  function setDraft(id: number, patch: Partial<{ name: string; sortOrder: number }>) {
    setDrafts((d) => ({ ...d, [id]: { ...getDraft(id, { name: "", sortOrder: 0 }), ...patch } }));
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

  return (
    <CollapsibleCard
      title="Departments"
      description="Stakeholder groups that get assigned to actions. Add stakeholders inside each department — Ops picks one of them at Intake to own the work."
    >
      {/* Existing departments — one card each, with stakeholders inline. */}
      <div className="space-y-3">
        {data.departments.map((d) => {
          const draft = getDraft(d.id, { name: d.name, sortOrder: d.sortOrder });
          const dirty = draft.name !== d.name || draft.sortOrder !== d.sortOrder;
          return (
            <div key={d.id} className="border border-ink-200 rounded-md p-3 bg-white">
              {/* Department header row */}
              <div className="grid grid-cols-1 md:grid-cols-[1fr,7rem,auto] gap-3 items-end">
                <label className="block">
                  <span className="block text-xs font-medium text-ink-600 mb-1">Name</span>
                  <input
                    className="input"
                    value={draft.name}
                    onChange={(e) => setDraft(d.id, { name: e.target.value })}
                  />
                </label>
                <label className="block">
                  <span className="block text-xs font-medium text-ink-600 mb-1">Sort</span>
                  <input
                    type="number"
                    className="input tabular-nums"
                    value={draft.sortOrder}
                    onChange={(e) => setDraft(d.id, { sortOrder: parseInt(e.target.value, 10) || 0 })}
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
                        id: d.id, name: draft.name.trim(), sortOrder: draft.sortOrder,
                      });
                      clearDraft(d.id);
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
          <p className="text-sm text-ink-500 text-center py-6">No departments yet.</p>
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
    sortOrder: number;
  };
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [creating, setCreating] = useState<Draft>({
    name: "", waitingLabel: "", doneLabel: "",
    defaultDepartmentId: null, sortOrder: (data.actionTypes.at(-1)?.sortOrder ?? 0) + 1,
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
      sortOrder: t?.sortOrder ?? 0,
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

  return (
    <CollapsibleCard
      title="Action Types"
      description="The master catalog Ops picks from at Intake. Each action has a default department, two display labels (waiting / done), and optional dependencies on other actions."
    >
      <div className="space-y-4">
        {data.actionTypes.map((t) => {
          const fb = fallbackForId(t.id);
          const draft = getDraft(t.id, fb);
          const dirty = JSON.stringify(draft) !== JSON.stringify(fb);
          return (
            <div key={t.id} className="border border-ink-200 rounded-md p-3 bg-white">
              <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                <Field label="Name" colSpan={1}>
                  <input className="input"
                         value={draft.name}
                         onChange={(e) => setDraft(t.id, { name: e.target.value })} />
                </Field>
                <Field label="Waiting label" colSpan={1}>
                  <input className="input"
                         value={draft.waitingLabel}
                         onChange={(e) => setDraft(t.id, { waitingLabel: e.target.value })} />
                </Field>
                <Field label="Done label" colSpan={1}>
                  <input className="input"
                         value={draft.doneLabel}
                         onChange={(e) => setDraft(t.id, { doneLabel: e.target.value })} />
                </Field>
                <Field label="Default dept" colSpan={1}>
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
                <Field label="Sort" colSpan={1}>
                  <input type="number" className="input tabular-nums"
                         value={draft.sortOrder}
                         onChange={(e) => setDraft(t.id, { sortOrder: parseInt(e.target.value, 10) || 0 })} />
                </Field>
                <div className="flex items-end gap-1.5">
                  <button
                    type="button"
                    disabled={!dirty || pending}
                    className="btn btn-primary text-xs flex-1"
                    onClick={() => run((async () => {
                      await callApi({
                        resource: "action-type", op: "update",
                        id: t.id,
                        name: draft.name.trim(),
                        waitingLabel: draft.waitingLabel.trim(),
                        doneLabel: draft.doneLabel.trim(),
                        defaultDepartmentId: draft.defaultDepartmentId,
                        sortOrder: draft.sortOrder,
                      });
                      clearDraft(t.id);
                    })())}
                  >Save</button>
                  <button
                    type="button"
                    disabled={pending}
                    className="btn text-xs"
                    onClick={() => {
                      if (!confirm(`Delete action type "${t.name}"?`)) return;
                      run(callApi({ resource: "action-type", op: "delete", id: t.id }));
                    }}
                  >Delete</button>
                </div>
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
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <Field label="Name" colSpan={1}>
            <input className="input" placeholder="e.g. Inspection"
                   value={creating.name}
                   onChange={(e) => setCreating((c) => ({ ...c, name: e.target.value }))} />
          </Field>
          <Field label="Waiting label" colSpan={1}>
            <input className="input" placeholder="Waiting Inspection"
                   value={creating.waitingLabel}
                   onChange={(e) => setCreating((c) => ({ ...c, waitingLabel: e.target.value }))} />
          </Field>
          <Field label="Done label" colSpan={1}>
            <input className="input" placeholder="Inspection Done"
                   value={creating.doneLabel}
                   onChange={(e) => setCreating((c) => ({ ...c, doneLabel: e.target.value }))} />
          </Field>
          <Field label="Default dept" colSpan={1}>
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
          <Field label="Sort" colSpan={1}>
            <input type="number" className="input tabular-nums"
                   value={creating.sortOrder}
                   onChange={(e) => setCreating((c) => ({ ...c, sortOrder: parseInt(e.target.value, 10) || 0 }))} />
          </Field>
          <div className="flex items-end">
            <button
              type="button"
              disabled={pending || !creating.name.trim() || !creating.waitingLabel.trim() || !creating.doneLabel.trim()}
              className="btn btn-primary w-full"
              onClick={() => run((async () => {
                await callApi({
                  resource: "action-type", op: "create",
                  name: creating.name.trim(),
                  waitingLabel: creating.waitingLabel.trim(),
                  doneLabel: creating.doneLabel.trim(),
                  defaultDepartmentId: creating.defaultDepartmentId,
                  sortOrder: creating.sortOrder,
                });
                setCreating({
                  name: "", waitingLabel: "", doneLabel: "",
                  defaultDepartmentId: null,
                  sortOrder: creating.sortOrder + 1,
                });
              })())}
            >+ Add</button>
          </div>
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-flame-dark" role="alert">{error}</p>}
    </CollapsibleCard>
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
// 4 · Users (accounts + roles + passwords)
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
