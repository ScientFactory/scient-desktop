import type {
  EnvironmentId,
  OrchestrationForkLineage,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { deriveForkTitle } from "@t3tools/shared/scientForkTitle";
import { SplitIcon } from "lucide-react";
import {
  type FormEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useEnvironmentThreadShells } from "../../../state/entities";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Switch } from "../../ui/switch";
import { toastManager } from "../../ui/toast";

type ForkWorkspaceMode = "new-worktree" | "local";
export type ScientForkSource =
  | "latest-response"
  | "this-response"
  | "this-message"
  | "new-chat"
  // SCIENT-FORK: the running turn, with the work it has done so far.
  | "running-turn";

/** One title for every fork; a one-line subtitle says where it starts. */
export function scientForkDialogCopy(source: ScientForkSource): {
  readonly title: string;
  readonly description: string;
} {
  const title = "Fork this chat";
  switch (source) {
    case "latest-response":
      return { title, description: "Fork from the latest response" };
    case "this-response":
      return { title, description: "Fork from this response" };
    case "this-message":
      return { title, description: "Fork and edit this message" };
    case "new-chat":
      return { title, description: "Continue in a new chat" };
    case "running-turn":
      return { title, description: "Fork with work in progress" };
  }
}

export type ForkWorktreeUnavailableReason = "no-git-repository" | "no-checkpoint";
export type ForkWorktreeAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: ForkWorktreeUnavailableReason };

const forkWorktreeUnavailableCopy: Record<ForkWorktreeUnavailableReason, string> = {
  "no-git-repository": "Requires a Git repository",
  "no-checkpoint": "No saved checkpoint for this response",
};

function unavailableCopy(source: ScientForkSource, reason: ForkWorktreeUnavailableReason): string {
  if (source === "this-message" && reason === "no-checkpoint") {
    return "No saved checkpoint before this message";
  }
  return forkWorktreeUnavailableCopy[reason];
}

export interface ScientForkConfirmation {
  readonly workspaceMode: ForkWorkspaceMode;
  readonly titleOverride?: string;
  readonly displayTitle?: string;
}

export type ScientForkSubmission =
  | { readonly ok: true; readonly confirmation: ScientForkConfirmation }
  | { readonly ok: false };

interface ScientForkDialogProps {
  readonly disabled: boolean;
  readonly source: ScientForkSource;
  readonly titleOverrideSupported: boolean;
  readonly worktreeAvailability: ForkWorktreeAvailability;
  readonly onOpenChange: (open: boolean) => void;
  /** Resolves to "not-accepted" when the fork was not made. */
  readonly onConfirm: (
    confirmation: ScientForkConfirmation,
    beforeNavigate: () => Promise<boolean>,
    confirmSkippedImages: (names: ReadonlyArray<string>) => Promise<boolean>,
  ) => void | Promise<unknown>;
  readonly open: boolean;
  readonly error?: string | null | undefined;
  readonly checking?: boolean;
  readonly locked?: boolean;
  readonly retryTitle?: string | undefined;
  readonly retryWorkspaceMode?: ForkWorkspaceMode | undefined;
}

interface ScientForkTitleOrigin {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly title: string;
  readonly forkLineage?: OrchestrationForkLineage | null | undefined;
}

/**
 * Map ephemeral form state to the atomic fork command. An untouched proposal
 * remains server-allocated, while an edited title becomes an explicit
 * override. Unavailable worktree requests are rejected without changing the selected mode.
 */
export function resolveScientForkSubmission(input: {
  readonly titleDraft: string;
  readonly proposedTitle: string;
  readonly titleOverrideSupported: boolean;
  readonly newWorktree: boolean;
  readonly worktreeAvailability: ForkWorktreeAvailability;
}): ScientForkSubmission {
  const trimmedTitle = input.titleDraft.trim();
  if (trimmedTitle.length === 0 || (input.newWorktree && !input.worktreeAvailability.available)) {
    return { ok: false };
  }
  const workspaceMode =
    input.newWorktree && input.worktreeAvailability.available ? "new-worktree" : "local";
  const titleOverride =
    input.titleOverrideSupported && trimmedTitle !== input.proposedTitle ? trimmedTitle : undefined;
  return {
    ok: true,
    confirmation:
      titleOverride === undefined ? { workspaceMode } : { workspaceMode, titleOverride },
  };
}

