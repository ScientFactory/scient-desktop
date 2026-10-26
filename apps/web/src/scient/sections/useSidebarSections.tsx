import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { sortActiveThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";
import {
  EnvironmentId,
  ProjectId,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadSectionProjectRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { type ReactNode, useEffect, useState } from "react";

import { filterSidebarV2VisibleThreads } from "../../components/Sidebar.logic";
import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import type { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { resolveThreadActionProjectRef } from "../../lib/chatThreadActions";
import { readLocalApi } from "../../localApi";
import { useEnvironmentMachines, useEnvironments } from "../../state/environments";
import { environmentServerConfigsAtom } from "../../state/server";
import { useUiStateStore } from "../../uiStateStore";
import { readThreadShell } from "../../state/entities";
import { placementEligible } from "./placementEligibility";
import { migrateLegacyPlacement } from "./placementMigration";
import { useAutomaticPlacement } from "./useAutomaticPlacement";
import { useThreadSectionActions } from "./actions";
import {
  frozenPlacementEnvironmentsKeyAtom,
  loadedThreadEnvironmentsKeyAtom,
} from "./loadedEnvironments";
import { useThreadSectionCatalogs } from "./catalog";
import {
  environmentGroupOrder,
  GENERAL_SECTION_GROUP_ID,
  groupThreadsBySection,
  type SectionGroup,
  type SectionRef,
  sectionGroupId,
  sectionGroupIdsInProjectScope,
  sectionRefFromGroupId,
  SidebarViewMode,
} from "./logic";
import {
  rememberSectionForNewThread,
  useApplyPendingNewThreadSections,
} from "./pendingNewThreadSections";
import { SidebarSectionsToggle } from "./SidebarSectionsToggle";
import { setSidebarSectionScope } from "./sidebarScope";
import type { SectionMachine, SidebarSectionsViewProps } from "./SidebarSectionsView";
import { useEmptySectionCleanup } from "./useEmptySectionCleanup";
import { useNewSectionForThreads } from "./useNewSectionForThreads";
import { useThreadSectionMenu } from "./useThreadSectionMenu";

const SIDEBAR_VIEW_MODE_KEY = "scient:sidebar:view-mode";
const COLLAPSED_SECTIONS_KEY = "scient:sidebar:collapsed-sections";
const CollapsedSectionIds = Schema.Array(Schema.String);
// Group ids name environments, so one browser-local placement serves every viewer.
const PLACEMENT_SCOPE = "sections";

type Shell = EnvironmentThreadShell;

/**
 * A project on the section's environment to start its new thread in: the
 * current context's project when it is there, else the project of a thread
 * already in the section (on any shelf), else one the section was created for.
 */
export function projectRefForSection(
  group: Pick<SectionGroup<Shell>, "environmentId" | "section">,
  contextProjectRef: ScopedProjectRef | null,
  threads: readonly Shell[],
): ScopedProjectRef | null {
  const environmentId = group.environmentId;
  const section = group.section;
  if (environmentId === null || contextProjectRef?.environmentId === environmentId) {
    return contextProjectRef;
  }
  const memberProject = threads.find(
    (thread) =>
      thread.archivedAt === null &&
      thread.projectId !== null &&
      thread.environmentId === environmentId &&
      section !== null &&
      thread.sectionId === section.id,
  )?.projectId;
  if (memberProject != null)
    return scopeProjectRef(EnvironmentId.make(environmentId), memberProject);
  const createdIn = section?.createdInProjects?.find((ref) => ref.environmentId === environmentId);
  return createdIn === undefined
    ? null
    : scopeProjectRef(EnvironmentId.make(environmentId), ProjectId.make(createdIn.projectId));
}

/** The Sections view props the sidebar does not supply itself. */
export type SidebarSectionsOwnViewProps = Pick<
  SidebarSectionsViewProps,
  | "groups"
  | "environmentMachines"
  | "collapsedGroupIds"
  | "routeThreadKey"
  | "onToggleGroup"
  | "onReorderSections"
  | "onSectionMenu"
  | "onNewThreadInSection"
  | "renamingSectionId"
  | "onRenamingSectionChange"
  | "onRenameSection"
  | "onStartCreateSection"
  | "canonicalGroupOrders"
  | "onManualPlacement"
  | "onInteractionChange"
>;

export function useSidebarSections(input: {
  /** Every thread shell, for membership. */
  readonly threads: readonly Shell[];
  /** The projects of the sidebar's selected project; null under All projects. */
  readonly scopeProjectRefs: readonly ThreadSectionProjectRef[] | null;
  readonly pinnedThreads: readonly Shell[];
  readonly activeThreads: readonly Shell[];
  readonly routeThreadKey: string | null;
  readonly now?: string;
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
  const catalogs = useThreadSectionCatalogs();
  const layouts = catalogs.catalogs;
  const { setThreadSection } = useThreadSectionActions();
  // Section creation outside the sidebar records the same selected project.
  useEffect(() => {
    setSidebarSectionScope(scopeProjectRefs);
    return () => setSidebarSectionScope(null);
  }, [scopeProjectRefs]);
  const { environments } = useEnvironments();
  const machineById = useEnvironmentMachines();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  // One machine catching up or offline holds only its own threads' placement.
  const frozenKey = useAtomValue(frozenPlacementEnvironmentsKeyAtom);
  const frozenEnvironmentIds = frozenKey ? frozenKey.split("\n") : [];
  const visits = useUiStateStore((state) => state.threadLastVisitedAtById);

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
  const onSectionCreated = (section: SectionRef) => {
    const groupId = sectionGroupId(section);
    setCollapsedIds((current) =>
      current.filter((id) => id !== groupId && id !== section.sectionId),
    );
  };
  const newSection = useNewSectionForThreads({ onCreated: onSectionCreated });
  const [renamingSectionId, setRenamingSectionId] = useState<string | null>(null);

  // Grouping needs an environment that stores sections; without one the sidebar stays in Status.
  const supported = catalogs.available;
  const sectionsView = viewMode === "sections" && supported;

  // A project scope lists only that project's sections (see sectionGroupIdsInProjectScope).
  const scopeProjectKeys =
    scopeProjectRefs === null
      ? null
      : new Set(scopeProjectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`));
  const loadedKey = useAtomValue(loadedThreadEnvironmentsKeyAtom);
  const loadedEnvironmentIds = new Set(loadedKey.length > 0 ? loadedKey.split("\n") : []);
  const listedGroupIds = sectionGroupIdsInProjectScope({
    layouts,
    scopeProjectKeys,
    loadedEnvironmentIds,
    threads: input.threads,
  });
  const canonicalGroups = groupThreadsBySection({
    layouts,
    pinned: pinnedThreads,
    active: activeThreads,
    listedGroupIds,
  });
  // Saved before sections were environment-local, collapsed sections are
  // listed by section id alone; those still collapse every section with it.
  const collapsedGroupIds = (() => {
    const stored = new Set(collapsedIds);
    const collapsed = new Set(collapsedIds);
    for (const group of canonicalGroups) {
      if (group.section !== null && stored.has(group.section.id)) collapsed.add(group.id);
    }
    return collapsed as ReadonlySet<string>;
  })();
  // Machine icons qualify section headers once the listed sections come from
  // more than one environment.
  const environmentMachines = (() => {
    const listed = new Set(
      canonicalGroups.flatMap((group) =>
        group.environmentId === null ? [] : [group.environmentId],
      ),
    );
    if (listed.size < 2) return null;
    return new Map(
      environments.flatMap((environment) =>
        listed.has(environment.environmentId)
          ? [
              [
                environment.environmentId as string,
                {
                  label: environment.label,
                  kind: machineById.get(environment.environmentId) ?? "server",
                },
              ] as const,
            ]
          : [],
      ),
    ) as ReadonlyMap<string, SectionMachine>;
  })();
  const completeGroups = (() => {
    const now = input.now ?? new Date().toISOString();
    // The rows the sidebar can show, regardless of project scope; hidden subagents never place.
    const active = filterSidebarV2VisibleThreads(input.threads, null).filter((thread) => {
      if (thread.pinnedAt != null) return false;
      const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
      return (
        !(capabilities?.threadSettlement && thread.settledOverride === "settled") &&
        !(capabilities?.threadSnooze && effectiveSnoozed(thread, { now }))
      );
    });
    return groupThreadsBySection({
      layouts,
      pinned: [],
      active: sortActiveThreadsByOrderKey(active),
    });
  })();
  const placementInputs = completeGroups.map((group) => ({
    id: group.id,
    rows: group.threads.map((thread) => {
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      return {
        key,
        orderKey: thread.activeOrderKey ?? null,
        eligible: placementEligible(thread, visits[key], input.now ?? new Date().toISOString()),
      };
    }),
  }));
  const knownPlacementKeys = input.threads
    .filter((thread) => thread.archivedAt === null)
    .map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)));
  // Once, before placement first reads its storage.
  useState(() => migrateLegacyPlacement(() => window.localStorage, PLACEMENT_SCOPE));
  const placement = useAutomaticPlacement({
    scope: PLACEMENT_SCOPE,
    groups: placementInputs,
    openKey: routeThreadKey,
    ready: supported && frozenKey !== null,
    frozenEnvironmentIds,
    knownKeys: knownPlacementKeys,
  });
  const groups = (() => {
    if (!placement.enabled) return canonicalGroups;
    return canonicalGroups.map((group) => {
      const order = placement.state.groups.find((entry) => entry.id === group.id)?.order;
      if (order === undefined) return group;
      const rank = new Map(order.map((key, index) => [key, index]));
      const pinned = group.threads.filter((thread) => thread.pinnedAt != null);
      const active = group.threads
        .filter((thread) => thread.pinnedAt == null)
        .toSorted(
          (left, right) =>
            (rank.get(scopedThreadKey(scopeThreadRef(left.environmentId, left.id))) ?? Infinity) -
            (rank.get(scopedThreadKey(scopeThreadRef(right.environmentId, right.id))) ?? Infinity),
        );
      return { ...group, threads: [...pinned, ...active] };
    });
  })();
  const canonicalGroupOrders = placement.enabled
    ? new Map(
        canonicalGroups.map((group) => [
          group.id,
          group.threads
            .filter((thread) => thread.pinnedAt == null)
            .map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
        ]),
      )
    : undefined;
  const onManualPlacement = ((groupId, order, key, orderKeys) => {
    const ref = parseScopedThreadKey(key);
    const thread = ref === null ? null : readThreadShell(ref);
    const movedRow =
      thread === null
        ? undefined
        : {
            key,
            orderKey: thread.activeOrderKey ?? null,
            eligible: placementEligible(
              thread,
              useUiStateStore.getState().threadLastVisitedAtById[key],
              new Date().toISOString(),
            ),
          };
    placement.onManualPlacement(groupId, order, key, orderKeys, movedRow);
  }) as NonNullable<SidebarSectionsViewProps["onManualPlacement"]>;
  /** Rows in display order; a collapsed section still shows the open thread. */
  const visibleGroupThreads = groups.flatMap((group) =>
    collapsedGroupIds.has(group.id)
      ? group.threads.filter(
          (thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
        )
      : group.threads,
  );

  const { menuFor, handleMenuAction } = useThreadSectionMenu(newSection.request);

  const applyPendingSection = async (threadRef: ScopedThreadRef, section: SectionRef) =>
    (await setThreadSection(threadRef, section))._tag === "Success";
  useApplyPendingNewThreadSections({ threads: input.threads, apply: applyPendingSection });
  useEmptySectionCleanup({ threads: input.threads });

  // General starts an ordinary thread; a section files the new thread, which
  // must therefore start on the section's environment.
  const startNewThreadInSection = (group: SectionGroup<Shell> | null) => {
    const contextProjectRef = resolveThreadActionProjectRef({
      activeDraftThread: newThreadContext.activeDraftThread,
      activeThread: newThreadContext.activeThread ?? undefined,
      defaultProjectRef: newThreadContext.defaultProjectRef,
      handleNewThread: newThreadContext.handleNewThread,
    });
    const projectRef =
      group === null
        ? contextProjectRef
        : projectRefForSection(group, contextProjectRef, input.threads);
    if (projectRef === null) {
      if (group !== null && contextProjectRef !== null) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "No project to start the thread in",
            description:
              "This section is on another machine. Open a project there, then start the thread from the section.",
          }),
        );
      }
      return;
    }
    onBeforeNewThread();
    void newThreadContext.handleNewThread(projectRef).then((draft) => {
      if (draft !== null && group?.section != null && group.environmentId !== null) {
        rememberSectionForNewThread(draft.threadId, {
          environmentId: group.environmentId,
          sectionId: group.section.id,
        });
      }
    });
  };

  const renameSection = (groupId: string, name: string) => {
    setRenamingSectionId(null);
    const ref = sectionRefFromGroupId(groupId);
    if (ref === null) return;
    void catalogs.rename(ref, name).then((result) => {
      if (result === null) {
        toastManager.add(stackedThreadToast({ type: "error", title: "Failed to rename section" }));
      } else if (result.kind === "duplicate") {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `A section named “${result.existing.name}” already exists`,
          }),
        );
      }
    });
  };

  /**
   * Takes the new order of the listed groups; hidden sections keep their
   * slots. Each environment saves its own sections' order and General's place
   * among them; environments whose part is unchanged are not written.
   */
  const reorderSections = (listedOrder: readonly string[]) => {
    const before = canonicalGroups.map((group) => group.id);
    const writes = layouts.flatMap((layout) => {
      const next = environmentGroupOrder(layout.environmentId, listedOrder);
      const previous = environmentGroupOrder(layout.environmentId, before);
      if (
        next === null ||
        (previous !== null &&
          next.length === previous.length &&
          next.every((id, index) => id === previous[index]))
      ) {
        return [];
      }
      return [catalogs.reorder(layout.environmentId, next)];
    });
    void Promise.all(writes).then((saved) => {
      if (saved.some((ok) => !ok)) {
        toastManager.add(
          stackedThreadToast({ type: "error", title: "Failed to reorder sections" }),
        );
      }
    });
  };

  const deleteSection = async (group: SectionGroup<Shell>) => {
    const api = readLocalApi();
    const section = group.section;
    if (!api || section === null || group.environmentId === null) return;
    const environmentId = EnvironmentId.make(group.environmentId);
    const memberCount = input.threads.filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.environmentId === environmentId &&
        thread.sectionId === section.id,
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
    const removed = await catalogs.remove({ environmentId, sectionId: section.id });
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
          void catalogs.restore(environmentId, removed);
        },
      },
    });
  };

  const openSectionMenu = async (
    group: SectionGroup<Shell>,
    position: { x: number; y: number },
  ) => {
    const api = readLocalApi();
    if (!api || group.section === null) return;
    // Moves step over General and the listed sections of the same
    // environment: order between environments is not saved.
    const order = groups
      .filter(
        (candidate) =>
          candidate.id === GENERAL_SECTION_GROUP_ID ||
          candidate.environmentId === group.environmentId,
      )
      .map((candidate) => candidate.id);
    const index = order.indexOf(group.id);
    placement.onInteractionChange(true);
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
    placement.onInteractionChange(false);
    if (clicked._tag === "Failure" || clicked.value === null) return;
    switch (clicked.value) {
      case "new-thread":
        startNewThreadInSection(group);
        return;
      case "rename":
        setRenamingSectionId(group.id);
        return;
      case "move-up":
      case "move-down": {
        const ids = [...order];
        const target = clicked.value === "move-up" ? index - 1 : index + 1;
        ids.splice(index, 1);
        ids.splice(target, 0, group.id);
        reorderSections(ids);
        return;
      }
      case "delete":
        await deleteSection(group);
        return;
    }
  };

  const toggleGroup = (groupId: string) => {
    const legacyId = sectionRefFromGroupId(groupId)?.sectionId;
    const collapsed = collapsedGroupIds.has(groupId);
    setCollapsedIds((current) => {
      const rest = current.filter((id) => id !== groupId && id !== legacyId);
      return collapsed ? rest : [...rest, groupId];
    });
  };

  const viewProps: SidebarSectionsOwnViewProps = {
    groups,
    environmentMachines,
    canonicalGroupOrders,
    onManualPlacement,
    onInteractionChange: placement.onInteractionChange,
    collapsedGroupIds,
    routeThreadKey,
    onToggleGroup: toggleGroup,
    onReorderSections: reorderSections,
    onSectionMenu: (group, position) => void openSectionMenu(group, position),
    onNewThreadInSection: startNewThreadInSection,
    renamingSectionId,
    onRenamingSectionChange: setRenamingSectionId,
    onRenameSection: renameSection,
    onStartCreateSection: (anchor) => newSection.request([], anchor),
  };

  const toggle: ReactNode = supported ? (
    <SidebarSectionsToggle
      active={sectionsView}
      onActiveChange={(active) => {
        newSection.close();
        setViewMode(active ? "sections" : "status");
      }}
    />
  ) : null;

  return {
    /** True while the sidebar is grouped by section. */
    sectionsView,
    onInteractionChange: placement.onInteractionChange,
    visibleGroupThreads,
    viewProps,
    /** The header's grouping toggle; null when sections are unavailable. */
    toggle,
    /** The anchored creation form shared by both sidebar modes. */
    popover: newSection.popover,
    sectionMenuFor: menuFor,
    handleSectionMenuAction: handleMenuAction,
  };
}
