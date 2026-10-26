import type { EnvironmentId, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { isHostPath } from "@t3tools/shared/path";
import * as Schema from "effect/Schema";
import { lazy, Suspense, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Kbd } from "~/components/ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { shortcutLabelForCommand } from "~/keybindings";
import type { OpenFileOptions, RightPanelSurface } from "~/rightPanelStore";
import { SCIENT_DEFAULT_FILE_EXPLORER_OPEN } from "~/scient/fileOpening/fileOpeningPolicy";

import { ScientFilesIcon } from "./ScientRightPanelSurfaceIcon";

const FileBrowserPanel = lazy(() => import("~/components/files/FileBrowserPanel"));

/**
 * The file viewer's own file list keeps its open state under this key, so one
 * switch shows or hides the file list beside every tab.
 */
const PANEL_FILES_STORAGE_KEY = "t3code.fileExplorerOpen";

export function usePanelFilesOpen() {
  return useLocalStorage(
    PANEL_FILES_STORAGE_KEY,
    SCIENT_DEFAULT_FILE_EXPLORER_OPEN,
    Schema.Boolean,
  );
}

/**
 * Tabs that get the panel's file list beside them. A project file draws its own
 * list in the file viewer, Diff has its own file list, Files is the tree itself,
 * and a New tab offers Files as a card.
 */
function panelFilesColumnApplies(surface: RightPanelSurface | null | undefined): boolean {
  if (!surface) return false;
  if (surface.kind === "scient") return surface.module !== "new-tab";
  return surface.kind !== "diff" && surface.kind !== "files" && surface.kind !== "file";
}

/** Tabs where the switch does something: the ones above and project files. */
export function panelFilesToggleApplies(surface: RightPanelSurface | null | undefined): boolean {
  if (surface?.kind === "file") return !surface.attachment && !isHostPath(surface.relativePath);
  return panelFilesColumnApplies(surface);
}

/** The tab strip's switch for the file list. */
export function PanelFilesToggle(props: {
  readonly surface: RightPanelSurface | null | undefined;
  readonly keybindings: ResolvedKeybindingsConfig;
}) {
  const [open, setOpen] = usePanelFilesOpen();
  if (!panelFilesToggleApplies(props.surface)) return null;
  const shortcut = shortcutLabelForCommand(props.keybindings, "rightPanel.toggleFiles");
  const label = open ? "Hide files" : "Show files";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            aria-pressed={open}
            className="shrink-0 self-center"
            size="icon-sm"
            variant="ghost-muted"
            onClick={() => setOpen(!open)}
          />
        }
      >
        <ScientFilesIcon className="size-3.75" />
      </TooltipTrigger>
      <TooltipPopup>
        {label}
        {shortcut ? <Kbd className="ms-2">{shortcut}</Kbd> : null}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * A tab's page with the project's file list beside it, when the list is on and
 * the tab takes it. A panel too narrow for both shows the page alone.
 */
export function PanelFilesLayout(props: {
  readonly surface: RightPanelSurface | null | undefined;
  readonly environmentId: EnvironmentId;
  readonly cwd: string | undefined;
  readonly projectName: string | null;
  readonly workspaceMutationId: string | null;
  readonly onOpenFile: (relativePath: string) => void;
  readonly onOpenFileSource: (
    relativePath: string,
    line?: number,
    options?: OpenFileOptions,
  ) => void;
  readonly children: ReactNode;
}) {
  const [open] = usePanelFilesOpen();
  if (
    !open ||
    !panelFilesColumnApplies(props.surface) ||
    !props.cwd ||
    props.projectName === null
  ) {
    return props.children;
  }
  return (
    <div className="@container/panel-files flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{props.children}</div>
      <aside className="flex min-h-0 w-[min(20rem,40%)] min-w-40 shrink-0 border-l border-border/60 bg-background @max-[30rem]/panel-files:hidden">
        <Suspense fallback={null}>
          <FileBrowserPanel
            key={`${props.environmentId}:${props.cwd}`}
            environmentId={props.environmentId}
            cwd={props.cwd}
            projectName={props.projectName}
            selectedPath={null}
            selectedPathRevealId={0}
            onOpenFile={props.onOpenFile}
            onOpenFileSource={props.onOpenFileSource}
            workspaceMutationId={props.workspaceMutationId}
          />
        </Suspense>
      </aside>
    </div>
  );
}
