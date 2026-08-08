import type { MessageId } from "@t3tools/contracts";
import { GitForkIcon } from "lucide-react";

import { Button } from "../../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";

export function ScientForkUserMessageButton({
  disabled,
  messageId,
  onFork,
}: {
  readonly disabled: boolean;
  readonly messageId: MessageId;
  readonly onFork: (messageId: MessageId, workspaceMode: "new-worktree" | "local") => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={disabled}
            aria-label="Fork conversation before this message"
            title="Fork conversation before this message"
          />
        }
      >
        <GitForkIcon className="size-3" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem
          onClick={() => onFork(messageId, "new-worktree")}
          aria-label="Fork into a new worktree"
        >
          Create independent worktree
        </MenuItem>
        <MenuItem
          onClick={() => onFork(messageId, "local")}
          aria-label="Fork in the current workspace"
        >
          Use same workspace
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
