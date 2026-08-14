import { FolderOpenIcon, GitBranchIcon, LockKeyholeIcon, SplitIcon } from "lucide-react";

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

export const SCIENT_FORK_WORKSPACE_CHOICES = [
  {
    workspaceMode: "local",
    label: "Same workspace",
    description: "Continue with the current files",
  },
  {
    workspaceMode: "new-worktree",
    label: "Separate worktree",
    description: "Create an isolated copy of the project",
  },
] as const satisfies ReadonlyArray<{
  readonly workspaceMode: ForkWorkspaceMode;
  readonly label: string;
  readonly description: string;
}>;

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

export function ScientForkWorkspaceModeDialog({
  disabled,
  source,
  worktreeAvailability,
  onOpenChange,
  onSelect,
  open,
}: {
  readonly disabled: boolean;
  readonly source: ScientForkSource;
  readonly worktreeAvailability: ForkWorktreeAvailability;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (workspaceMode: ForkWorkspaceMode) => void;
  readonly open: boolean;
}) {
  const copy = scientForkDialogCopy(source);
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
        <DialogPanel className="grid gap-2.5">
          {SCIENT_FORK_WORKSPACE_CHOICES.map((choice) => {
            const isWorktree = choice.workspaceMode === "new-worktree";
            const unavailable = isWorktree && !worktreeAvailability.available;
            const Icon = unavailable
              ? LockKeyholeIcon
              : isWorktree
                ? GitBranchIcon
                : FolderOpenIcon;
            const description = unavailable
              ? unavailableCopy(source, worktreeAvailability.reason)
              : choice.description;

            return (
              <Button
                key={choice.workspaceMode}
                type="button"
                variant="outline"
                disabled={disabled || unavailable}
                onClick={() => onSelect(choice.workspaceMode)}
                className="h-auto min-h-16 justify-start gap-3 px-4 py-3 text-start"
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block font-medium">{choice.label}</span>
                  <span className="mt-0.5 block text-muted-foreground text-xs">{description}</span>
                </span>
              </Button>
            );
          })}
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
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
