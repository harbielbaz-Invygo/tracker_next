"use client";

/**
 * useConfirmDialog — promise-based hook on top of ConfirmDialog +
 * InputDialog.
 *
 * Drop-in mental model for `window.confirm` / `window.alert` /
 * `window.prompt`:
 *
 *   const { confirm, alert, prompt, dialogProps, inputProps } = useConfirmDialog();
 *
 *   // confirm()
 *   const ok = await confirm({
 *     title: "Mark 20 actions done?",
 *     description: "Blocked rows are excluded — unblock them first.",
 *     danger: true,
 *     previewItems: actionNames,
 *   });
 *   if (!ok) return;
 *
 *   // prompt() — branded replacement for window.prompt
 *   const note = await prompt({
 *     title: "Cancellation note",
 *     description: "Applied to every batch you're cancelling.",
 *     inputLabel: "Note (optional)",
 *   });
 *   if (note == null) return; // null = cancelled
 *
 *   // and at the bottom of your component:
 *   <ConfirmDialog {...dialogProps} />
 *   <InputDialog   {...inputProps} />
 *
 * Why a hook and not a context provider:
 *   • Most call-sites are co-located with their handler — passing
 *     the dialog state to a top-level provider just adds indirection.
 *   • A hook keeps the dialog state lifecycled with the component that
 *     uses it, so unmounting the parent closes any open dialog.
 *
 * Why promise-based:
 *   • Matches the mental model of `window.confirm` / `window.prompt`
 *     — handlers become a one-line swap from native to branded, with
 *     no callback inversion.
 *   • Plays nicely with `async/await` flows already in mutation handlers.
 */
import { useCallback, useRef, useState } from "react";
import type { ConfirmDialogProps } from "./confirm-dialog";
import type { InputDialogProps } from "./input-dialog";

type ConfirmInput = Omit<
  ConfirmDialogProps,
  "open" | "onConfirm" | "onCancel" | "alertOnly"
>;
type AlertInput = Omit<
  ConfirmDialogProps,
  "open" | "onConfirm" | "onCancel" | "alertOnly" | "cancelLabel" | "danger"
> & { danger?: boolean };
type PromptInput = Omit<
  InputDialogProps,
  "open" | "onConfirm" | "onCancel"
>;

type ResolvedOptions =
  | ({ kind: "confirm" } & ConfirmInput)
  | ({ kind: "alert" }   & AlertInput);

export function useConfirmDialog() {
  // Confirm + alert state (driven by ConfirmDialog).
  const [options, setOptions] = useState<ResolvedOptions | null>(null);
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  // Prompt state lives separately because InputDialog has a different
  // shape (string result, not bool) and the two dialogs need to be
  // independently controllable — a handler can confirm() then prompt()
  // in sequence and both pieces of state need to coexist briefly.
  const [promptOptions, setPromptOptions] = useState<PromptInput | null>(null);
  const promptResolverRef = useRef<((value: string | null) => void) | null>(null);

  /** Open a confirm dialog. Resolves to true on confirm, false on cancel. */
  const confirm = useCallback((opts: ConfirmInput): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setOptions({ kind: "confirm", ...opts });
    });
  }, []);

  /** Open a single-OK alert. Resolves when the user clicks OK / hits Escape. */
  const alert = useCallback((opts: AlertInput): Promise<void> => {
    return new Promise<void>((resolve) => {
      resolverRef.current = () => resolve();
      setOptions({ kind: "alert", ...opts });
    });
  }, []);

  /**
   * Open an input dialog. Resolves to the trimmed input value on
   * confirm, or `null` on cancel / Escape. Drop-in for window.prompt.
   */
  const prompt = useCallback((opts: PromptInput): Promise<string | null> => {
    return new Promise<string | null>((resolve) => {
      promptResolverRef.current = resolve;
      setPromptOptions(opts);
    });
  }, []);

  // Confirm/Alert resolvers.
  const handleConfirm = useCallback(() => {
    resolverRef.current?.(true);
    resolverRef.current = null;
    setOptions(null);
  }, []);
  const handleCancel = useCallback(() => {
    resolverRef.current?.(false);
    resolverRef.current = null;
    setOptions(null);
  }, []);

  // Prompt resolvers.
  const handlePromptConfirm = useCallback((value: string) => {
    promptResolverRef.current?.(value);
    promptResolverRef.current = null;
    setPromptOptions(null);
  }, []);
  const handlePromptCancel = useCallback(() => {
    promptResolverRef.current?.(null);
    promptResolverRef.current = null;
    setPromptOptions(null);
  }, []);

  const dialogProps: ConfirmDialogProps = options
    ? {
        ...options,
        open: true,
        alertOnly: options.kind === "alert",
        onConfirm: handleConfirm,
        onCancel: handleCancel,
      }
    : {
        open: false,
        title: "",
        description: "",
        onConfirm: () => {},
        onCancel: () => {},
      };

  const inputProps: InputDialogProps = promptOptions
    ? {
        ...promptOptions,
        open: true,
        onConfirm: handlePromptConfirm,
        onCancel: handlePromptCancel,
      }
    : {
        open: false,
        title: "",
        onConfirm: () => {},
        onCancel: () => {},
      };

  return { confirm, alert, prompt, dialogProps, inputProps };
}
