import { useAtomValue } from "@effect/atom-react";
import { shortcutLabelForCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import type { DraftId } from "~/composerDraftStore";
import { useComposerDraftStore } from "~/composerDraftStore";
import { resolveEnvironmentMachineKind, type ScopedProjectRef } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
// SCIENT-FORK:START — the project chip above the composer; the sentence no longer embeds it.
import { T, useGT } from "gt-react";
import { ChevronDownIcon, FolderIcon, FolderPlusIcon, XIcon } from "lucide-react";
// SCIENT-FORK:END
import { useRef, useState } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useOrderWhileOpen } from "~/hooks/useOrderWhileOpen";
import { moveDraftToProject } from "~/lib/moveDraftToProject";
import { useProjectPin } from "~/hooks/useProjectGroupUpdate";
import { useScratchProject } from "~/hooks/useScratchProject";
import { isTriagePrompt } from "@t3tools/shared/triagePrompt";
import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import {
  buildSidebarProjectPickerEntries,
  projectGroupsSpanEnvironments,
} from "~/sidebarProjectGrouping";
import { useProjects } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectFavicon } from "../ProjectFavicon";
import { isProjectPinShortcut, ProjectPinButton } from "../ProjectPinButton";
import { useSortedProjectGroups } from "../CommandPaletteLookups";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  useComboboxFilter,
} from "../ui/combobox";
import { Tooltip, TooltipPopup, TooltipScrollDismissArea, TooltipTrigger } from "../ui/tooltip";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
// SCIENT-FORK:START — the project chip above the composer replaces the heading's inline picker.
import { Button } from "../ui/button";
import { DraftProjectName } from "./DraftProjectName";
// SCIENT-FORK:END
import { TriageDraftHero } from "./TriageDraftHero";

const ADD_PROJECT_VALUE = "add-project";
// SCIENT-FORK:START — "No project" is the chip's last choice instead of a line under the heading.
const NO_PROJECT_VALUE = "no-project";
// SCIENT-FORK:END

interface PickerItem {
  readonly value: string;
  readonly label: string;
}

interface DraftHeroHeadlineProps {
  readonly draftId: DraftId | null;
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
}

