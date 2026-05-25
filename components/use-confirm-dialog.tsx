"use client";

/**
 * useConfirmDialog — promise-based hook on top of ConfirmDialog.
 *
 * Drop-in mental model for `window.confirm` / `window.alert`:
 *
 *   const { confirm, alert, dialogProps } = useConfirmDialog();
 *   // somewhere in an async handler:
 *   const ok = await confirm({
 *     title: "Mark 20 actions done?",
 *     description: "Blocked rows are excluded — unblock them first.",
 *     danger: true,
 *     previewItems: actionNames,
 *   });
 *   if (!ok) return;
 *   // ...perform the action
 *
 *   // and at the bottom of your component:
 *   <ConfirmDialog {...dialogProps} />
 *
 * Why a hook and not a context provider:
 *   • Most confirm-sites are co-located with their handler — passing
 *     the dialog state to a top-level provider just adds indirection.
 *   • A hook keeps the dialog state lifecycled with the component that
 *     uses it, so unmounting the parent closes any open dialog.
 *
 * Why promise-based:
 *   • Matches the mental model of `window.confirm` — handlers become
 *     a one-line swap from native to branded, with no callback inversion.
 *   • Plays nicely with `async/await` flows already in mutation handlers.
 */
import { useCallback, useRef, useState } from "react";
import type { ConfirmDialogProps } from "./confirm-dialog";

type ConfirmInput = Omit<
  ConfirmDialogProps,
  "open" | "onConfirm" | "onCancel" | "alertOnly"
>;
type AlertInput = Omit<
  ConfirmDialogProps,
  "open" | "onConfirm" | "onCancel" | "alertOnly" | "cancelLabel" | "danger"
> & { danger?: boolean };

type ResolvedOptions =
  | ({ kind: "confirm" } & ConfirmInput)
  | ({ kind: "alert" } & AlertInput);

export function useConfirmDialog() {
  const [options, setOptions] = useState<ResolvedOptions | null>(null);
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

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

  return { confirm, alert, dialogProps };
}
