"use client";

/**
 * MaintenancePanel — Settings → Maintenance section (Audit 7).
 *
 * One-click runner for the hand-rolled admin migration / cleanup
 * endpoints under `/api/admin/*`. These exist because `drizzle-kit
 * push` is unreliable against our Turso/libSQL DB (a long-standing
 * `vin_received_at_intake` warning routinely skips additions), so each
 * schema change ships with a defensive `ensure-*` endpoint that adds
 * the column/table idempotently. Until now the only way to fire them
 * was pasting a `fetch()` into browser devtools, once per environment.
 *
 * This panel turns that into buttons:
 *   • Check — GET dry-run (where the endpoint supports it). Reports
 *     what WOULD change without writing. Always safe.
 *   • Run   — POST. Applies the migration. The schema/backfill ones are
 *     idempotent and safe to re-run; the destructive cleanup ones are
 *     gated behind a danger confirm dialog and a mandatory glance at
 *     the dry-run first.
 *
 * Every endpoint already gates on `requireAuth(["admin"])` server-side;
 * the whole Settings page is admin-only too. This is purely an ergonomic
 * shell over fetch — no new privilege.
 *
 * The raw JSON response is rendered verbatim so the operator sees the
 * exact action log (added vs. exists, counts, errors).
 */
import { useState } from "react";
import { CollapsibleCard } from "./settings-shell";
import { useConfirmDialog } from "./use-confirm-dialog";
import ConfirmDialog from "./confirm-dialog";
import { cn } from "@/lib/utils";

interface MigrationEndpoint {
  /** Path segment under /api/admin/. */
  path: string;
  /** Human-readable title. */
  label: string;
  /** One-line description of what the endpoint touches. */
  detail: string;
  /** GET dry-run available (false → POST-only, no preview). */
  supportsGet: boolean;
  /** Permanently deletes data → danger-gated. */
  destructive?: boolean;
}

// ── Schema migrations — idempotent column/table adds, safe to re-run ──
const SCHEMA_MIGRATIONS: MigrationEndpoint[] = [
  {
    path: "run-forecast-migration",
    label: "Forecast scaffolding",
    detail:
      "batches.parent_forecast_batch_id + forecast_superseded_at, the batch_forecasts table & indexes, and the Pre-PO App Listing action type.",
    supportsGet: false,
  },
  {
    path: "ensure-delivery-leg-columns",
    label: "Delivery-leg columns",
    detail:
      "batch_delivery_legs: car_model, listed_at, promised_availability_date, bookings_count. Mandatory — these are declared on the schema, so a missing column 500s EVERY legs query.",
    supportsGet: true,
  },
  {
    path: "ensure-batch-date-revisions",
    label: "Batch date-revisions table",
    detail:
      "batch_date_revisions audit table + indexes — powers windowed customer-days-lost and the shift history.",
    supportsGet: true,
  },
  {
    path: "ensure-shift-phase-column",
    label: "Shift phase attribution",
    detail:
      "batch_date_revisions.phase_at_shift — drives the by-phase breakdown of customer-days-lost (pre_po / internal / external).",
    supportsGet: true,
  },
  {
    path: "ensure-shift-reason-category-column",
    label: "Shift reason category",
    detail: "batch_date_revisions.delay_reason_category — categorises each date shift.",
    supportsGet: true,
  },
  {
    path: "ensure-action-touchpoints-table",
    label: "Action touchpoints table",
    detail: "action_touchpoints table + indexes — per-action follow-up log.",
    supportsGet: true,
  },
  {
    path: "ensure-forecast-stakeholder-column",
    label: "Forecast stakeholder column",
    detail: "batch_forecasts.submitted_by_stakeholder_id — attributes pre-PO forecasts to a partner contact.",
    supportsGet: true,
  },
  {
    path: "ensure-confirmed-quantity-column",
    label: "Confirmed-quantity column",
    detail: "batches.confirmed_quantity (NOT NULL, default 0).",
    supportsGet: true,
  },
  {
    path: "ensure-vins-received-column",
    label: "VINs-received columns",
    detail: "batches.vins_received_quantity + batch_delivery_legs.vins_received_quantity (NOT NULL, default 0).",
    supportsGet: true,
  },
  {
    path: "ensure-po-expected-at-lock-column",
    label: "PO expected-at-lock column",
    detail: "batches.po_expected_date_at_lock — snapshot of the PO ETA when the date was locked.",
    supportsGet: true,
  },
  {
    path: "ensure-ops-projected-at-lock-column",
    label: "Ops projected-at-lock column",
    detail: "batches.ops_projected_delivery_date_at_lock — snapshot of the ops projection at lock time.",
    supportsGet: true,
  },
  {
    path: "ensure-user-department-column",
    label: "User department column",
    detail: "users.department_id — ties each user to a department.",
    supportsGet: true,
  },
  {
    path: "ensure-pre-po-app-listing-action-type",
    label: "Pre-PO App Listing action type",
    detail: "Seeds the Pre-PO App Listing action type if it's missing.",
    supportsGet: false,
  },
];

// ── Backfills — mutate data but never delete; idempotent ──
const BACKFILLS: MigrationEndpoint[] = [
  {
    path: "backfill-batch-external-phase",
    label: "Batch external-phase backfill",
    detail:
      "Ensures every pre-rollout batch has the full set of batch-scope External-Phase action rows. Idempotent (UNIQUE index dedupes).",
    supportsGet: true,
  },
];

