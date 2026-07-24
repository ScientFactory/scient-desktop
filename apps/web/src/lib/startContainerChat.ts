// FILE: startContainerChat.ts
// Purpose: Shared "ensure the hidden container project, then open a thread inside it" flow
//          used by both the home-chat and Studio new-chat hooks.
// Layer: Web orchestration helper
// Exports: Container-chat startup plus segment-aware fresh-chat dispatch.

import type { ProjectId, ThreadId } from "@synara/contracts";
import type { Project } from "../types";
import { draftNavigationSlotKey, runDraftNavigationOnce } from "./stagedDraftNavigation";
import { isStudioContainerProject } from "./studioProjects";
import type { ServerWorkspacePaths } from "./serverWorkspacePaths";
import type { NewThreadNavigationOwnership, NewThreadOptions } from "./threadBootstrap";

export type StartContainerChatResult =
  | { ok: true; threadId: ThreadId | null }
  | { ok: false; error: string };

type StartFreshContainerChat = (options: { fresh: true }) => Promise<StartContainerChatResult>;

/**
 * Starts a fresh chat in the surface that owns the active project. Thread routes are shared by
 * Projects and Studio, so callers cannot infer the surface from the URL alone.
 */
export function startFreshChatForActiveSurface(input: {
  readonly activeProject: Pick<Project, "cwd" | "kind"> | null;
  readonly isStudioRoute: boolean;
  readonly paths: ServerWorkspacePaths;
  readonly handleNewChat: StartFreshContainerChat;
  readonly handleNewStudioChat: StartFreshContainerChat;
}): Promise<StartContainerChatResult> {
  const handler =
    input.isStudioRoute || isStudioContainerProject(input.activeProject, input.paths)
      ? input.handleNewStudioChat
      : input.handleNewChat;
  return handler({ fresh: true });
}

/**
 * Resolves (creating if needed) the backing container project, then starts a thread inside it.
 * Both home chats and Studio chats share this exact flow; only the container resolver and the
 * user-facing failure label vary.
 */
export async function startContainerChat(input: {
  readonly ensureProjectId: () => Promise<ProjectId | null>;
  readonly handleNewThread: (
    projectId: ProjectId,
    options?: NewThreadOptions,
    navigation?: undefined,
    existingOwnership?: NewThreadNavigationOwnership,
  ) => Promise<ThreadId | null>;
  readonly navigationTargetKey: string;
  readonly fresh?: boolean | undefined;
  readonly errorLabel: string;
}): Promise<StartContainerChatResult> {
  try {
    return await runDraftNavigationOnce(
      draftNavigationSlotKey(),
      `container:${input.navigationTargetKey}:${input.fresh === true ? "fresh" : "reuse"}`,
      async (ownership) => {
        try {
          const projectId = await input.ensureProjectId();
          if (!ownership.isCurrent()) {
            return { ok: true, threadId: null };
          }
          if (!projectId) {
            return { ok: false, error: input.errorLabel };
          }
          const threadOptions: NewThreadOptions = {
            ...(input.fresh === true ? { fresh: true } : {}),
            workspace: { kind: "local-container" },
          };
          const threadId = await input.handleNewThread(
            projectId,
            threadOptions,
            undefined,
            ownership,
          );
          return { ok: true, threadId };
        } catch (error) {
          if (!ownership.isCurrent()) {
            return { ok: true, threadId: null };
          }
          throw error;
        }
      },
    );
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : input.errorLabel,
    };
  }
}