export function DraftHeroHeadline({
  draftId,
  activeProjectRef,
  activeProjectTitle,
}: DraftHeroHeadlineProps) {
  const gt = useGT();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // A boolean, so typing in a draft does not re-render the hero.
  const isTriageDraftPrompt = useComposerDraftStore((store) =>
    draftId ? isTriagePrompt(store.getComposerDraft(draftId)?.prompt ?? "") : false,
  );
  const openAddProject = () => openCommandPalette({ open: "add-project", draftId });
  const { scratchEnvironmentId, scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const openProjectDraft = useNewThreadHandler();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const pickerFilter = useComboboxFilter();
  const highlightedPickerValueRef = useRef<string | null>(null);
  const { canPinProjectGroup, toggleProjectGroupPin } = useProjectPin();

  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const projectGroups = useSortedProjectGroups(environmentLabelById);
  const showProjectEnvironments = projectGroupsSpanEnvironments(projectGroups);
  const environmentMachineById = new Map(
    environments.map(
      (environment) =>
        [
          environment.environmentId,
          resolveEnvironmentMachineKind(environment.serverConfig),
        ] as const,
    ),
  );
  const projectPickerEntries = buildSidebarProjectPickerEntries({
    groups: pickableProjectGroups(projectGroups),
    preferredProjectRef: activeProjectRef,
  });
  const projectEntryByKey = new Map(
    projectPickerEntries.map((entry) => [entry.group.projectKey, entry] as const),
  );
  const activeProjectGroup =
    activeProjectRef?.projectId == null
      ? null
      : (projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (projectRef) =>
              projectRef.environmentId === activeProjectRef.environmentId &&
              projectRef.projectId === activeProjectRef.projectId,
          ),
        ) ?? null);
  const activeProjectKey = activeProjectGroup?.projectKey ?? "";
  // The selected checkout's title leads; the group name covers a resolved
  // project whose title has not arrived yet.
  const activeProjectDisplayName = activeProjectTitle ?? activeProjectGroup?.displayName ?? null;
  const hasResolvedProject =
    activeProjectRef?.projectId != null &&
    (activeProjectGroup !== null || activeProjectTitle !== null);
  // SCIENT-FORK:START — shouldShowProjectMenu moved below, where it also counts No project.
  const canChooseProject = projectPickerEntries.length > 0;
  // SCIENT-FORK:END
  const menuEntries = projectPickerEntries.filter(
    ({ targetProject }) =>
      !isScratchProject(targetProject, scratchWorkspaceRootFor(targetProject.environmentId)),
  );
  const activeProject =
    activeProjectRef === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === activeProjectRef.environmentId &&
            project.id === activeProjectRef.projectId,
        ) ?? null);
  const scratchTargetEnvironmentId = scratchEnvironmentId(activeProjectRef?.environmentId ?? null);
  const scratchWorkspaceRoot = scratchWorkspaceRootFor(scratchTargetEnvironmentId);
  const isScratchDraft =
    activeProject !== null &&
    isScratchProject(activeProject, scratchWorkspaceRootFor(activeProject.environmentId));
  // SCIENT-FORK:START — the chip's menu also offers No project, so it shows when only that does.
  const canStartScratch = scratchWorkspaceRoot !== null && !isScratchDraft;
  const shouldShowProjectMenu = canChooseProject || canStartScratch;
  // SCIENT-FORK:END

  // Pinning from a row keeps rows in place while the picker is open.
  // SCIENT-FORK:START — only project rows keep their order; the actions always come last.
  const orderedProjectItems: readonly PickerItem[] = useOrderWhileOpen(
    menuEntries.map(({ group }) => ({ value: group.projectKey, label: group.displayName })),
    (item) => item.value,
    pickerOpen,
  );
  const pickerItems: readonly PickerItem[] = [
    ...orderedProjectItems,
    { value: ADD_PROJECT_VALUE, label: gt("Add project") },
    ...(canStartScratch ? [{ value: NO_PROJECT_VALUE, label: gt("No project") }] : []),
  ];
  // SCIENT-FORK:END
  const pickerSearch = pickerQuery.trim();
  const filteredPickerItems =
    pickerSearch.length === 0
      ? pickerItems
      : pickerItems.filter(
          (item) =>
            item.value !== ADD_PROJECT_VALUE &&
            // SCIENT-FORK:START
            item.value !== NO_PROJECT_VALUE &&
            // SCIENT-FORK:END
            pickerFilter.contains(item, pickerSearch, (candidate) => candidate.label),
        );
  const selectedPickerItem = pickerItems.find((item) => item.value === activeProjectKey) ?? null;

  // The picker can change the draft's target while the no-project home is
  // still being opened; a stale continuation must not retarget it again. Picking
  // a project clears the pending request, and the draft session is compared
  // against the store when the scratch project arrives.
  const pendingScratchRef = useRef<symbol | null>(null);
  const draftTargetKey = () => {
    const session = draftId ? useComposerDraftStore.getState().getDraftSession(draftId) : null;
    return session
      ? `${session.environmentId}:${session.projectId}:${session.logicalProjectKey}`
      : null;
  };
  const selectProject = (project: (typeof projects)[number]) => {
    if (!draftId) {
      return;
    }
    pendingScratchRef.current = null;
    if (!moveDraftToProject(draftId, project)) {
      void openProjectDraft(scopeProjectRef(project.environmentId, project.id));
    }
  };
  const startScratch = async (): Promise<boolean> => {
    if (scratchTargetEnvironmentId === null || isScratchDraft) {
      return false;
    }
    const request = Symbol("scratch");
    pendingScratchRef.current = request;
    const requestedTarget = draftTargetKey();
    const project = await openScratchProject(scratchTargetEnvironmentId);
    if (!project || pendingScratchRef.current !== request || draftTargetKey() !== requestedTarget) {
      return false;
    }
    pendingScratchRef.current = null;
    selectProject(project);
    return true;
  };

  const projectSelector = shouldShowProjectMenu ? (
    <Combobox
      items={pickerItems}
      filteredItems={filteredPickerItems}
      autoHighlight
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      open={pickerOpen}
      onItemHighlighted={(item) => {
        highlightedPickerValueRef.current = item?.value ?? null;
      }}
      onOpenChange={(open) => {
        setPickerOpen(open);
        setPickerQuery("");
      }}
      value={selectedPickerItem}
      // SCIENT-FORK:START — Add project and No project run only from a click or Enter on their
      // row, never from a letter typed on the closed chip.
      onValueChange={(item, details) => {
        if (!item) return;
        setPickerOpen(false);
        if (item.value === ADD_PROJECT_VALUE || item.value === NO_PROJECT_VALUE) {
          if (details.reason !== "item-press") return;
          if (item.value === ADD_PROJECT_VALUE) openAddProject();
          else void startScratch();
          return;
        }
        // SCIENT-FORK:END
        const entry = projectEntryByKey.get(item.value);
        if (!entry || item.value === activeProjectKey) {
          return;
        }
        selectProject(entry.targetProject);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComboboxTrigger
              // SCIENT-FORK:START — a chip above the composer, as the strip below it uses.
              render={<Button variant="ghost-muted" size="compact" />}
              data-draft-project-trigger=""
              className="pointer-events-auto min-w-0 max-w-full"
              // SCIENT-FORK:END
            />
          }
        >
          {/* SCIENT-FORK:START */}
          {isScratchDraft ? (
            <XIcon className="shrink-0" />
          ) : activeProjectGroup ? (
            <ProjectFavicon project={activeProjectGroup} className="size-3.5 shrink-0" />
          ) : (
            <FolderIcon className="shrink-0" />
          )}
          <DraftProjectName
            value={
              isScratchDraft
                ? gt("No project")
                : (activeProjectDisplayName ?? gt("Choose a workspace"))
            }
            singleLine
          />
          <ChevronDownIcon className="shrink-0 opacity-60" />
          {/* SCIENT-FORK:END */}
        </TooltipTrigger>
        {activeProjectDisplayName && !isScratchDraft ? (
          <TooltipPopup side="top">{activeProjectDisplayName}</TooltipPopup>
        ) : null}
      </Tooltip>
      {/* SCIENT-FORK:START — opens from the chip's left edge. */}
      <ComboboxPopup
        align="start"
        className="w-72 overflow-hidden"
        render={<TooltipScrollDismissArea holdPositionOnExit />}
      >
        {/* SCIENT-FORK:END */}
        <ComboboxSearchInput
          aria-label={gt("Search projects")}
          placeholder={gt("Search projects...")}
          value={pickerQuery}
          onChange={(event) => setPickerQuery(event.target.value)}
          onKeyDown={(event) => {
            const highlighted = highlightedPickerValueRef.current;
            const group = highlighted ? projectEntryByKey.get(highlighted)?.group : undefined;
            if (!group || !canPinProjectGroup(group) || !isProjectPinShortcut(event, keybindings)) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            toggleProjectGroupPin(group);
          }}
        />
        <ComboboxEmpty>
          <T>No matching projects.</T>
        </ComboboxEmpty>
        <ComboboxList>
          {(item: PickerItem) => {
            const entry = projectEntryByKey.get(item.value);
            return (
              <ComboboxItem key={item.value} hideIndicator value={item}>
                {/* SCIENT-FORK:START — No project's icon. */}
                {item.value === ADD_PROJECT_VALUE ? (
                  <FolderPlusIcon className="size-4 shrink-0" />
                ) : item.value === NO_PROJECT_VALUE ? (
                  <XIcon className="size-4 shrink-0" />
                ) : entry ? (
                  <ProjectFavicon project={entry.group} className="size-4 shrink-0" />
                ) : null}
                {/* SCIENT-FORK:END */}
                <SharedTooltipTrigger
                  render={<span className="min-w-0 flex-1 text-sm" />}
                  label={item.label}
                >
                  <DraftProjectName value={item.label} />
                </SharedTooltipTrigger>
                {entry && canPinProjectGroup(entry.group) ? (
                  <ProjectPinButton
                    name={entry.group.displayName}
                    pinned={entry.group.pinned}
                    shortcutLabel={shortcutLabelForCommand(keybindings, "thread.pin")}
                    onToggle={() => toggleProjectGroupPin(entry.group)}
                  />
                ) : null}
                {entry && showProjectEnvironments ? (
                  <ProjectEnvironmentBadge
                    group={entry.group}
                    primaryEnvironmentId={primaryEnvironmentId}
                    machineByEnvironmentId={environmentMachineById}
                  />
                ) : null}
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  ) : (
    // SCIENT-FORK:START — without projects the chip adds one; the "or start without a project"
    // line is the chip's No project item.
    <Button
      variant="ghost-muted"
      size="compact"
      onClick={openAddProject}
      className="pointer-events-auto min-w-0 max-w-full"
    >
      <FolderPlusIcon className="shrink-0" />
      <DraftProjectName value={activeProjectTitle ?? gt("Add a project")} singleLine />
    </Button>
  );
  // SCIENT-FORK:END

  if (isScratchDraft && isTriageDraftPrompt) {
    const environment = environments.find(
      (entry) => entry.environmentId === activeProject.environmentId,
    );
    return (
      <TriageDraftHero
        machineLabel={environment?.label ?? null}
        serverVersion={environment?.serverConfig?.environment.serverVersion ?? null}
      />
    );
  }

  // SCIENT-FORK:START — one question, with the project chosen in a chip above the composer.
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col">
      <h1 className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl [@media(max-height:28rem)]:sr-only">
        {hasResolvedProject || isScratchDraft || canChooseProject || canStartScratch ? (
          <T>What should we work on?</T>
        ) : (
          <T>Add a project to start</T>
        )}
      </h1>
      <div className="mt-6 flex w-full min-w-0 items-center">{projectSelector}</div>
    </div>
  );
  // SCIENT-FORK:END
}
