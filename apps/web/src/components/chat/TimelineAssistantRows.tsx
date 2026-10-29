import { isImageAttachment } from "../../types";
import { buildExpandedImagePreview } from "./ExpandedImagePreview";
import { messageCopyHtml } from "~/scient/clipboard/messageCopyHtml";
import { ScientForkMessageButton } from "./scient-fork/ScientForkMessageButton";
import { ScientChatImageGallery } from "~/scient/images/ScientChatImageGallery";
import { shouldPreserveAssistantLineBreaks } from "@t3tools/shared/markdownPipeline";
import { type RunId } from "@t3tools/contracts";

import { memo, use } from "react";
import { type ChatMessage, type TurnDiffSummary } from "../../types";
import ChatMarkdown from "../ChatMarkdown";

import { ProposedPlanCard } from "./ProposedPlanCard";
import { HtmlRenderFrame } from "./HtmlRenderFrame";
import { McpAppFrame } from "./McpAppFrame";
import { checkpointFileTotals } from "@t3tools/client-runtime/state/thread-checkpoints";
import { ChangedFilesCard } from "./ChangedFilesTree";
import { useFileContextMenuHandler } from "../../fileContextMenu";
import { useProject, useThreadShell } from "../../state/entities";
import { MessageCopyButton } from "./MessageCopyButton";
import { AssistantCitationSource } from "./AssistantCitationSource";
import { resolveAssistantMessageCopyState } from "./MessagesTimeline.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { useUiStateStore } from "~/uiStateStore";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";

import { TimelineRowCtx, TimelineRowActivityCtx, type TimelineRow } from "./timelineRowContext";
import { MESSAGE_HEADING_LEVEL, MessageAuthorHeading } from "./TimelineRowParts";

export function AssistantTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  // SCIENT-FORK:START — an answer that is only images is not empty.
  const assistantImages = (row.message.attachments ?? []).filter(isImageAttachment);
  const messageText =
    row.message.text ||
    (row.message.streaming || assistantImages.length > 0 ? "" : "(empty response)");
  // SCIENT-FORK:END

  return (
    <>
      <div className="relative min-w-0 px-1 py-0.5">
        {/* SCIENT-FORK:START — Scient product label. */}
        <MessageAuthorHeading>Scient</MessageAuthorHeading>
        {/* SCIENT-FORK:END */}
        <div data-thread-find-text="true">
          <AssistantCitationSource
            messageId={row.message.id}
            {...(ctx.threadRef ? { threadRef: ctx.threadRef } : {})}
            itemKey={row.id}
            request={ctx.citationRequest}
            listRef={ctx.listRef}
          >
            {/* SCIENT-FORK:START — the answer's file links, content direction and images
                (scient/images/ScientChatImageGallery.tsx). */}
            <>
              <ChatMarkdown
                text={messageText}
                cwd={ctx.markdownCwd}
                threadRef={ctx.threadRef ?? undefined}
                isStreaming={Boolean(row.message.streaming)}
                messageId={row.message.id}
                changedFiles={row.assistantTurnChangedFiles}
                directionHint={row.assistantDirectionHint}
                lineBreaks={shouldPreserveAssistantLineBreaks(messageText)}
                skills={ctx.skills}
                headingLevelOffset={MESSAGE_HEADING_LEVEL}
                onUseArtifactTemplate={ctx.onUseArtifactTemplate}
                onRunShellCommand={ctx.onRunShellCommand}
                onImageExpand={ctx.onImageExpand}
              />
              <ScientChatImageGallery
                className={messageText.length > 0 ? "mt-3" : undefined}
                images={assistantImages}
                onExpand={(imageId) => {
                  const preview = buildExpandedImagePreview(assistantImages, imageId);
                  if (preview) ctx.onImageExpand(preview);
                }}
              />
              {/* SCIENT-FORK:START — the end of the answer's readable content (withReadingEnd). */}
              <span data-reading-end="true" aria-hidden="true" className="block h-0" />
              {/* SCIENT-FORK:END */}
            </>
            {/* SCIENT-FORK:END */}
          </AssistantCitationSource>
        </div>
        {ctx.onOpenTurnDiff ? (
          <AssistantChangedFilesSection
            turnSummary={row.assistantTurnDiffSummary}
            routeThreadKey={ctx.routeThreadKey}
            resolvedTheme={ctx.resolvedTheme}
            onOpenTurnDiff={ctx.onOpenTurnDiff}
          />
        ) : null}
        {/* SCIENT-FORK:START — a kept answer shows its copy button and time like the final answer. */}
        {row.showAssistantMeta || row.keptAnswer === true ? (
          // SCIENT-FORK:END
          <AssistantMessageMeta
            className="mt-1.5"
            projectedItem={row.projectedItem}
            message={row.message}
            showCopyButton={row.showAssistantCopyButton}
            copyStreaming={row.assistantCopyStreaming}
            // SCIENT-FORK:START — Scient fork V2 from the final answer.
            canForkConversation={row.canForkConversation}
            // SCIENT-FORK:END
          />
        ) : null}
      </div>
    </>
  );
}

