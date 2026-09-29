import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type {
  ScopedThreadRef,
  ThreadSection,
  ThreadSectionId,
  ThreadSectionProjectRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import type { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { resolveThreadActionProjectRef } from "../../lib/chatThreadActions";
import { readLocalApi } from "../../localApi";
import { useEnvironments } from "../../state/environments";
import { useThreadSectionActions } from "./actions";
import { loadedThreadEnvironmentsKeyAtom } from "./loadedEnvironments";
import { useThreadSectionCatalog } from "./catalog";
import { groupThreadsBySection, sectionIdsInProjectScope, SidebarViewMode } from "./logic";
import {
  rememberSectionForNewThread,
  useApplyPendingNewThreadSections,
} from "./pendingNewThreadSections";
import { SidebarSectionsToggle } from "./SidebarSectionsToggle";
import { setSidebarSectionScope } from "./sidebarScope";
import type { SidebarSectionsViewProps } from "./SidebarSectionsView";
import { useEmptySectionCleanup } from "./useEmptySectionCleanup";
import { sectionOriginForThreads, useNewSectionForThreads } from "./useNewSectionForThreads";
import { useThreadSectionMenu } from "./useThreadSectionMenu";

const SIDEBAR_VIEW_MODE_KEY = "scient:sidebar:view-mode";
const COLLAPSED_SECTIONS_KEY = "scient:sidebar:collapsed-sections";
const CollapsedSectionIds = Schema.Array(Schema.String);

type Shell = EnvironmentThreadShell;

/** The Sections view props the sidebar does not supply itself. */
export type SidebarSectionsOwnViewProps = Pick<
  SidebarSectionsViewProps,
  | "groups"
  | "collapsedGroupIds"
  | "routeThreadKey"
  | "onToggleGroup"
  | "onReorderSections"
  | "onSectionMenu"
  | "onNewThreadInSection"
  | "renamingSectionId"
  | "onRenamingSectionChange"
  | "onRenameSection"
  | "creatingSection"
  | "onStartCreateSection"
  | "onCancelCreateSection"
>;

/**
 * Everything the T3 sidebar needs for user-defined sections, kept out of
 * `Sidebar.tsx`: the Status/Sections mode, grouping, section management,
 * the Section submenu, and the background helpers (filing threads started
 * from a section, optional empty-section cleanup). The sidebar only renders
 * rows and shelves with its own components and forwards menu clicks here.
 */
export function useSidebarSections(input: {
  /** Every thread shell, for membership. */
  readonly threads: readonly Shell[];
  /** The projects of the sidebar's selected project; null under All projects. */
  readonly scopeProjectRefs: readonly ThreadSectionProjectRef[] | null;
  readonly pinnedThreads: readonly Shell[];
  readonly activeThreads: readonly Shell[];
  readonly routeThreadKey: string | null;
  readonly newThreadContext: ReturnType<typeof useHandleNewThread>;
  /** Closes the mobile sidebar before navigating to a new draft. */
  readonly onBeforeNewThread: () => void;
}) {
  const {
    activeThreads,
    newThreadContext,
    onBeforeNewThread,
    pinnedThreads,
    routeThreadKey,
    scopeProjectRefs,
  } = input;
  const catalog = useThreadSectionCatalog();
  const { moveThreadsToSection, setThreadSection } = useThreadSectionActions();
  const newSectionDialog = useNewSectionForThreads();
  // Section creation outside the sidebar records the same selected project.
  useEffect(() => {
    setSidebarSectionScope(scopeProjectRefs);
    return () => setSidebarSectionScope(null);
  }, [scopeProjectRefs]);
  const { environments } = useEnvironments();

  const [viewMode, setViewMode] = useLocalStorage(
    SIDEBAR_VIEW_MODE_KEY,
    "status" as SidebarViewMode,
    SidebarViewMode,
  );
  const [collapsedIds, setCollapsedIds] = useLocalStorage(
    COLLAPSED_SECTIONS_KEY,
    [] as string[],
    CollapsedSectionIds,
  );
  const collapsedGroupIds = useMemo(() => new Set(collapsedIds), [collapsedIds]);
  const [creating, setCreating] = useState<{
    readonly threadRefs: readonly ScopedThreadRef[];
  } | null>(null);
  const [renamingSectionId, setRenamingSectionId] = useState<string | null>(null);

  // The primary server stores the catalog; without it the sidebar stays in Status.
  const supported = catalog.available;
  const sectionsView = viewMode === "sections" && supported;

  // A project scope lists only that project's sections (see sectionIdsInProjectScope).
  const scopeProjectKeys = useMemo(
    () =>
      scopeProjectRefs === null
        ? null
        : new Set(scopeProjectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`)),
    [scopeProjectRefs],
  );
  const loadedKey = useAtomValue(loadedThreadEnvironmentsKeyAtom);
  const loadedEnvironmentIds = useMemo(
    () => new Set(loadedKey.length > 0 ? loadedKey.split("\n") : []),
    [loadedKey],
  );
  const listedSectionIds = useMemo(
    () =>
      sectionIdsInProjectScope({
        sections: catalog.sections,
        scopeProjectKeys,
        loadedEnvironmentIds,
        threads: input.threads,
      }),
    [catalog.sections, input.threads, loadedEnvironmentIds, scopeProjectKeys],
  );
  const groups = useMemo(
    () =>
      groupThreadsBySection({
        sections: catalog.sections,
        generalIndex: catalog.generalIndex,
        pinned: pinnedThreads,
        active: activeThreads,
        listedSectionIds,
      }),
    [activeThreads, catalog.generalIndex, catalog.sections, listedSectionIds, pinnedThreads],
  );
  /** Rows in display order; a collapsed section still shows the open thread. */
  const visibleGroupThreads = useMemo(
    () =>
      groups.flatMap((group) =>
        collapsedGroupIds.has(group.id)
          ? group.threads.filter(
              (thread) =>
                scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
            )
          : group.threads,
      ),
    [collapsedGroupIds, groups, routeThreadKey],
  );

  // "New section…": inline in the Sections view, a dialog elsewhere.
  const requestNewSectionDialog = newSectionDialog.request;
  const requestNewSection = useCallback(
    (threadRefs: readonly ScopedThreadRef[]) => {
      if (sectionsView) setCreating({ threadRefs });
      else requestNewSectionDialog(threadRefs);
    },
    [requestNewSectionDialog, sectionsView],
  );
  const { menuFor, handleMenuAction } = useThreadSectionMenu(requestNewSection);

  const applyPendingSection = useCallback(
    async (threadRef: ScopedThreadRef, sectionId: ThreadSectionId) =>
      (await setThreadSection(threadRef, sectionId))._tag === "Success",
    [setThreadSection],
  );
  useApplyPendingNewThreadSections({ threads: input.threads, apply: applyPendingSection });
  // Stable while the same environments stay connected, so cleanup timers hold.
  const connectedKey =
    environments.length > 0 &&
    environments.every((environment) => environment.connection.phase === "connected")
      ? environments
          .map((environment) => environment.environmentId)
          .toSorted()
          .join("\n")
      : null;
  const connectedEnvironmentIds = useMemo(
    () => (connectedKey === null ? null : new Set(connectedKey.split("\n"))),
    [connectedKey],
  );
  useEmptySectionCleanup({ threads: input.threads, connectedEnvironmentIds });

  // General (null) starts an ordinary thread; a section files the new thread.
  const startNewThreadInSection = useCallback(
    (section: ThreadSection | null) => {
      const projectRef = resolveThreadActionProjectRef({
        activeDraftThread: newThreadContext.activeDraftThread,
        activeThread: newThreadContext.activeThread ?? undefined,
        defaultProjectRef: newThreadContext.defaultProjectRef,
        handleNewThread: newThreadContext.handleNewThread,
      });
      if (projectRef === null) return;
      onBeforeNewThread();
      void newThreadContext.handleNewThread(projectRef).then((draft) => {
        if (draft !== null && section !== null) {
          rememberSectionForNewThread(draft.threadId, section.id);
        }
      });
    },
    [newThreadContext, onBeforeNewThread],
  );

  const submitNewSection = useCallback(
    async (name: string) => {
      const threadRefs = creating?.threadRefs ?? [];
      setCreating(null);
      const section = await catalog.create(
        name,
        sectionOriginForThreads(threadRefs, scopeProjectRefs),
      );
      if (section === null) {
        toastManager.add(stackedThreadToast({ type: "error", title: "Failed to create section" }));
        return;
      }
      setCollapsedIds((current) => current.filter((id) => id !== section.id));
      if (threadRefs.length > 0) await moveThreadsToSection(threadRefs, section.id);
    },
    [catalog, creating, moveThreadsToSection, scopeProjectRefs, setCollapsedIds],
  );

  const renameSection = useCallback(
    (sectionId: string, name: string) => {
      setRenamingSectionId(null);
      void catalog.rename(sectionId, name).then((result) => {
        if (result === null) {
          toastManager.add(
            stackedThreadToast({ type: "error", title: "Failed to rename section" }),
          );
        } else if (result.kind === "duplicate") {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `A section named “${result.existing.name}” already exists`,
            }),
          );
        }
      });
    },
    [catalog],
  );

  /** Takes the new order of the listed groups; hidden sections keep their slots. */
  const reorderSections = useCallback(
    (listedOrder: readonly string[]) => {
      void catalog.reorder(listedOrder).then((saved) => {
        if (!saved) {
          toastManager.add(
            stackedThreadToast({ type: "error", title: "Failed to reorder sections" }),
          );
        }
      });
    },
    [catalog],
  );

  const deleteSection = useCallback(
    async (section: ThreadSection) => {
      const api = readLocalApi();
      if (!api) return;
      const memberCount = input.threads.filter(
        (thread) => thread.archivedAt === null && thread.sectionId === section.id,
      ).length;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          memberCount === 0
            ? `Delete the section “${section.name}”?`
            : `Delete the section “${section.name}”?\n\nIts ${memberCount} thread${memberCount === 1 ? "" : "s"} will move to General. No conversations are deleted.`,
          { variant: "destructive" },
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;
      const removed = await catalog.remove(section.id);
      if (removed === null) {
        toastManager.add(stackedThreadToast({ type: "error", title: "Failed to delete section" }));
        return;
      }
      toastManager.add({
        type: "success",
        title: `Deleted section “${section.name}”`,
        actionProps: {
          children: "Undo",
          onClick: () => {
            void catalog.restore(removed);
          },
        },
      });
    },
    [catalog, input.threads],
  );

  const openSectionMenu = useCallback(
    async (section: ThreadSection, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      // Moves step over General like any other section, and only over listed ones.
      const order = groups.map((group) => group.id);
      const index = order.indexOf(section.id);
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          [
            { id: "new-thread", label: "New thread in section", icon: "message-square-plus" },
            { id: "rename", label: "Rename section", icon: "pencil", separatorBefore: true },
            { id: "move-up", label: "Move up", disabled: index <= 0 },
            {
              id: "move-down",
              label: "Move down",
              disabled: index < 0 || index >= order.length - 1,
            },
            {
              id: "delete",
              label: "Delete section",
              icon: "trash",
              destructive: true,
              separatorBefore: true,
            },
          ],
          position,
        ),
      );
      if (clicked._tag === "Failure" || clicked.value === null) return;
      switch (clicked.value) {
        case "new-thread":
          startNewThreadInSection(section);
          return;
        case "rename":
          setRenamingSectionId(section.id);
          return;
        case "move-up":
        case "move-down": {
          const ids = [...order];
          const target = clicked.value === "move-up" ? index - 1 : index + 1;
          ids.splice(index, 1);
          ids.splice(target, 0, section.id);
          reorderSections(ids);
          return;
        }
        case "delete":
          await deleteSection(section);
          return;
      }
    },
    [deleteSection, groups, reorderSections, startNewThreadInSection],
  );

  const toggleGroup = useCallback(
    (groupId: string) =>
      setCollapsedIds((current) =>
        current.includes(groupId) ? current.filter((id) => id !== groupId) : [...current, groupId],
      ),
    [setCollapsedIds],
  );

  const viewProps: SidebarSectionsOwnViewProps = {
    groups,
    collapsedGroupIds,
    routeThreadKey,
    onToggleGroup: toggleGroup,
    onReorderSections: reorderSections,
    onSectionMenu: (section, position) => void openSectionMenu(section, position),
    onNewThreadInSection: startNewThreadInSection,
    renamingSectionId,
    onRenamingSectionChange: setRenamingSectionId,
    onRenameSection: renameSection,
    creatingSection:
      creating === null
        ? null
        : { onSubmit: submitNewSection, threadCount: creating.threadRefs.length },
    onStartCreateSection: () => setCreating({ threadRefs: [] }),
    onCancelCreateSection: () => setCreating(null),
  };

  const toggle: ReactNode = supported ? (
    <SidebarSectionsToggle
      active={sectionsView}
      onActiveChange={(active) => {
        setCreating(null);
        setViewMode(active ? "sections" : "status");
      }}
    />
  ) : null;

  return {
    /** True while the sidebar is grouped by section. */
    sectionsView,
    visibleGroupThreads,
    viewProps,
    /** The header's grouping toggle; null when sections are unavailable. */
    toggle,
    /** The "New section" dialog used outside the Sections view. */
    dialog: newSectionDialog.dialog,
    sectionMenuFor: menuFor,
    handleSectionMenuAction: handleMenuAction,
  };
}
