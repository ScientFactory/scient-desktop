import type {
  EnvironmentId,
  OrchestrationForkLineage,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { deriveForkTitle } from "@t3tools/shared/scientForkTitle";
import { SplitIcon } from "lucide-react";
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";

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
import { Label } from "../../ui/label";
import { Switch } from "../../ui/switch";

type ForkWorkspaceMode = "new-worktree" | "local";
export type ScientForkSource = "latest-response" | "this-response" | "this-message";

export function scientForkDialogCopy(source: ScientForkSource): {
  readonly title: string;
  readonly description: string;
} {
  switch (source) {
    case "latest-response":
      return {
        title: "Fork latest response",
        description: "Create a new conversation from the latest response.",
      };
    case "this-response":
      return {
        title: "Fork this response",
        description: "Create a new conversation from this response.",
      };
    case "this-message":
      return {
        title: "Fork this message",
        description: "Create a new conversation from this message.",
      };
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
  readonly onConfirm: (confirmation: ScientForkConfirmation) => void;
  readonly open: boolean;
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
 * override. Unavailable worktree requests fail closed to the current workspace.
 */
export function resolveScientForkSubmission(input: {
  readonly titleDraft: string;
  readonly proposedTitle: string;
  readonly titleOverrideSupported: boolean;
  readonly newWorktree: boolean;
  readonly worktreeAvailability: ForkWorktreeAvailability;
}): ScientForkSubmission {
  const trimmedTitle = input.titleDraft.trim();
  if (trimmedTitle.length === 0) {
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
    if (open && !titleEdited) {
      setTitleDraft(proposedTitle);
    }
  }, [open, proposedTitle, titleEdited]);

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
    titleDraft,
    proposedTitle,
    titleOverrideSupported,
    newWorktree,
    worktreeAvailability,
  });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (disabled || !submission.ok) return;
    onConfirm(submission.confirmation);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SplitIcon className="size-4 rotate-90" />
            {copy.title}
          </DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form id={formId} className="grid gap-4" onSubmit={handleSubmit}>
            <div className="grid gap-1.5">
              <Label htmlFor={`${formId}-title`}>Thread title</Label>
              <Input
                id={`${formId}-title`}
                ref={titleInputRef}
                value={titleDraft}
                size="lg"
                unstyled
                disabled={disabled || !titleOverrideSupported}
                aria-invalid={!submission.ok}
                className="relative inline-flex h-11 w-full min-w-0 items-center rounded-lg border border-border/60 bg-muted/20 text-base text-foreground shadow-none transition-shadow focus-within:border-foreground/40 focus-within:ring-2 focus-within:ring-foreground/10 focus-within:ring-offset-0"
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
              ) : !submission.ok ? (
                <p className="text-destructive text-xs">A title is required.</p>
              ) : null}
            </div>
            <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035]">
              <span className="min-w-0">
                <span className="block">New worktree</span>
                <span className="mt-0.5 block text-muted-foreground text-xs">
                  {worktreeAvailability.available
                    ? "Create an isolated copy of the project"
                    : unavailableCopy(source, worktreeAvailability.reason)}
                </span>
              </span>
              <Switch
                aria-label="New worktree"
                checked={newWorktree && worktreeAvailability.available}
                disabled={disabled || !worktreeAvailability.available}
                onCheckedChange={(checked) => setNewWorktree(Boolean(checked))}
              />
            </label>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            type="button"
            variant="ghost"
            disabled={disabled}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button form={formId} type="submit" disabled={disabled || !submission.ok}>
            {disabled ? "Forking…" : "Fork"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
