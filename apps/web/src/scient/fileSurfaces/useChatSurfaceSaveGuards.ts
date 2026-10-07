import { projectFileOperationKey } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { useDesktopReloadGuard } from "~/lib/desktopReload";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  useActivePendingSurfaceDeparture,
  usePendingSurfaceDeparture,
  usePendingSurfaceNavigationBlocker,
  type PendingSurfaceDepartureOptions,
} from "~/scient/fileSurfaces/usePendingSurfaceDeparture";
import { markdownPersistenceRegistry } from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import {
  useMarkdownPersistenceGuards,
  useMarkdownPersistenceNavigationGuards,
} from "~/scient/markdownEditor/persistence/useMarkdownPersistenceGuards";

/**
 * Markdown save state for the chat's right-panel surfaces: which surfaces
 * still have a pending save and which need attention. A surface that needs
 * attention is brought to the front.
 */
export function useChatMarkdownSurfaceGuards(input: {
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly environmentId: EnvironmentId | undefined;
  readonly cwd: string | undefined;
  readonly genericPendingIds: ReadonlySet<string>;
}) {
  const { activeThreadRef, environmentId, cwd, genericPendingIds } = input;
  const handleMarkdownAttention = useCallback(
    (surfaceId: string) => {
      if (activeThreadRef)
        useRightPanelStore.getState().activateSurface(activeThreadRef, surfaceId);
    },
    [activeThreadRef],
  );
  const guards = useMarkdownPersistenceGuards({
    environmentId,
    cwd,
    idKind: "surface",
    genericPendingIds,
    onAttention: handleMarkdownAttention,
  });
  return { handleMarkdownAttention, guards };
}

/**
 * Leaving a surface, the thread or the app waits for pending file saves.
 * Returns the runners that switch or close surfaces once saves settle.
 */
export function useChatSurfaceDepartureGuards(input: {
  readonly pendingFileSurfaceIds: ReadonlySet<string>;
  readonly markdownDepartureOptions: PendingSurfaceDepartureOptions;
  readonly activeSurfaceId: string | null;
  readonly environmentId: EnvironmentId | undefined;
  readonly cwd: string | undefined;
  readonly pendingFileSurfaceIdsByProject: ReadonlyMap<string, ReadonlySet<string>>;
  readonly handleMarkdownAttention: (surfaceId: string) => void;
}) {
  const {
    pendingFileSurfaceIds,
    markdownDepartureOptions,
    activeSurfaceId,
    environmentId,
    cwd,
    pendingFileSurfaceIdsByProject,
    handleMarkdownAttention,
  } = input;
  const runAfterPendingSurfaceSave = usePendingSurfaceDeparture(
    pendingFileSurfaceIds,
    markdownDepartureOptions,
  );
  const runAfterPendingFileSave = useActivePendingSurfaceDeparture({
    activeSurfaceId,
    pendingSurfaceIds: pendingFileSurfaceIds,
    ...markdownDepartureOptions,
  });
  const markdownNavigation = useMarkdownPersistenceNavigationGuards({
    environmentId,
    cwd,
    genericPendingByWorkspace: pendingFileSurfaceIdsByProject,
    onAttention: handleMarkdownAttention,
  });
  usePendingSurfaceNavigationBlocker(
    markdownNavigation.pendingSurfaceIds,
    markdownNavigation.departureOptions,
  );
  useDesktopReloadGuard(
    markdownNavigation.pendingSurfaceIds,
    markdownNavigation.departureOptions,
    (id) => {
      const file = markdownPersistenceRegistry
        .getSnapshot()
        .find((entry) => projectFileOperationKey(entry) === id);
      return file
        ? `Could not save ${file.relativePath} in ${file.cwd}. Resolve its save notice, then try again.`
        : undefined;
    },
  );
  return { runAfterPendingSurfaceSave, runAfterPendingFileSave };
}
