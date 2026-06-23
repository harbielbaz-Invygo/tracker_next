"use client";

/**
 * Settings → Delay reasons.
 *
 * Admin management of the preset reason catalog ops pick from when
 * explaining a late task (the "excused delay" workflow). Add new reasons,
 * or deactivate ones that should no longer be offered (deactivating keeps
 * them on past submissions — it just removes them from the picker).
 *
 * Reads/writes /api/delay-reason. Empty until the
 * ensure-delay-justification-tables migration has run.
 */
import { useEffect, useState } from "react";
import { CollapsibleCard } from "./settings-shell";
import { cn } from "@/lib/utils";

interface Reason { id: number; label: string; active: boolean; sortOrder: number }

export default function SettingsDelayReasons() {
  const [reasons, setReasons] = useState<Reason[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/delay-reason?all=1");
      const j = await res.json().catch(() => null);
      if (Array.isArray(j?.reasons)) setReasons(j.reasons);
    } catch { /* leave empty */ } finally {
      setLoaded(true);
    }
  }
  useEffect(() => { void load(); }, []);

  async function add() {
    const label = newLabel.trim();
    if (!label) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/delay-reason", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
      setNewLabel("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function toggle(r: Reason) {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/delay-reason", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: r.id, active: !r.active }),
      });
      if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <CollapsibleCard
      title="Delay reasons"
      description="Preset reasons ops pick when explaining a late task. Deactivating one hides it from the picker but keeps it on past submissions."
    >
      <div className="space-y-3">
        {loaded && reasons.length === 0 && (
          <p className="text-xs text-ink-500 italic">
            None yet — run “Delay justification tables” in Maintenance to create the catalog, or add one below.
          </p>
        )}

        {reasons.length > 0 && (
          <ul className="divide-y divide-ink-100">
            {reasons.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                <span className={cn("text-sm", r.active ? "text-midnight" : "text-ink-400 line-through")}>
                  {r.label}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => toggle(r)}
                  className={cn(
                    "text-xs px-2.5 py-1 rounded-md border whitespace-nowrap disabled:opacity-50",
                    r.active
                      ? "border-ink-300 text-ink-600 hover:bg-ink-100"
                      : "border-green text-green-dark hover:bg-green-pale",
                  )}
                >
                  {r.active ? "Deactivate" : "Reactivate"}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-2 pt-1">
          <input
            type="text"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } }}
            placeholder="Add a reason (e.g. Port congestion)"
            className="input text-sm flex-1"
          />
          <button
            type="button"
            disabled={busy || !newLabel.trim()}
            onClick={() => void add()}
            className="btn btn-primary text-sm whitespace-nowrap disabled:opacity-50"
          >
            Add reason
          </button>
        </div>
        {error && <p className="text-xs text-flame-dark" role="alert">{error}</p>}
      </div>
    </CollapsibleCard>
  );
}
