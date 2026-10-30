import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";

import type { OpenPreviewMutation } from "~/browser/openFileInPreview";
import type { ChatShortcutCommands } from "~/components/chat/useChatShortcuts";
import type { RightPanelSurface } from "~/rightPanelStore";

import { canOpenNewWindow } from "../multiWindow/openInNewWindow";
import { openPanelTabInNewWindow } from "../multiWindow/panelTabWindow";
import { panelFilesToggleApplies, usePanelFilesOpen } from "./PanelFilesColumn";
import { adjacentPanelSurface, canDuplicatePanelSurface } from "./panelTabCommands";
import { duplicatePanelSurface } from "./panelTabDuplication";
import type { TabDepartureGuard } from "./tabHistory";

/**
 * The side panel's tab shortcuts for the chat's shortcut map (a new tab, the next
 * and previous tab, a second copy of a tab, the file list beside it), the
 * duplicate action the tab bar's menu shares with them, and opening a tab in a
 * new window where the app can.
 */
export function usePanelTabShortcuts<E>(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly panelOpen: boolean;
  readonly surfaces: readonly RightPanelSurface[];
  readonly activeSurface: RightPanelSurface | null;
  readonly activate: (surface: RightPanelSurface) => void;
  readonly addNewTab: () => void;
  readonly canOperatePreview: boolean;
  readonly browserAvailable: boolean;
  readonly runAfterPendingFileSave: TabDepartureGuard;
  readonly openPreview: OpenPreviewMutation<E>;
  readonly previewSessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  readonly addTerminal: () => void;
}) {
  const { threadRef, panelOpen, activeSurface } = input;
  const [filesOpen, setFilesOpen] = usePanelFilesOpen();

  // Like opening a browser, a second copy waits for a pending file save first.
  const duplicateSurface = (surface: RightPanelSurface) => {
    if (!threadRef) return;
    if (surface.kind === "preview" && !input.canOperatePreview) return;
    input.runAfterPendingFileSave(null, () => {
      duplicatePanelSurface({
        surface,
        threadRef,
        openPreview: input.openPreview,
        previewSessions: input.previewSessions,
        addTerminal: input.addTerminal,
      });
    });
  };

  // The new window reads the file from disk, so a pending save lands first.
  const openSurfaceInNewWindow = (
    surface: RightPanelSurface,
    options?: { readonly atCursor?: boolean },
  ) => {
    if (!threadRef) return;
    input.runAfterPendingFileSave(null, () => {
      openPanelTabInNewWindow({ threadRef, surfaceId: surface.id, ...options });
    });
  };

  const activateAdjacent = (step: 1 | -1) => {
    if (!panelOpen) return false;
    const target = adjacentPanelSurface(input.surfaces, activeSurface?.id ?? null, step);
    if (!target) return false;
    input.activate(target);
  };

  const shortcuts: ChatShortcutCommands = {
    // An open panel's tab bar handles a new tab itself; a closed panel opens with one.
    "rightPanel.new": ({ event }) => {
      if (panelOpen || !threadRef) return false;
      if (!event.repeat) input.addNewTab();
    },
    "rightPanel.nextTab": () => activateAdjacent(1),
    "rightPanel.previousTab": () => activateAdjacent(-1),
    "rightPanel.duplicateTab": ({ event }) => {
      if (!panelOpen || !activeSurface) return false;
      const browserAvailable = input.canOperatePreview && input.browserAvailable;
      if (!canDuplicatePanelSurface(activeSurface, { browserAvailable })) return false;
      if (!event.repeat) duplicateSurface(activeSurface);
    },
    "rightPanel.toggleFiles": ({ event }) => {
      if (!panelOpen || !panelFilesToggleApplies(activeSurface)) return false;
      if (!event.repeat) setFilesOpen(!filesOpen);
    },
  };

  return {
    shortcuts,
    duplicateSurface,
    openSurfaceInNewWindow: canOpenNewWindow() ? openSurfaceInNewWindow : undefined,
  };
}
