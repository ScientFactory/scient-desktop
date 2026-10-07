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
import { truncate } from "@t3tools/shared/String";

export function deriveThreadTitleFromPrompt(value: string): string {
  const trimmed = composerCitationsToPlainText(value).trim();
  if (trimmed.length === 0) {
    return "New thread";
  }

  const compact = trimmed.replace(/\s+/g, " ");
  return compact.length <= 72 ? compact : `${compact.slice(0, 69).trimEnd()}...`;
}

/**
 * Title seed for a new thread.
 *
 * SCIENT-FORK:START — same shape as client-runtime's `deriveThreadTitleSeed`, but
 * keeps `composerCitationsToPlainText`: it renders file quotes that
 * `assistantCitationsToPlainText` drops, and a thread started from a cited file
 * should be titled from what the user actually sees.
 * SCIENT-FORK:END
 */
export function deriveThreadTitleSeed(input: {
  readonly text: string;
  readonly attachments: ReadonlyArray<{ readonly name: string }>;
}): string {
  const text = composerCitationsToPlainText(input.text).trim().replace(/\s+/gu, " ");
  if (text.length > 0) {
    return truncate(text);
  }

  const attachmentName = composerCitationsToPlainText(input.attachments[0]?.name ?? "")
    .trim()
    .replace(/\s+/gu, " ");
  if (attachmentName.length > 0) {
    return truncate(`Image: ${attachmentName}`);
  }

  return "New thread";
}

export interface ProjectThreadStartTurnSpec {
  readonly projectId: ProjectId;
  readonly projectCwd: string;
  readonly threadId: string;
  readonly commandId: string;
  readonly messageId: string;
  readonly createdAt: string;
  readonly text: string;
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
  /** Generated temp branch for worktree mode; unused for local mode. */
  readonly worktreeBranchName: string;
}

/**
 * Single source of the `thread.turn.start` bootstrap payload used to create a
 * thread from a project draft — shared by the immediate send path and the
 * offline outbox drain so both deliver identical commands.
 */
export function buildProjectThreadStartTurnInput(spec: ProjectThreadStartTurnSpec) {
  const title = deriveThreadTitleSeed({
    text: spec.text,
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