export function AssistantMetaTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "assistant-meta" }>;
}) {
  return (
    <div className="px-1">
      <AssistantMessageMeta
        className="mt-0.5"
        projectedItem={row.projectedItem}
        message={row.message}
        showCopyButton={row.showAssistantCopyButton}
        copyStreaming={row.assistantCopyStreaming}
        // SCIENT-FORK:START
        canForkConversation={row.canForkConversation}
        // SCIENT-FORK:END
        alwaysVisible
      />
    </div>
  );
}

function AssistantMessageMeta({
  className,
  projectedItem,
  message,
  showCopyButton,
  copyStreaming,
  // SCIENT-FORK:START
  canForkConversation,
  // SCIENT-FORK:END
  alwaysVisible = false,
}: {
  className?: string;
  projectedItem?: Extract<TimelineRow, { kind: "message" }>["projectedItem"];
  message: ChatMessage;
  showCopyButton: boolean;
  copyStreaming: boolean;
  // SCIENT-FORK:START
  canForkConversation?: boolean | undefined;
  // SCIENT-FORK:END
  alwaysVisible?: boolean;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div
      className={cn(
        "flex items-center gap-2 text-xs tabular-nums transition-opacity duration-200",
        alwaysVisible
          ? "opacity-100"
          : "opacity-0 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/assistant:opacity-100",
        className,
      )}
    >
      {projectedItem && projectedItem.item.status !== "completed" ? (
        <span className="rounded-full border border-border/70 px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
          {projectedItem.item.status}
        </span>
      ) : null}
      <AssistantCopyButton
        message={message}
        showCopyButton={showCopyButton}
        streaming={copyStreaming}
      />
      {/* SCIENT-FORK:START — Scient fork V2 replaces upstream's "Fork from this response". */}
      {canForkConversation === true && ctx.onForkAssistantMessage ? (
        <ScientForkMessageButton onFork={() => ctx.onForkAssistantMessage?.(message.id)} />
      ) : null}
      {/* SCIENT-FORK:END */}
      {!message.streaming && (
        <Tooltip>
          <TooltipTrigger render={<p className="text-muted-foreground text-xs tabular-nums" />}>
            {formatDayAwareTimestamp(message.updatedAt, ctx.timestampFormat)}
          </TooltipTrigger>
          <TooltipPopup>
            {formatChatTimestampTooltip(message.updatedAt, ctx.timestampFormat)}
          </TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}

function AssistantCopyButton({
  message,
  showCopyButton,
  streaming,
}: {
  message: ChatMessage;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const assistantCopyState = resolveAssistantMessageCopyState({
    text: message.text ?? null,
    showCopyButton,
    streaming,
  });

  if (!assistantCopyState.visible) {
    return null;
  }

  return (
    <MessageCopyButton
      text={assistantCopyState.text ?? ""}
      // SCIENT-FORK:START — right-to-left messages also copy as direction-marked HTML
      resolveHtml={(anchor) =>
        messageCopyHtml({
          anchor,
          messageId: message.id,
          markdown: assistantCopyState.text ?? "",
          lineBreaks: shouldPreserveAssistantLineBreaks(assistantCopyState.text ?? ""),
          parseRawHtml: true,
        })
      }
      // SCIENT-FORK:END
      variant="ghost"
    />
  );
}

export function ProposedPlanTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "proposed-plan" }>;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div className="min-w-0 px-1 py-0.5">
      <ProposedPlanCard
        planMarkdown={row.proposedPlan.planMarkdown}
        environmentId={ctx.activeThreadEnvironmentId}
        threadRef={ctx.threadRef ?? undefined}
        cwd={ctx.markdownCwd}
        workspaceRoot={ctx.workspaceRoot}
        findActive={ctx.findActive}
      />
    </div>
  );
}

export function HtmlRenderTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "html-render" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const { onAppFullscreenChange } = ctx;
  const onFullscreenChange = (fullscreen: boolean) => onAppFullscreenChange(row.id, fullscreen);

  if (ctx.renderHtmlRender) {
    return <div className="min-w-0 px-1">{ctx.renderHtmlRender(row)}</div>;
  }
  return (
    <div className="min-w-0 px-1">
      <HtmlRenderFrame
        key={row.htmlRender.attachmentId}
        environmentId={ctx.activeThreadEnvironmentId}
        htmlRender={row.htmlRender}
        threadRef={ctx.threadRef ?? undefined}
        onFullscreenChange={onFullscreenChange}
        // SCIENT-FORK:START — Open in panel (source, Save) beside upstream's full screen.
        onOpen={ctx.onFileOpen}
        // SCIENT-FORK:END
      />
    </div>
  );
}

