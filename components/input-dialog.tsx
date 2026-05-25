"use client";

/**
 * InputDialog — branded replacement for `window.prompt`.
 *
 * Single-input modal with the same a11y treatment as ConfirmDialog
 * (role="dialog" + aria-modal, focus trap, Escape closes, focus
 * restored on close). The dialog opens with the input pre-focused
 * and pre-selected so the operator can type immediately.
 *
 * Use the `useConfirmDialog` hook's `prompt()` method to surface this
 * as a promise — mirrors how `confirm()` and `alert()` work in the
 * same hook.
 *
 *   const { prompt, dialogProps } = useConfirmDialog();
 *   const result = await prompt({
 *     title: "New projected availability date",
 *     description: "Will apply to every batch in this window.",
 *     inputType: "date",
 *     required: true,
 *   });
 *   if (result == null) return; // cancelled / Esc
 *   // ...use result
 *
 * Resolves to `null` on cancel/Escape, or the trimmed input value on
 * confirm. Required-input mode disables the confirm button until a
 * non-empty value is typed.
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface InputDialogProps {
  /** When false the dialog isn't rendered. */
  open: boolean;
  /** Modal heading. */
  title: string;
  /** Short explanatory copy below the title. */
  description?: string;
  /** Label for the input field. */
  inputLabel?: string;
  /** Placeholder text for the input. */
  placeholder?: string;
  /** HTML input type. Defaults to "text". */
  inputType?: "text" | "number" | "date";
  /** Initial value (empty by default). Useful for edits / defaults. */
  initialValue?: string;
  /**
   * When true, the confirm button stays disabled until the input has
   * a non-empty value (whitespace-trimmed). Defaults to false — empty
   * submission resolves to "" which the caller can treat as "no input".
   */
  required?: boolean;
  /**
   * Optional validator. Receives the current trimmed value, returns
   * a human-readable error message (string) to surface inline, or
   * null when valid. Confirm is disabled while there's an error.
   */
  validate?: (value: string) => string | null;
  /** Resolves the promise with the trimmed value. */
  onConfirm: (value: string) => void;
  /** Resolves the promise with null. */
  onCancel: () => void;
  /** Confirm button label. Defaults to "OK". */
  confirmLabel?: string;
  /** Cancel button label. Defaults to "Cancel". */
  cancelLabel?: string;
}

export default function InputDialog({
  open, title, description, inputLabel, placeholder, inputType = "text",
  initialValue = "", required = false, validate, onConfirm, onCancel,
  confirmLabel = "OK", cancelLabel = "Cancel",
}: InputDialogProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [value, setValue] = useState<string>(initialValue);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Reset state when the dialog opens. Without this, reopening a
  // dialog with a stale initial value would keep the prior typing.
  useEffect(() => {
    if (open) {
      setValue(initialValue);
      setValidationError(null);
    }
  }, [open, initialValue]);

  // Focus + select the input on open; restore prior focus on close.
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    // Defer a tick so the input is rendered before we focus.
    const t = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => {
      clearTimeout(t);
      prev?.focus?.();
    };
  }, [open]);

  // Escape closes (treated as cancel). Tab trap so focus stays inside.
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

  const trimmed = value.trim();
  const externalError = validate ? validate(trimmed) : null;
  const error = validationError ?? externalError;
  const isEmpty = trimmed.length === 0;
  const confirmDisabled = (required && isEmpty) || (error != null && !isEmpty);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (validate) {
      const err = validate(trimmed);
      if (err) {
        setValidationError(err);
        return;
      }
    }
    if (required && isEmpty) return;
    onConfirm(trimmed);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="input-dialog-title"
      aria-describedby={description ? "input-dialog-desc" : undefined}
    >
      <div
        className="absolute inset-0 bg-midnight/40 backdrop-blur-[1px] animate-in fade-in duration-150"
        onClick={onCancel}
        aria-hidden="true"
      />
      <form
        ref={dialogRef as React.Ref<HTMLFormElement>}
        onSubmit={submit}
        className="relative z-10 w-full max-w-md bg-white rounded-lg shadow-xl border border-ink-200 animate-in zoom-in-95 fade-in duration-150"
      >
        <div className="px-5 pt-4 pb-3 border-b border-ink-100">
          <h2 id="input-dialog-title" className="text-base font-bold text-midnight">
            {title}
          </h2>
        </div>
        <div className="px-5 py-4 space-y-3">
          {description && (
            <p
              id="input-dialog-desc"
              className="text-sm text-ink-700 whitespace-pre-wrap leading-relaxed"
            >
              {description}
            </p>
          )}
          <label className="block">
            {inputLabel && (
              <span className="block text-xs font-medium text-midnight mb-1">
                {inputLabel}
                {required && <span className="text-flame-dark"> *</span>}
              </span>
            )}
            <input
              ref={inputRef}
              type={inputType}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                if (validationError) setValidationError(null);
              }}
              placeholder={placeholder}
              className={cn(
                "input",
                inputType === "number" && "tabular-nums",
                inputType === "date" && "tabular-nums",
              )}
            />
          </label>
          {error && (
            <p role="alert" className="text-xs text-flame-dark">
              {error}
            </p>
          )}
        </div>
        <div className="px-5 py-3 bg-ink-50/40 border-t border-ink-100 flex justify-end gap-2 rounded-b-lg">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-sm font-medium rounded-md border border-ink-300
                       bg-white text-ink-700 hover:bg-ink-100 focus-visible:outline
                       focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand"
          >
            {cancelLabel}
          </button>
          <button
            type="submit"
            disabled={confirmDisabled}
            className={cn(
              "px-3 py-1.5 text-sm font-semibold rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1",
              confirmDisabled
                ? "bg-ink-200 text-ink-500 cursor-not-allowed"
                : "bg-brand text-white hover:bg-brand-dark focus-visible:outline-brand-dark",
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
