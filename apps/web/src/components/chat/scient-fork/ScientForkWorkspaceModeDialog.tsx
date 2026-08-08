import { GitForkIcon } from "lucide-react";

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

export const SCIENT_FORK_WORKSPACE_CHOICES = [
  { workspaceMode: "local", label: "Use same workspace" },
  { workspaceMode: "new-worktree", label: "Create independent worktree" },
] as const satisfies ReadonlyArray<{
  readonly workspaceMode: ForkWorkspaceMode;
  readonly label: string;
}>;

export function ScientForkWorkspaceModeDialog({
  disabled,
  onOpenChange,
  onSelect,
  open,
}: {
  readonly disabled: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (workspaceMode: ForkWorkspaceMode) => void;
  readonly open: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitForkIcon className="size-4" />
            Fork conversation
          </DialogTitle>
          <DialogDescription>
            Start a new conversation from the current completed boundary.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-2">
          {SCIENT_FORK_WORKSPACE_CHOICES.map((choice, index) => (
            <Button
              key={choice.workspaceMode}
              type="button"
              variant={index === 0 ? "default" : "outline"}
              disabled={disabled}
              onClick={() => onSelect(choice.workspaceMode)}
            >
              {choice.label}
            </Button>
          ))}
        </DialogPanel>
        <DialogFooter>
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
