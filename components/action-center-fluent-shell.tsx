"use client";

/**
 * Action Center · Fluent UI v9 surface.
 *
 * Test page that renders the External-Phase view with Fluent
 * primitives instead of the project's home-rolled Tailwind cards.
 * Reuses the same data shape (`ActionCenterTree` from the tree data
 * layer) and the same /api/scope-action + /api/batch-* endpoints,
 * so flipping a chip here behaves identically to flipping it on
 * /action-center.
 *
 * Fluent setup notes:
 *   • FluentProvider with webLightTheme at the root.
 *   • makeStyles (Griffel) for any custom spacing not covered by
 *     Fluent's spacing tokens.
 *   • Fluent components used: Card, CardHeader, Button, Badge,
 *     Avatar, Dropdown, Option, ProgressBar, Checkbox, Toolbar,
 *     ToolbarButton, Divider, Text, Title3, Subtitle2, Caption1,
 *     Tooltip, Persona-style header.
 *   • React Icons via @fluentui/react-icons (already a transitive
 *     dep of react-components) — we use inline emoji to avoid a
 *     bigger bundle import. Swap to icons later if desired.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  FluentProvider,
  webLightTheme,
  makeStyles,
  tokens,
  Card,
  CardHeader,
  Badge,
  Button,
  Checkbox,
  Divider,
  Dropdown,
  Option,
  ProgressBar,
  Subtitle2,
  Title3,
  Toolbar,
  ToolbarButton,
  ToolbarDivider,
  Tooltip,
  Text,
  Caption1,
} from "@fluentui/react-components";
import type {
  ActionCenterTree, PoNode, WaveNode, BatchNode, ScopedActionDetail,
} from "@/lib/action-center-tree-data";

type Status = ScopedActionDetail["status"];

interface Props {
  tree: ActionCenterTree;
}

// Griffel styles — Fluent's atomic CSS-in-JS. Used only for
// spacing / layout glue; semantics stay on Fluent components.
const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    rowGap: tokens.spacingVerticalM,
    paddingBlock: tokens.spacingVerticalM,
  },
  topBar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalM,
    rowGap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
  },
  windowCard: {
    boxShadow: tokens.shadow4,
  },
  windowHeader: {
    display: "flex",
    flexDirection: "column",
    rowGap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM,
  },
  windowTitleRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: tokens.spacingHorizontalM,
    rowGap: tokens.spacingVerticalXS,
  },
  progressRow: {
    display: "flex",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalM,
  },
  progressBar: {
    flexGrow: 1,
  },
  batchList: {
    display: "flex",
    flexDirection: "column",
    rowGap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalM,
  },
  batchCard: {
    transitionDuration: tokens.durationFast,
    transitionProperty: "box-shadow, transform",
    transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
    "&:hover": {
      boxShadow: tokens.shadow8,
    },
  },
  batchSelected: {
    outlineStyle: "solid",
    outlineWidth: "2px",
    outlineColor: tokens.colorBrandStroke1,
    outlineOffset: "-2px",
  },
  metaRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: tokens.spacingHorizontalM,
    rowGap: tokens.spacingVerticalXXS,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  stepper: {
    display: "grid",
    columnGap: tokens.spacingHorizontalS,
    rowGap: tokens.spacingVerticalS,
    paddingBlock: tokens.spacingVerticalM,
    paddingInline: tokens.spacingHorizontalM,
  },
  stepCell: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    rowGap: tokens.spacingVerticalXXS,
    textAlign: "center",
  },
  stepDot: {
    minWidth: 0,
    width: "28px",
    height: "28px",
    borderRadius: tokens.borderRadiusCircular,
    transitionDuration: tokens.durationFast,
    transitionProperty: "transform, box-shadow",
    transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
    "&:hover:not(:disabled)": {
      transform: "scale(1.08)",
    },
    "&:active:not(:disabled)": {
      transform: "scale(0.97)",
    },
  },
  closureBar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalS,
    paddingBlock: tokens.spacingVerticalS,
    paddingInline: tokens.spacingHorizontalM,
  },
  bulkBar: {
    position: "fixed",
    bottom: tokens.spacingVerticalL,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 30,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow28,
    borderRadius: tokens.borderRadiusXLarge,
    paddingInline: tokens.spacingHorizontalM,
    paddingBlock: tokens.spacingVerticalXS,
    display: "flex",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalS,
  },
  shiftHistory: {
    paddingInline: tokens.spacingHorizontalM,
    paddingBlock: tokens.spacingVerticalS,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
});

export default function ActionCenterFluentShell({ tree }: Props) {
  const router = useRouter();
  const s = useStyles();

  const allPos = useMemo(() => {
    const flat: { po: PoNode; dealerName: string }[] = [];
    for (const d of tree.dealers) {
      for (const p of d.pos) {
        flat.push({ po: p, dealerName: d.name });
      }
    }
    return flat.sort((a, b) =>
      a.dealerName.localeCompare(b.dealerName)
      || a.po.poNumber.localeCompare(b.po.poNumber),
    );
  }, [tree]);

  const [selectedPoId, setSelectedPoId] = useState<number | null>(
    () => allPos[0]?.po.id ?? null,
  );
  const selected = useMemo(
    () => allPos.find((x) => x.po.id === selectedPoId) ?? null,
    [allPos, selectedPoId],
  );

  const [busyActionId, setBusyActionId] = useState<number | null>(null);
  const [busyBatchId,  setBusyBatchId]  = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedBatchIds, setSelectedBatchIds] = useState<Set<number>>(new Set());

  async function setActionStatus(actionId: number, status: Status) {
    setBusyActionId(actionId);
    setError(null);
    try {
      const res = await fetch("/api/scope-action", {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ actionId, status }),
      });
      if (!res.ok) throw new Error(await res.text());
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyActionId(null);
    }
  }
  async function runBatchOp(batchId: number, url: string, body: unknown) {
    setBusyBatchId(batchId);
    setError(null);
    try {
      const res = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyBatchId(null);
    }
  }

  function toggleBatch(id: number) {
    setSelectedBatchIds((curr) => {
      const next = new Set(curr);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    // Fluent provider scoped to this page. Pure web-light theme;
    // dark-mode handoff can come later via prefers-color-scheme.
    <FluentProvider theme={webLightTheme}>
      <div className={s.root}>
        {/* Top bar — PO picker + meta */}
        <div className={s.topBar}>
          <Subtitle2>PO</Subtitle2>
          <Dropdown
            value={selected ? `${selected.po.poNumber} — ${selected.dealerName}` : ""}
            selectedOptions={selectedPoId != null ? [String(selectedPoId)] : []}
            onOptionSelect={(_, d) => {
              const id = d.optionValue ? parseInt(d.optionValue, 10) : null;
              setSelectedPoId(id);
              setSelectedBatchIds(new Set());
            }}
            placeholder="Pick a PO"
            style={{ minWidth: 280 }}
          >
            {allPos.length === 0 && (
              <Option value="">No POs yet</Option>
            )}
            {allPos.map(({ po, dealerName }) => (
              <Option key={po.id} value={String(po.id)} text={`${po.poNumber} — ${dealerName}`}>
                {po.poNumber} — {dealerName}
                {po.closedAt ? " (closed)" : ""}
              </Option>
            ))}
          </Dropdown>
          {selected && (
            <Caption1 style={{ marginInlineStart: "auto" }}>
              {selected.po.totalCars} cars · {selected.po.waves.length} window
              {selected.po.waves.length === 1 ? "" : "s"}
            </Caption1>
          )}
        </div>

        {error && (
          <Card appearance="filled-alternative" role="alert">
            <Text style={{ color: tokens.colorPaletteRedForeground1 }}>
              Could not update: {error}
            </Text>
          </Card>
        )}

        {!selected ? (
          <Card><Text italic>Pick a PO from the dropdown above.</Text></Card>
        ) : selected.po.waves.length === 0 ? (
          <Card><Text italic>No delivery windows yet on this PO.</Text></Card>
        ) : (
          selected.po.waves.map((w) => (
            <WindowCardFluent
              key={w.id}
              wave={w}
              po={selected.po}
              busyActionId={busyActionId}
              busyBatchId={busyBatchId}
              onChangeStatus={setActionStatus}
              onBatchOp={runBatchOp}
              selectedBatchIds={selectedBatchIds}
              onToggleBatch={toggleBatch}
            />
          ))
        )}

        {selectedBatchIds.size > 0 && selected && (
          <FloatingBulkBar
            count={selectedBatchIds.size}
            onClear={() => setSelectedBatchIds(new Set())}
            onShift={() => bulkOp("shift", selected.po, selectedBatchIds, runBatchOp, setActionStatus)}
            onCancel={() => bulkOp("cancel", selected.po, selectedBatchIds, runBatchOp, setActionStatus)}
            onDeliver={() => bulkOp("deliver", selected.po, selectedBatchIds, runBatchOp, setActionStatus)}
          />
        )}
      </div>
    </FluentProvider>
  );
}