export function McpAppTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "mcp-app" }> }) {
  const ctx = use(TimelineRowCtx);
  const { awaitingUser } = use(TimelineRowActivityCtx);

  return (
    <div className="min-w-0 px-1">
      <McpAppFrame
        key={row.mcpApp.attachmentId}
        environmentId={ctx.activeThreadEnvironmentId}
        threadId={row.sourceThreadId}
        conversationThreadId={ctx.threadRef?.threadId ?? row.sourceThreadId}
        itemId={row.itemId}
        revision={row.revision}
        app={row.mcpApp}
        onSendMessage={ctx.onSendAppMessage}
        awaitingUser={awaitingUser}
        onFullscreenChange={(fullscreen) => ctx.onAppFullscreenChange(row.id, fullscreen)}
      />
    </div>
  );
}

/** Subscribes directly to the UI state store for expand/collapse state,
 *  so toggling re-renders only this component — not the entire list. */
const AssistantChangedFilesSection = memo(function AssistantChangedFilesSection({
  turnSummary,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary | undefined;
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  displayThreadKey?: string;
  onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
}) {
  if (!turnSummary) return null;
  const checkpointFiles = turnSummary.files;
  if (checkpointFiles.length === 0) return null;

  return (
    <AssistantChangedFilesSectionInner
      turnSummary={turnSummary}
      checkpointFiles={checkpointFiles}
      routeThreadKey={routeThreadKey}
      resolvedTheme={resolvedTheme}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  );
});

function AssistantChangedFilesSectionInner({
  turnSummary,
  checkpointFiles,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary;
  checkpointFiles: TurnDiffSummary["files"];
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  displayThreadKey?: string;
  onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
}) {
  const ctx = use(TimelineRowCtx);
  const persistedExpanded = useUiStateStore(
    (store) => store.threadChangedFilesExpandedById[routeThreadKey]?.[turnSummary.runId],
  );
  const setExpanded = useUiStateStore((store) => store.setThreadChangedFilesExpanded);
  const allDirectoriesExpanded = persistedExpanded ?? false;

  const thread = useThreadShell(ctx.threadRef);
  const activeProject = useProject(
    thread && thread.projectId
      ? { environmentId: thread.environmentId, projectId: thread.projectId }
      : null,
  );
  const onFileContextMenu = useFileContextMenuHandler(ctx.activeThreadEnvironmentId);

  return (
    <ChangedFilesCard
      runId={turnSummary.runId}
      files={checkpointFiles}
      totals={checkpointFileTotals(turnSummary)}
      allDirectoriesExpanded={allDirectoriesExpanded}
      resolvedTheme={resolvedTheme}
      onToggleAllDirectories={() =>
        setExpanded(routeThreadKey, turnSummary.runId, !allDirectoriesExpanded)
      }
      onOpenTurnDiff={onOpenTurnDiff}
      onFileContextMenu={(filePath, event) =>
        onFileContextMenu(
          {
            environmentId: ctx.activeThreadEnvironmentId,
            filePath,
            workspaceRoot: ctx.workspaceRoot,
            repositoryRoot:
              thread?.worktreePath == null
                ? activeProject?.repositoryIdentity?.rootPath
                : undefined,
          },
          event,
        )
      }
    />
  );
}