// ── Cleanup — DELETES rows. Danger-gated; always Check first. ──
const CLEANUP: MigrationEndpoint[] = [
  {
    path: "cleanup-empty-waves",
    label: "Prune empty waves",
    detail:
      "Deletes every wave with no batches under it (plus its leaked wave-scope action rows) — the placeholders left over from before auto-prune.",
    supportsGet: true,
    destructive: true,
  },
  {
    path: "cleanup-orphan-pos",
    label: "Prune orphan POs",
    detail:
      "Deletes pos / waves / po+wave-scope actions whose batches have all been removed, so the same PO can be re-uploaded.",
    supportsGet: true,
    destructive: true,
  },
  {
    path: "delete-legacy-batches",
    label: "Delete legacy batches",
    detail:
      "Purges every pre-restructure batch (wave_id IS NULL) and cascades to its children. Single-use, irreversible.",
    supportsGet: true,
    destructive: true,
  },
];

type Phase = "idle" | "loading" | "done" | "error";

function EndpointRow({
  ep,
  confirm,
}: {
  ep: MigrationEndpoint;
  confirm: ReturnType<typeof useConfirmDialog>["confirm"];
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [mode, setMode] = useState<"check" | "run" | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(method: "GET" | "POST") {
    if (method === "POST" && ep.destructive) {
      const ok = await confirm({
        title: `Run "${ep.label}"?`,
        description:
          `This permanently DELETES rows from the production database and cannot be undone.\n\n${ep.detail}\n\nRun the Check (dry-run) first to preview exactly what would be removed.`,
        danger: true,
        confirmLabel: "Run cleanup",
      });
      if (!ok) return;
    }

    setPhase("loading");
    setMode(method === "GET" ? "check" : "run");
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/admin/${ep.path}`, { method });
      const json = await res.json().catch(() => null);
      if (!res.ok || (json && json.ok === false)) {
        setError(
          (json && (json.error || json.message)) || `HTTP ${res.status}`,
        );
        setResult(json);
        setPhase("error");
        return;
      }
      setResult(json);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  const busy = phase === "loading";

  return (
    <div className="py-3 border-t border-ink-100 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-midnight flex items-center gap-2 flex-wrap">
            {ep.label}
            {ep.destructive && (
              <span className="text-[0.6rem] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-flame/10 text-flame-dark">
                Destructive
              </span>
            )}
            {!ep.supportsGet && (
              <span className="text-[0.6rem] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-ink-100 text-ink-500">
                No dry-run
              </span>
            )}
          </p>
          <p className="text-xs text-ink-500 mt-0.5">{ep.detail}</p>
          <code className="text-[0.65rem] text-ink-400 font-mono">
            POST /api/admin/{ep.path}
          </code>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {ep.supportsGet && (
            <button
              type="button"
              className="btn min-h-0 px-2.5 py-1.5 text-xs"
              disabled={busy}
              onClick={() => call("GET")}
            >
              {busy && mode === "check" ? "Checking…" : "Check"}
            </button>
          )}
          <button
            type="button"
            className={cn(
              "btn min-h-0 px-2.5 py-1.5 text-xs",
              ep.destructive
                ? "border-flame text-flame-dark hover:border-flame-dark hover:text-flame-dark"
                : "btn-primary",
            )}
            disabled={busy}
            onClick={() => call("POST")}
          >
            {busy && mode === "run" ? "Running…" : "Run"}
          </button>
        </div>
      </div>

      {(phase === "done" || phase === "error") && (
        <div className="mt-2">
          <p
            className={cn(
              "flex items-center gap-1.5 text-[0.7rem] font-semibold mb-1",
              phase === "error" ? "text-flame-dark" : "text-green-dark",
            )}
            role={phase === "error" ? "alert" : undefined}
          >
            <span aria-hidden="true">{phase === "error" ? "✕" : "✓"}</span>
            <span>
              {mode === "check" ? "Dry-run" : "Run"}{" "}
              {phase === "error" ? "failed" : "complete"}
              {error ? ` — ${error}` : ""}
            </span>
          </p>
          {result != null && (
            <pre className="text-[0.7rem] leading-snug bg-ink-50 border border-ink-200 rounded-md p-2 max-h-56 overflow-auto text-ink-700">
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function Group({
  title,
  note,
  endpoints,
  confirm,
}: {
  title: string;
  note: string;
  endpoints: MigrationEndpoint[];
  confirm: ReturnType<typeof useConfirmDialog>["confirm"];
}) {
  return (
    <div>
      <h3 className="text-xs font-bold uppercase tracking-wide text-ink-500">
        {title}
      </h3>
      <p className="text-xs text-ink-400 mt-0.5 mb-1">{note}</p>
      <div>
        {endpoints.map((ep) => (
          <EndpointRow key={ep.path} ep={ep} confirm={confirm} />
        ))}
      </div>
    </div>
  );
}

export default function MaintenancePanel() {
  const { confirm, dialogProps } = useConfirmDialog();

  return (
    <CollapsibleCard
      title="Maintenance"
      description="Run schema migrations, backfills and cleanups. Admin-only; safe ones are idempotent, destructive ones confirm first."
    >
      <div className="space-y-5">
        <Group
          title="Schema migrations"
          note="Idempotent — each checks for existence before writing, so re-running is a no-op. Run once per environment if drizzle-kit push skipped the addition."
          endpoints={SCHEMA_MIGRATIONS}
          confirm={confirm}
        />
        <Group
          title="Backfills"
          note="Mutate data but never delete. Idempotent and safe to re-run."
          endpoints={BACKFILLS}
          confirm={confirm}
        />
        <Group
          title="Cleanup (destructive)"
          note="Permanently delete rows. Always run Check (dry-run) first to preview, then confirm the danger prompt."
          endpoints={CLEANUP}
          confirm={confirm}
        />
      </div>
      <ConfirmDialog {...dialogProps} />
    </CollapsibleCard>
  );
}
