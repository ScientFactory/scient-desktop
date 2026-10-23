import {
  CommandId,
  MessageId,
  ThreadId,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationMessageContext,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import { collectSelectedScientSkillNames } from "@t3tools/shared/composerInlineTokens";
import { composerCitationsToPlainText } from "@t3tools/shared/composerCitations";
import {
  deriveThreadTitleSeed as deriveSharedThreadTitleSeed,
  threadTitleTextFromPrompt,
} from "@t3tools/client-runtime/operations";

export function deriveThreadTitleFromPrompt(value: string): string {
  const title = threadTitleTextFromPrompt(composerCitationsToPlainText(value)) || "New thread";
  return title.length <= 72 ? title : `${title.slice(0, 69).trimEnd()}...`;
}

// SCIENT-FORK:START — file quotes keep readable titles through the shared context normalizer.
export function deriveThreadTitleSeed(input: {
  readonly text: string;
  readonly attachments: ReadonlyArray<Pick<ChatAttachment, "type" | "name">>;
}): string {
  return deriveSharedThreadTitleSeed({
    ...input,
    text: composerCitationsToPlainText(input.text),
    attachments: input.attachments.map((attachment) => ({
      ...attachment,
      name: composerCitationsToPlainText(attachment.name),
    })),
  });
}
// SCIENT-FORK:END

export interface ProjectThreadStartTurnSpec {
  readonly projectId: ProjectId;
  readonly projectCwd: string;
  readonly threadId: string;
  readonly commandId: string;
  readonly messageId: string;
  readonly createdAt: string;
  readonly text: string;
  readonly titleText?: string;
  readonly context?: OrchestrationMessageContext;
  /** Wire attachments in composer order: freshly uploaded ones from
   * `prepareTurnAttachments`, or the server's own persisted copies when a
   * thread is relaunched from its setup message. */
  readonly uploadedAttachments: ReadonlyArray<ChatAttachment | UploadChatAttachment>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceMode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin: boolean;
  readonly worktreeBranchName: string;
}

export function buildProjectThreadStartTurnInput(spec: ProjectThreadStartTurnSpec) {
  const title = deriveThreadTitleSeed({
    text: spec.titleText ?? spec.text,
    attachments: spec.uploadedAttachments,
  });
  const isWorktree = spec.workspaceMode === "worktree";
  return {
    creationSource: "mobile" as const,
    commandId: CommandId.make(spec.commandId),
    selectedScientSkillNames: collectSelectedScientSkillNames(spec.text),
    threadId: ThreadId.make(spec.threadId),
    message: {
      messageId: MessageId.make(spec.messageId),
      role: "user" as const,
      text: spec.text,
      ...(spec.context ? { context: spec.context } : {}),
      attachments: spec.uploadedAttachments,
    },
    modelSelection: spec.modelSelection,
    titleSeed: title,
    runtimeMode: spec.runtimeMode,
    interactionMode: spec.interactionMode,
    bootstrap: {
      createThread: {
        projectId: spec.projectId,
        title,
        modelSelection: spec.modelSelection,
        runtimeMode: spec.runtimeMode,
        interactionMode: spec.interactionMode,
        branch: spec.branch,
        worktreePath: isWorktree ? null : spec.worktreePath,
        createdAt: spec.createdAt,
      },
      ...(isWorktree
        ? {
            prepareWorktree: {
              projectCwd: spec.projectCwd,
              baseBranch: spec.branch!,
              branch: spec.worktreeBranchName,
              ...(spec.startFromOrigin ? { startFromOrigin: true } : {}),
            },
            runSetupScript: true,
          }
        : {}),
    },
    createdAt: spec.createdAt,
  };
}
