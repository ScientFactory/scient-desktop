import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { resolvePromptLinkModelSelection } from "@t3tools/client-runtime/prompt-links";
import { AuthOrchestrationOperateScope, type ServerProvider } from "@t3tools/contracts";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useProjects } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import type {
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
  ServerProviderSkill,
  ThreadId,
} from "@t3tools/contracts";
import { scientManagedSkillReleaseKey } from "@t3tools/client-runtime/providerSkills";

import { useRightPanelStore } from "~/rightPanelStore";
import { scientSkillSurface } from "~/scient/rightPanel/surfaces";
import { useEnvironmentQuery } from "../../state/query.ts";
import { resolveScientSkillListInput } from "./scientSkillListInput.ts";
import { scientSkillsInventory } from "./scientSkillsState.ts";

/** The Scient skill inventory the composer offers for this thread or draft. */
export function useScientComposerSkills(input: {
  readonly environmentId: EnvironmentId;
  readonly routeKind: "server" | "draft";
  readonly threadId: ThreadId | null;
  readonly projectId: ProjectId | null;
}) {
  const { environmentId, routeKind, threadId, projectId } = input;
  return useEnvironmentQuery(
    scientSkillsInventory({
      environmentId,
      input: resolveScientSkillListInput({
        routeKind,
        threadId,
        projectId,
      }),
    }),
  ).data;
}

/**
 * Open a skill chip from the composer: provider skills open their file, and a
 * Scient-managed skill opens its installed file or, failing that, its
 * document surface in the right panel.
 */
export function openComposerSkill(
  skill: ServerProviderSkill,
  context: {
    readonly routeThreadRef: ScopedThreadRef;
    readonly scientSkills: ReturnType<typeof useScientComposerSkills>;
  },
): void {
  const { routeThreadRef, scientSkills } = context;
  const releaseKey = scientManagedSkillReleaseKey(skill);
  if (releaseKey === null) {
    useRightPanelStore.getState().openFile(routeThreadRef, skill.path);
    return;
  }
  const managedSkill = scientSkills?.skills.find(
    (candidate) => candidate.releaseKey === releaseKey,
  );
  if (managedSkill?.path) {
    useRightPanelStore.getState().openFile(routeThreadRef, managedSkill.path);
    return;
  }
  useRightPanelStore.getState().openScient(
    routeThreadRef,
    scientSkillSurface({
      releaseKey,
      title: formatProviderSkillDisplayName(skill),
    }),
  );
}

export const composerSkillPrompt = (name: string) => `$${name} `;

export function useTryComposerSkill(
  environmentId: EnvironmentId,
  provider: ServerProvider | undefined,
  name: string,
  cwd?: string,
) {
  const projects = useProjects();
  const newThread = useNewThreadHandler();
  const { openScratchProject, scratchWorkspaceRootFor } = useScratchProject();
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const selection = provider
    ? resolvePromptLinkModelSelection([provider], {
        provider: provider.driver.toLowerCase(),
        model: null,
      })?.selection
    : undefined;
  const project = cwd
    ? projects.find((item) => item.environmentId === environmentId && item.workspaceRoot === cwd)
    : undefined;
  if (!canOperate || !selection || (cwd ? !project : !scratchWorkspaceRootFor(environmentId)))
    return undefined;
  return async () => {
    const target = project ?? (await openScratchProject(environmentId));
    if (!target) throw new Error("Could not open a project for this skill.");
    const opened = await newThread(
      scopeProjectRef(environmentId, target.id),
      cwd ? { envMode: "local" as const } : {},
    );
    if (!opened) throw new Error("Could not open a new draft.");
    const drafts = useComposerDraftStore.getState();
    drafts.setModelSelection(opened.draftId, selection, { explicit: true, replaceOptions: true });
    drafts.setPrompt(
      opened.draftId,
      composerSkillPrompt(name) + (drafts.getComposerDraft(opened.draftId)?.prompt ?? ""),
    );
  };
}