/**
 * Keep the sibling-title subscription out of ChatView's render path. The
 * subscription is active only while this dialog is open and only for the
 * origin environment.
 */
export function ScientForkDialog({
  origin,
  ...props
}: ScientForkDialogProps & {
  readonly origin: ScientForkTitleOrigin | null;
}) {
  const environmentThreads = useEnvironmentThreadShells(
    props.open ? (origin?.environmentId ?? null) : null,
  );
  const proposedTitle = useMemo(() => {
    if (!props.open || origin === null) return "";
    return deriveForkTitle({
      origin,
      originHasForkLineage: origin.forkLineage != null,
      projectThreads: environmentThreads.filter((thread) => thread.projectId === origin.projectId),
    });
  }, [environmentThreads, origin, props.open]);

  return <ScientForkWorkspaceModeDialog {...props} proposedTitle={proposedTitle} />;
}

export function ScientForkWorkspaceModeDialog({
  disabled,
  source,
  proposedTitle,
  titleOverrideSupported,
  worktreeAvailability,
  onOpenChange,
  onConfirm,
  open,
  error,
  checking = false,
  locked = false,
  retryTitle,
  retryWorkspaceMode,
}: ScientForkDialogProps & {
  readonly proposedTitle: string;
}) {
  const copy = scientForkDialogCopy(source);
  const formId = useId();
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [titleDraft, setTitleDraft] = useState(proposedTitle);
  const [titleEdited, setTitleEdited] = useState(false);
  const [newWorktree, setNewWorktree] = useState(false);
  const wasOpenRef = useRef(false);
  const [closingForNavigation, setClosingForNavigation] = useState(false);
  const [skippedImages, setSkippedImages] = useState<ReadonlyArray<string> | null>(null);
  const finishImageConfirmation = useRef<((proceed: boolean) => void) | null>(null);
  const declinedImages = useRef(false);
  const finishClose = useRef<((completed: boolean) => void) | null>(null);
  // Whether the dialog has stayed open since its last submission. Closing it
  // dismisses that fork for good; opening the dialog again does not undo it.
  const openSinceSubmit = useRef(false);
  useLayoutEffect(() => {
    if (!open) {
      finishImageConfirmation.current?.(false);
      finishImageConfirmation.current = null;
      openSinceSubmit.current = false;
      return;
    }
    return () => {
      // Leaving the source while the card closes must release the operation
      // without navigating back or leaving the origin locked.
      finishImageConfirmation.current?.(false);
      finishImageConfirmation.current = null;
      finishClose.current?.(false);
      finishClose.current = null;
      // The dialog is gone, whether it closed or its view went away.
      openSinceSubmit.current = false;
    };
  }, [open]);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setTitleDraft(proposedTitle);
      setTitleEdited(false);
      setNewWorktree(false);
    }
    wasOpenRef.current = open;
  }, [open, proposedTitle]);

  // Follow live sibling-title changes only until the user edits the proposal.
  useEffect(() => {
    if (open && !titleEdited && !disabled && !locked) {
      setTitleDraft(proposedTitle);
    }
  }, [open, proposedTitle, titleEdited, disabled, locked]);

  const displayedTitle = locked && retryTitle !== undefined ? retryTitle : titleDraft;
  const selectedNewWorktree =
    locked && retryWorkspaceMode !== undefined
      ? retryWorkspaceMode === "new-worktree"
      : newWorktree;

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      titleInputRef.current?.focus();
      if (titleOverrideSupported) {
        titleInputRef.current?.select();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, titleOverrideSupported]);

  const submission = resolveScientForkSubmission({
    titleDraft: displayedTitle,
    proposedTitle,
    titleOverrideSupported,
    newWorktree: selectedNewWorktree,
    worktreeAvailability,
  });

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (disabled || checking || !submission.ok) return;
    openSinceSubmit.current = true;
    declinedImages.current = false;
    try {
      const outcome = await onConfirm(
        { ...submission.confirmation, displayTitle: displayedTitle },
        () =>
          // Closed while the fork was being made: it stays where the user is.
          openSinceSubmit.current
            ? new Promise<boolean>((resolve) => {
                finishClose.current = resolve;
                setClosingForNavigation(true);
              })
            : Promise.resolve(false),
        (names) =>
          new Promise<boolean>((resolve) => {
            if (!openSinceSubmit.current) {
              declinedImages.current = true;
              resolve(false);
              return;
            }
            finishImageConfirmation.current = (proceed) => {
              declinedImages.current = !proceed;
              setSkippedImages(null);
              resolve(proceed);
            };
            setSkippedImages(names);
          }),
      );
      // This dialog can no longer show the error, so say it here.
      if (outcome === "not-accepted" && !openSinceSubmit.current && !declinedImages.current) {
        toastManager.add({
          type: "error",
          title: "The fork did not finish",
          description: "Fork from the same message again to resume it.",
        });
      }
    } finally {
      // A failed navigation reopens the same form with its saved retry state.
      setClosingForNavigation(false);
    }
  };

  return (
    <Dialog
      open={open && !closingForNavigation}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (isOpen) return;
        finishClose.current?.(true);
        finishClose.current = null;
      }}
    >
      <DialogPopup className="max-w-[23rem] -translate-y-4">
        {/* Pulled toward the name field so the subtitle groups with the title. */}
        <DialogHeader size="compact" className="-mb-1">
          <div className="grid gap-1 pe-10">
            <DialogTitle size="large">
              <span className="inline-flex items-center gap-2">
                <SplitIcon className="size-4 rotate-90" />
                {copy.title}
              </span>
            </DialogTitle>
            {/* Aligned with the title text, not the icon (size-4 + gap-2). */}
            <DialogDescription className="ms-6">{copy.description}</DialogDescription>
          </div>
        </DialogHeader>
        <DialogPanel padding="none">
          <form id={formId} className="grid gap-3 px-4 pb-2" onSubmit={handleSubmit}>
            <div className="grid gap-1.5">
              <Input
                id={`${formId}-title`}
                ref={titleInputRef}
                aria-label="Thread title"
                size="default"
                value={displayedTitle}
                disabled={disabled || locked || !titleOverrideSupported}
                aria-invalid={!submission.ok}
                onChange={(event) => {
                  setTitleDraft(event.target.value);
                  setTitleEdited(true);
                }}
              />
              {!titleOverrideSupported ? (
                <p className="text-muted-foreground text-xs">
                  This server names new forks automatically. Update the server to choose a title
                  here.
                </p>
              ) : displayedTitle.trim().length === 0 ? (
                <p className="text-destructive text-xs">A title is required.</p>
              ) : null}
            </div>
            <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035]">
              <span className="min-w-0">
                <span className="block">New worktree</span>
                {/* Only a disabled switch needs a reason. */}
                {worktreeAvailability.available ? null : (
                  <span className="mt-0.5 block text-muted-foreground text-xs">
                    {unavailableCopy(source, worktreeAvailability.reason)}
                  </span>
                )}
              </span>
              <Switch
                aria-label="New worktree"
                checked={selectedNewWorktree}
                disabled={disabled || locked || checking || !worktreeAvailability.available}
                onCheckedChange={(checked) => setNewWorktree(Boolean(checked))}
              />
            </label>
            {skippedImages ? (
              <p role="alert" className="text-xs leading-relaxed">
                These images could not be read: {skippedImages.join(", ")}. Continue with the
                message text and readable images, or cancel.
              </p>
            ) : error ? (
              <p role="alert" className="text-destructive text-xs leading-relaxed">
                {error}
              </p>
            ) : disabled ? (
              <p className="text-muted-foreground text-xs leading-relaxed">
                You can close this. The fork will appear in the sidebar when it is ready.
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare" padding="compact">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {skippedImages ? "Cancel" : disabled ? "Close" : "Cancel"}
          </Button>
          <Button
            form={formId}
            type={skippedImages ? "button" : "submit"}
            onClick={
              skippedImages
                ? () => {
                    finishImageConfirmation.current?.(true);
                    finishImageConfirmation.current = null;
                  }
                : undefined
            }
            size="sm"
            disabled={!skippedImages && (disabled || checking || !submission.ok)}
          >
            {skippedImages
              ? "Fork without these images"
              : disabled
                ? "Forking…"
                : checking
                  ? "Checking…"
                  : locked || error
                    ? "Retry"
                    : "Fork"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
