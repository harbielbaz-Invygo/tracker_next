"use client";

/**
 * ConfirmDialog — branded replacement for `window.confirm` / `window.alert`.
 *
 * Use this instead of the native dialogs for any destructive or bulk
 * operation. Reasons (Audit 6 #1):
 *   • Native confirms are blocking, look unbranded, and can't show
 *     a preview of what's being changed (the audit's #5 — operators
 *     should see WHICH batches before confirming "Mark all 20 done").
 *   • Native alerts are even worse — no way to convey severity or
 *     structure. We use this in alert-mode for validation errors too.
 *   • A11y: this dialog focuses the cancel button on open (safer
 *     default than confirm), traps focus inside, closes on Escape,
 *     and exposes `role="dialog"` + `aria-modal`.
 *
 * Two usage modes:
 *   1. Confirm (default): two buttons — confirm + cancel. Pass `danger`
 *      to colour the confirm button flame (destructive ops).
 *   2. Alert (`alertOnly`): single OK button. Use for validation errors
 *      that previously fired `window.alert`.
 *
 * Optional `previewItems` renders a scrollable list of strings between
 * the description and the buttons — surfaces the exact set being
 * mutated so the operator can sanity-check before committing.
 */
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export interface ConfirmDialogProps {
  /** When false the dialog isn't rendered. */
  open: boolean;
  /** Modal heading — one short sentence. */
  title: string;
  /** Body copy. Plain text; line breaks rendered. */
  description: string;
  /**
   * Optional scrollable list of identifiers (batch codes, action names,
   * dealer names, …) shown between description and buttons. Lets the
   * operator verify WHAT is being changed, not just HOW MANY.
   */
  previewItems?: string[];
  /** Header for the preview block (defaults to "Affected items"). */
  previewLabel?: string;
  /**
   * Confirmation handler. Fires only on confirm-button click — closing
   * via Escape / overlay / cancel does NOT fire this.
   */
  onConfirm: () => void;
  /**
   * Cancel handler. Fires on cancel-button click, Escape, or overlay
   * click. Always fires when the dialog closes without confirmation.
   */
  onCancel: () => void;
  /** Confirm button label. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Cancel button label. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Style the confirm button in flame tones — use for destructive ops. */
  danger?: boolean;
  /**
   * Single-button alert mode. When true, only the confirm button renders
   * (relabelled to "OK" unless `confirmLabel` overrides) and both
   * onConfirm and onCancel fire the same handler. Replaces window.alert.
   */
  alertOnly?: boolean;
}

export default function ConfirmDialog({
  open, title, description, previewItems, previewLabel = "Affected items",
  onConfirm, onCancel,
  confirmLabel, cancelLabel = "Cancel",
  danger = false, alertOnly = false,
}: ConfirmDialogProps) {
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Focus the safer button on open (cancel for confirm mode, the only
  // button for alert mode). Restore focus to the previously-focused
  // element on close so the operator's keyboard flow isn't lost.
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const target = alertOnly ? confirmBtnRef.current : cancelBtnRef.current;
    target?.focus();
    return () => { prev?.focus?.(); };
  }, [open, alertOnly]);

  // Escape closes (treated as cancel). Trap Tab/Shift+Tab so focus
  // can't escape into the page behind the modal.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last  = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onCancel]);

  if (!open) return null;

  const confirmText = confirmLabel ?? (alertOnly ? "OK" : "Confirm");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-desc"
    >
      {/* Overlay — clicking it cancels (matches native confirm behaviour
          when clicking outside). */}
      <div
        className="absolute inset-0 bg-midnight/40 backdrop-blur-[1px] animate-in fade-in duration-150"
        onClick={onCancel}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        className={cn(
          "relative z-10 w-full max-w-md bg-white rounded-lg shadow-xl border",
          "animate-in zoom-in-95 fade-in duration-150",
          danger ? "border-flame/40" : "border-ink-200",
        )}
      >
        <div className="px-5 pt-4 pb-3 border-b border-ink-100">
          <h2
            id="confirm-dialog-title"
            className={cn(
              "text-base font-bold",
              danger ? "text-flame-dark" : "text-midnight",
            )}
          >
            {title}
          </h2>
        </div>
        <div className="px-5 py-4 space-y-3">
          <p
            id="confirm-dialog-desc"
            className="text-sm text-ink-700 whitespace-pre-wrap leading-relaxed"
          >
            {description}
          </p>
          {previewItems && previewItems.length > 0 && (
            <div className="border border-ink-200 rounded-md bg-ink-50/60">
              <p className="px-3 py-1.5 text-[0.65rem] font-semibold uppercase tracking-wide text-ink-500 border-b border-ink-200">
                {previewLabel} · {previewItems.length}
              </p>
              <ul className="max-h-40 overflow-y-auto py-1 px-3 text-xs font-mono text-ink-700 space-y-0.5">
                {previewItems.map((item, i) => (
                  <li key={i} className="tabular-nums truncate" title={item}>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="px-5 py-3 bg-ink-50/40 border-t border-ink-100 flex justify-end gap-2 rounded-b-lg">
          {!alertOnly && (
            <button
              ref={cancelBtnRef}
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 text-sm font-medium rounded-md border border-ink-300
                         bg-white text-ink-700 hover:bg-ink-100 focus-visible:outline
                         focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand"
            >
              {cancelLabel}
            </button>
          )}
          <button
            ref={confirmBtnRef}
            type="button"
            onClick={onConfirm}
            className={cn(
              "px-3 py-1.5 text-sm font-semibold rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1",
              danger
                ? "bg-flame-dark text-white hover:bg-flame focus-visible:outline-flame-dark"
                : "bg-brand text-white hover:bg-brand-dark focus-visible:outline-brand-dark",
            )}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