// ─────────────────────────────────────────────────────────────
// Window card
// ─────────────────────────────────────────────────────────────

function WindowCardFluent({
  wave, po, busyActionId, busyBatchId, onChangeStatus, onBatchOp,
  selectedBatchIds, onToggleBatch,
}: {
  wave: WaveNode;
  po: PoNode;
  busyActionId: number | null;
  busyBatchId:  number | null;
  onChangeStatus: (actionId: number, status: Status) => void;
  onBatchOp: (batchId: number, url: string, body: unknown) => Promise<void>;
  selectedBatchIds: Set<number>;
  onToggleBatch: (id: number) => void;
}) {
  const s = useStyles();
  const [historyOpen, setHistoryOpen] = useState<boolean>(false);

  const total = wave.actions.length;
  const done  = wave.actions.filter((a) => a.status === "done" || a.status === "skipped").length;
  const pct   = total === 0 ? 0 : done / total;
  const carsTotal = wave.batches.reduce((sum, b) => sum + b.requestedQuantity, 0);

  return (
    <Card className={s.windowCard} appearance="filled">
      <div className={s.windowHeader}>
        <div className={s.windowTitleRow}>
          <Title3>📅 Delivery Window · {wave.availabilityDate}</Title3>
          <Caption1>
            {carsTotal} cars · {wave.batches.length} batch
            {wave.batches.length === 1 ? "" : "es"}
          </Caption1>
          <Button
            appearance="transparent"
            size="small"
            onClick={() => setHistoryOpen((v) => !v)}
            style={{ marginInlineStart: "auto" }}
          >
            {historyOpen ? "Hide" : "View"} shift history
          </Button>
        </div>
        <div className={s.progressRow}>
          <ProgressBar
            className={s.progressBar}
            value={pct}
            thickness="medium"
            color={pct === 1 ? "success" : "brand"}
          />
          <Caption1 style={{ fontVariantNumeric: "tabular-nums" }}>
            {done}/{total} · {Math.round(pct * 100)}%
          </Caption1>
        </div>
      </div>

      {historyOpen && <ShiftHistoryPanel wave={wave} />}

      <Divider />

      <div className={s.batchList}>
        {wave.batches.map((b) => (
          <BatchCardFluent
            key={b.id}
            batch={b}
            wave={wave}
            internalPhaseDone={po.internalPhaseDone}
            selected={selectedBatchIds.has(b.id)}
            onToggle={() => onToggleBatch(b.id)}
            busyActionId={busyActionId}
            busyBatchId={busyBatchId}
            onChangeStatus={onChangeStatus}
            onBatchOp={onBatchOp}
          />
        ))}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// Batch card
// ─────────────────────────────────────────────────────────────

function BatchCardFluent({
  batch: b, wave, internalPhaseDone, selected, onToggle,
  busyActionId, busyBatchId, onChangeStatus, onBatchOp,
}: {
  batch: BatchNode;
  wave: WaveNode;
  internalPhaseDone: boolean;
  selected: boolean;
  onToggle: () => void;
  busyActionId: number | null;
  busyBatchId:  number | null;
  onChangeStatus: (actionId: number, status: Status) => void;
  onBatchOp: (batchId: number, url: string, body: unknown) => Promise<void>;
}) {
  const s = useStyles();
  const delivery = b.actions.find((a) => a.actionTypeName === "Delivery");
  const closed = b.closedAt != null;
  const isListed = b.appListedAt != null;
  const batchBusy = busyBatchId === b.id;

  const waveTypeIds = new Set(wave.actions.map((a) => a.actionTypeId));
  const batchScopeExternal = b.actions
    .filter((a) => waveTypeIds.has(a.actionTypeId))
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const externalActions = batchScopeExternal.length > 0
    ? batchScopeExternal
    : wave.actions.slice().sort((a, b) => a.sortOrder - b.sortOrder);
  const externalPending = externalActions.filter(
    (a) => a.status !== "done" && a.status !== "skipped",
  );
  const externalReady = externalActions.length > 0 && externalPending.length === 0;

  type Tone = "brand" | "warning" | "success" | "danger" | "informative" | "important";
  const pill:
    | { label: string; appearance: "filled" | "outline" | "tint" | "ghost"; color: Tone; interactive: boolean }
    =
    closed && b.closureReason === "delivered" ? { label: `✓ Delivered ${b.closedAt}`, appearance: "tint", color: "success", interactive: false } :
    closed                                    ? { label: `Cancelled`, appearance: "tint", color: "danger", interactive: false } :
    !internalPhaseDone                        ? { label: "Awaiting Internal Phase", appearance: "tint", color: "warning", interactive: false } :
    !isListed                                 ? { label: "Awaiting App Listing", appearance: "tint", color: "warning", interactive: false } :
    externalPending.length > 0                ? { label: `Awaiting ${externalPending[0].doneLabel || externalPending[0].actionTypeName}`, appearance: "tint", color: "informative", interactive: false } :
    externalReady                             ? { label: "Ready to deliver", appearance: "filled", color: "success", interactive: !!delivery } :
                                                { label: "In progress", appearance: "tint", color: "informative", interactive: false };

  return (
    <Card
      className={`${s.batchCard} ${selected ? s.batchSelected : ""}`}
      appearance={closed ? "subtle" : "filled-alternative"}
    >
      <CardHeader
        image={
          <Checkbox
            checked={selected}
            onChange={onToggle}
            aria-label={`Select ${b.batchCode}`}
          />
        }
        header={
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: tokens.spacingHorizontalS }}>
            <Subtitle2>{b.modelYear}</Subtitle2>
            <Caption1 style={{ fontFamily: "monospace", color: tokens.colorNeutralForeground3 }}>
              {b.batchCode}
            </Caption1>
          </div>
        }
        description={
          <div className={s.metaRow}>
            <span>🚗 {b.requestedQuantity}</span>
            <span>
              📍 {b.legs.length > 0
                ? b.legs.map((l) => `${l.city} ${l.quantity}`).join(", ")
                : b.city}
            </span>
            <span>📅 Promised {b.promisedDate}</span>
            {b.currentProjectedDeliveryDate
              && b.currentProjectedDeliveryDate !== b.promisedDate && (
              <span>⏰ Ops {b.currentProjectedDeliveryDate}</span>
            )}
            {isListed && (
              <span style={{ color: tokens.colorPaletteGreenForeground1 }}>
                📱 listed {b.appListedAt!.slice(0, 10)}
              </span>
            )}
          </div>
        }
        action={
          pill.interactive ? (
            <Button
              appearance="primary"
              size="small"
              onClick={() => delivery && onChangeStatus(delivery.id, "done")}
              disabled={!!delivery && busyActionId === delivery.id}
            >
              {(!!delivery && busyActionId === delivery.id) ? "…" : `✓ ${pill.label}`}
            </Button>
          ) : (
            <Badge appearance={pill.appearance} color={pill.color} size="medium">
              {pill.label}
            </Badge>
          )
        }
      />

      <div className={s.stepper} style={{ gridTemplateColumns: `repeat(${Math.max(externalActions.length, 1)}, minmax(0, 1fr))` }}>
        {externalActions.length === 0 ? (
          <Caption1 italic>No external-phase actions on this batch.</Caption1>
        ) : (() => {
          const nextPendingIdx = externalActions.findIndex(
            (a) => a.status !== "done" && a.status !== "skipped",
          );
          return externalActions.map((a, idx) => {
            const isDone     = a.status === "done";
            const isSkipped  = a.status === "skipped";
            const isBlocked  = a.status === "blocked";
            const isInProg   = idx === nextPendingIdx;
            const busy = busyActionId === a.id;
            const tooltipBits = [
              a.doneLabel || a.actionTypeName,
              a.expectedDate ? `due ${a.expectedDate}` : null,
              a.stakeholderName ? `@${a.stakeholderName}` : null,
              isBlocked && a.blockedByNames.length > 0
                ? `waiting on ${a.blockedByNames.join(", ")}`
                : null,
            ].filter(Boolean).join(" · ");

            const nextStatus: Status =
              a.status === "waiting" || a.status === "blocked" ? "done" : "waiting";

            const dotAppearance:
              | "primary" | "secondary" | "outline" | "subtle" | "transparent" =
              isDone   ? "primary"   :
              isInProg ? "primary"   :
              isBlocked? "secondary" :
                         "outline";

            return (
              <div key={a.id} className={s.stepCell}>
                <Tooltip content={tooltipBits || "Action"} relationship="label" withArrow>
                  <Button
                    appearance={dotAppearance}
                    shape="circular"
                    className={s.stepDot}
                    onClick={() => a.id >= 0 && onChangeStatus(a.id, nextStatus)}
                    disabled={busy || a.id < 0}
                    aria-label={a.doneLabel || a.actionTypeName}
                    icon={
                      <span>
                        {isDone ? "✓" : isSkipped ? "⏭" : isBlocked ? "!" : isInProg ? "●" : ""}
                      </span>
                    }
                  />
                </Tooltip>
                <Caption1
                  style={{
                    fontWeight: isInProg ? tokens.fontWeightSemibold : tokens.fontWeightRegular,
                    color:
                      isDone    ? tokens.colorPaletteGreenForeground1 :
                      isBlocked ? tokens.colorPaletteRedForeground1   :
                      isInProg  ? tokens.colorBrandForeground1        :
                                  tokens.colorNeutralForeground3,
                    textDecoration: isSkipped ? "line-through" : "none",
                  }}
                >
                  {truncate(a.doneLabel || a.actionTypeName, 14)}
                </Caption1>
              </div>
            );
          });
        })()}
      </div>

      {!closed && (
        <>
          <Divider />
          <Toolbar size="small" className={s.closureBar}>
            <ToolbarButton
              appearance="primary"
              disabled={batchBusy}
              onClick={() => {
                const next = window.prompt(`New projected availability date for ${b.batchCode} (yyyy-mm-dd):`);
                if (!next || !/^\d{4}-\d{2}-\d{2}$/.test(next.trim())) return;
                onBatchOp(b.id, "/api/batch-shift", {
                  batchId: b.id,
                  newProjectedDate: next.trim(),
                  bookingsAtShift: 0,
                  reason: null,
                });
              }}
            >
              📅 Shift date
            </ToolbarButton>
            <ToolbarDivider />
            <ToolbarButton
              appearance="subtle"
              disabled={batchBusy}
              onClick={() => {
                if (!window.confirm(`Cancel ${b.batchCode}? This closes the batch as cancelled.`)) return;
                onBatchOp(b.id, "/api/batch-close", {
                  batchId: b.id,
                  reason: "cancelled",
                  note: null,
                });
              }}
            >
              🚫 Cancel
            </ToolbarButton>
          </Toolbar>
        </>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// Shift history panel + bulk bar
// ─────────────────────────────────────────────────────────────

function ShiftHistoryPanel({ wave }: { wave: WaveNode }) {
  const s = useStyles();
  function ordinal(n: number): string {
    const sx = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (sx[(v - 20) % 10] || sx[v] || sx[0]);
  }
  if (wave.batches.length === 0) return null;
  return (
    <div className={s.shiftHistory}>
      <Subtitle2 style={{ color: tokens.colorPaletteYellowForeground1 }}>
        📅 Shift history
      </Subtitle2>
      <div style={{ display: "flex", flexDirection: "column", rowGap: tokens.spacingVerticalXS, marginBlockStart: tokens.spacingVerticalXS }}>
        {wave.batches.map((b) => {
          const original = b.shiftHistory.length > 0
            ? b.shiftHistory[0].previousDate
            : b.promisedDate;
          return (
            <div key={b.id}>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", columnGap: tokens.spacingHorizontalXS }}>
                <Text font="monospace" size={200}>{b.batchCode}</Text>
                <Caption1>·</Caption1>
                <Caption1>Promised <Text size={200}>{original}</Text></Caption1>
                {b.shiftHistory.length === 0 && <Caption1 italic>(no shifts yet)</Caption1>}
              </div>
              {b.shiftHistory.length > 0 && (
                <ul style={{ marginInlineStart: tokens.spacingHorizontalL, listStyle: "none", padding: 0 }}>
                  {b.shiftHistory.map((sh, idx) => (
                    <li key={`${b.id}:${idx}`} style={{ fontSize: tokens.fontSizeBase200 }}>
                      <Text weight="semibold" style={{ color: tokens.colorPaletteYellowForeground1 }}>
                        {ordinal(idx + 1)} shift
                      </Text>
                      {" on "}
                      <Text>{(sh.revisedAt || "").slice(0, 10) || "—"}</Text>
                      {" → "}
                      <Text>{sh.newDate}</Text>
                      {sh.reason && (
                        <Text italic style={{ color: tokens.colorNeutralForeground3 }}> · {sh.reason}</Text>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FloatingBulkBar({
  count, onClear, onShift, onCancel, onDeliver,
}: {
  count: number;
  onClear: () => void;
  onShift: () => void;
  onCancel: () => void;
  onDeliver: () => void;
}) {
  const s = useStyles();
  return (
    <div role="region" aria-label="Bulk actions" className={s.bulkBar}>
      <Text weight="semibold">{count} selected</Text>
      <ToolbarDivider />
      <Button size="small" appearance="subtle" onClick={onShift}>📅 Shift</Button>
      <Button size="small" appearance="subtle" onClick={onCancel}>🚫 Cancel</Button>
      <Button size="small" appearance="primary" onClick={onDeliver}>✓ Mark delivered</Button>
      <ToolbarDivider />
      <Button size="small" appearance="transparent" onClick={onClear} aria-label="Clear selection">
        ✕
      </Button>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

async function bulkOp(
  kind: "shift" | "cancel" | "deliver",
  po: PoNode,
  ids: Set<number>,
  onBatchOp: (batchId: number, url: string, body: unknown) => Promise<void>,
  onChangeStatus: (actionId: number, status: Status) => void,
) {
  const batches = po.waves.flatMap((w) =>
    w.batches.filter((b) => ids.has(b.id) && b.closedAt == null),
  );
  if (batches.length === 0) return;
  if (kind === "shift") {
    const next = window.prompt("New projected availability date (yyyy-mm-dd):");
    if (!next || !/^\d{4}-\d{2}-\d{2}$/.test(next.trim())) return;
    const reason = window.prompt("Reason (optional):") || null;
    for (const b of batches) {
      await onBatchOp(b.id, "/api/batch-shift", {
        batchId: b.id,
        newProjectedDate: next.trim(),
        bookingsAtShift: 0,
        reason,
      });
    }
    return;
  }
  if (kind === "cancel") {
    if (!window.confirm(`Cancel ${batches.length} batch(es)? This is destructive.`)) return;
    const note = window.prompt("Cancellation note (optional):") || null;
    for (const b of batches) {
      await onBatchOp(b.id, "/api/batch-close", {
        batchId: b.id,
        reason: "cancelled",
        note,
      });
    }
    return;
  }
  if (!window.confirm(`Mark ${batches.length} batch(es) as delivered?`)) return;
  for (const b of batches) {
    const delivery = b.actions.find((a) => a.actionTypeName === "Delivery");
    if (delivery) onChangeStatus(delivery.id, "done");
  }
}
