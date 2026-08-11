import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { FolderInputIcon, LoaderCircleIcon } from "lucide-react";

import { ProjectFavicon } from "../ProjectFavicon";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface ScientGeneralChatMoveTarget {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly faviconPath?: string | null | undefined;
}

/**
 * Scient-owned relocation control shared by the chat header and right panel.
 * Keeping one control prevents those placements from drifting behaviorally.
 */
export function ScientGeneralChatMoveMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly targets: ReadonlyArray<ScientGeneralChatMoveTarget>;
  readonly isMoving: boolean;
  readonly disabledReason: string | null;
  readonly onMove: (projectId: ProjectId) => void;
}) {
  return (
    <Tooltip>
      <Menu>
        <TooltipTrigger
          render={
            <MenuTrigger
              disabled={props.disabledReason !== null || props.isMoving}
              aria-label="Move chat to project"
              title={props.disabledReason ?? "Move chat to project"}
              className="inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-icon-muted transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
            />
          }
        >
          {props.isMoving ? (
            <LoaderCircleIcon aria-hidden className="size-4 animate-spin" />
          ) : (
            <FolderInputIcon aria-hidden className="size-4" />
          )}
        </TooltipTrigger>
        <MenuPopup align="end">
          {props.targets.map((project) => (
            <MenuItem key={project.id} onClick={() => props.onMove(project.id)}>
              <ProjectFavicon
                environmentId={props.environmentId}
                cwd={project.workspaceRoot}
                faviconPath={project.faviconPath}
                className="size-4"
              />
              <span className="max-w-64 truncate">{project.title}</span>
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
      <TooltipPopup side="top">{props.disabledReason ?? "Move chat to project"}</TooltipPopup>
    </Tooltip>
  );
}
