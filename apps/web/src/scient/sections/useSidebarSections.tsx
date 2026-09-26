import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, ThreadSection, ThreadSectionId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { type ReactNode, useCallback, useMemo, useState } from "react";

import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import type { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { resolveThreadActionProjectRef } from "../../lib/chatThreadActions";
import { readLocalApi } from "../../localApi";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { environmentServerConfigsAtom } from "../../state/server";
import { useThreadSectionActions } from "./actions";
import { useThreadSectionCatalog } from "./catalog";
import { groupThreadsBySection, sectionLayoutOrder, SidebarViewMode } from "./logic";
import {
  rememberSectionForNewThread,
  useApplyPendingNewThreadSections,
} from "./pendingNewThreadSections";
import { SidebarSectionsToggle } from "./SidebarSectionsToggle";
import type { SidebarSectionsViewProps } from "./SidebarSectionsView";
import { useEmptySectionCleanup } from "./useEmptySectionCleanup";
import { useNewSectionForThreads } from "./useNewSectionForThreads";
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
  readonly pinnedThreads: readonly Shell[];
  readonly activeThreads: readonly Shell[];
  readonly routeThreadKey: string | null;
  readonly newThreadContext: ReturnType<typeof useHandleNewThread>;
  /** Closes the mobile sidebar before navigating to a new draft. */
  readonly onBeforeNewThread: () => void;
}) {
  const { activeThreads, newThreadContext, onBeforeNewThread, pinnedThreads, routeThreadKey } =
    input;
  const catalog = useThreadSectionCatalog();
  const { moveThreadsToSection, setThreadSection } = useThreadSectionActions();
  const newSectionDialog = useNewSectionForThreads();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
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
  const supported =
    catalog.available &&
    primaryEnvironmentId !== null &&
    serverConfigs.get(primaryEnvironmentId)?.environment.capabilities.threadSections === true;
  const sectionsView = viewMode === "sections" && supported;

  const groups = useMemo(
    () =>
      groupThreadsBySection({
        sections: catalog.sections,
        generalIndex: catalog.generalIndex,
        pinned: pinnedThreads,
        active: activeThreads,
      }),
    [activeThreads, catalog.generalIndex, catalog.sections, pinnedThreads],
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
    (threadRef: ScopedThreadRef, sectionId: ThreadSectionId) => {
      void setThreadSection(threadRef, sectionId);
    },
    [setThreadSection],
  );
  useApplyPendingNewThreadSections({ threads: input.threads, apply: applyPendingSection });
  useEmptySectionCleanup({
    threads: input.threads,
    allEnvironmentsConnected:
      environments.length > 0 &&
      environments.every((environment) => environment.connection.phase === "connected"),
  });

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
      const section = await catalog.create(name);
      if (section === null) {
        toastManager.add(stackedThreadToast({ type: "error", title: "Failed to create section" }));
        return;
      }
      setCollapsedIds((current) => current.filter((id) => id !== section.id));
      if (threadRefs.length > 0) await moveThreadsToSection(threadRefs, section.id);
    },
    [catalog, creating, moveThreadsToSection, setCollapsedIds],
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

  const reorderSections = useCallback(
    (orderedIds: readonly string[]) => {
      void catalog.reorder(orderedIds).then((saved) => {
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
      // Moves step over General like any other section.
      const order = sectionLayoutOrder(catalog.sections, catalog.generalIndex);
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
    [
      catalog.generalIndex,
      catalog.sections,
      deleteSection,
      reorderSections,
      startNewThreadInSection,
    ],
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
    creatingSection: creating === null ? null : { onSubmit: submitNewSection },
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
