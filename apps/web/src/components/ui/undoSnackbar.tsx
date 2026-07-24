// FILE: undoSnackbar.tsx
// Purpose: Renders the single bottom-edge transient surface reserved for reversible actions.
// Layer: Shared UI

import { Toast, type ToastObject } from "@base-ui/react/toast";
import { useState, type ReactNode } from "react";

import { ArchiveIcon, LoaderCircleIcon, XIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";

interface UndoSnackbarData {
  onUndo: () => boolean | Promise<boolean>;
}

const undoSnackbarManager = Toast.createToastManager<UndoSnackbarData>();

export interface ShowUndoSnackbarInput {
  id?: string | undefined;
  title: string;
  onUndo: UndoSnackbarData["onUndo"];
  timeout?: number | undefined;
}

export function showUndoSnackbar(input: ShowUndoSnackbarInput): void {
  undoSnackbarManager.add({
    ...(input.id ? { id: input.id } : {}),
    title: input.title,
    timeout: input.timeout ?? 10_000,
    data: { onUndo: input.onUndo },
  });
}

function UndoSnackbarSurface({ toast }: { toast: ToastObject<UndoSnackbarData> }) {
  const [undoPending, setUndoPending] = useState(false);
  const [undoError, setUndoError] = useState(false);

  const dismiss = () => undoSnackbarManager.close(toast.id);
  const handleUndo = () => {
    if (undoPending) return;
    setUndoError(false);
    setUndoPending(true);
    undoSnackbarManager.update(toast.id, { timeout: 0 });
    void Promise.resolve(toast.data?.onUndo())
      .then((restored) => {
        if (restored) {
          dismiss();
          return;
        }
        setUndoPending(false);
        setUndoError(true);
        undoSnackbarManager.update(toast.id, { timeout: 10_000 });
      })
      .catch(() => {
        setUndoPending(false);
        setUndoError(true);
        undoSnackbarManager.update(toast.id, { timeout: 10_000 });
      });
  };

  return (
    <Toast.Content className="pointer-events-auto flex min-h-10 items-center gap-2 px-3 py-2 text-[length:var(--app-font-size-ui,12px)] text-popover-foreground">
      <ArchiveIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <Toast.Title className="block truncate font-normal" />
        {undoError ? (
          <span
            className="block text-[length:var(--app-font-size-ui-xs,10px)] text-destructive"
            role="alert"
          >
            Could not undo. Try again.
          </span>
        ) : null}
      </span>
      <button
        type="button"
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 font-medium text-primary outline-none transition-colors hover:bg-primary/8 focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55"
        disabled={undoPending}
        onClick={handleUndo}
      >
        {undoPending ? (
          <LoaderCircleIcon
            aria-hidden
            className="size-3 animate-spin motion-reduce:animate-none"
          />
        ) : null}
        Undo
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45"
        disabled={undoPending}
        onClick={dismiss}
      >
        <XIcon aria-hidden className="size-3.5" />
      </button>
    </Toast.Content>
  );
}

function UndoSnackbars() {
  const { toasts } = Toast.useToastManager<UndoSnackbarData>();
  return (
    <Toast.Portal>
      <Toast.Viewport
        aria-label="Undo actions"
        className="fixed bottom-4 left-1/2 z-[210] flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 outline-none"
      >
        {toasts.map((toast, index) => (
          <Toast.Root
            className={cn(
              "absolute right-0 bottom-0 left-0 overflow-hidden rounded-xl border border-border/85 bg-popover shadow-lg/15 [-webkit-app-region:no-drag]",
              "transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none",
              "data-starting-style:translate-y-3 data-starting-style:opacity-0 data-ending-style:translate-y-3 data-ending-style:opacity-0",
              index > 0 && "pointer-events-none opacity-0",
            )}
            key={toast.id}
            swipeDirection={["down"]}
            toast={toast}
          >
            <UndoSnackbarSurface toast={toast} />
          </Toast.Root>
        ))}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

export function UndoSnackbarProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider toastManager={undoSnackbarManager} limit={1} timeout={10_000}>
      {children}
      <UndoSnackbars />
    </Toast.Provider>
  );
}
