import type {
  MessageId,
  ConversationAttachment,
  ConversationMessage,
  ConversationQuestionAnswer,
  ConversationWorkLogEntry,
} from "@t3tools/contracts";
import { shouldPreserveAssistantLineBreaks } from "@scientfactory/conversation/work-log-grouping";
import type { CloudConversation } from "@scientfactory/scient-cloud/api";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { ChevronRightIcon, FileIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Button } from "~/components/ui/button";
import { MESSAGE_HEADING_LEVEL } from "~/components/chat/TimelineRowParts";
import { cn } from "~/lib/utils";

import { SharedHtmlFrame } from "./SharedHtmlFrame";
import {
  readerMessageMarkdown,
  repositoryFileUrl,
  type SnapshotRepository,
} from "./snapshotMarkdown";
import {
  attachmentBlobSha256,
  buildSnapshotRows,
  type SnapshotAnswerModel,
  type SnapshotRow,
  type SnapshotWorkStep,
} from "./snapshotTimeline";

/** Bytes behind a blob the conversation names: an attachment or a rendered visual. */
export type SnapshotBlobLoader = (sha256: string) => Promise<Blob>;

/** What a share preview adds to the conversation. */
export interface SnapshotPreview {
  /** Messages holding something that was blanked out. */
  readonly markedMessageIds: ReadonlySet<string>;
  /** One action beside each message, such as "Leave out". */
  readonly messageAction?: {
    readonly label: string;
    readonly onSelect: (messageId: MessageId) => void;
  };
}

export interface SnapshotConversationViewProps {
  readonly conversation: CloudConversation;
  readonly loadBlob?: SnapshotBlobLoader | undefined;
  /** The content shim's origin; production uses `share.scientusercontent.com`. */
  readonly contentOrigin?: string | undefined;
  readonly preview?: SnapshotPreview | undefined;
  readonly className?: string | undefined;
}

/**
 * A conversation read from its snapshot: a cloud copy, a shared link or a share preview. It renders
 * with chat's Markdown and folds each finished turn's work the way chat does, without any
 * connection to the computer the conversation ran on.
 */
export function SnapshotConversationView({
  conversation,
  loadBlob,
  contentOrigin,
  preview,
  className,
}: SnapshotConversationViewProps) {
  const rows = buildSnapshotRows(conversation);
  const repository = conversation.sidecar?.repository;
  const renders = conversation.sidecar?.renders ?? [];
  const rendersAfter = (messageId: string | null) =>
    renders.filter((render) => render.messageId === messageId);
  const context: RowContext = { conversation, repository, loadBlob, preview };

  return (
    <div
      className={cn("mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4", className)}
      data-testid="snapshot-conversation"
    >
      {rows.map((row) => (
        <div key={row.id} className="min-w-0">
          <SnapshotRowView row={row} context={context} />
          {row.kind === "assistant" && loadBlob
            ? rendersAfter(row.message.id).map((render) => (
                <BlobHtmlFrame
                  key={render.id}
                  title={render.name}
                  sha256={render.sha256}
                  loadBlob={loadBlob}
                  contentOrigin={contentOrigin}
                />
              ))
            : null}
        </div>
      ))}
      {loadBlob
        ? rendersAfter(null).map((render) => (
            <BlobHtmlFrame
              key={render.id}
              title={render.name}
              sha256={render.sha256}
              loadBlob={loadBlob}
              contentOrigin={contentOrigin}
            />
          ))
        : null}
      {conversation.snapshot.omittedRunningTurn !== null ? (
        <p className="px-1 text-xs text-muted-foreground">
          The last response was still being written when this copy was made.
        </p>
      ) : null}
    </div>
  );
}

interface RowContext {
  readonly conversation: CloudConversation;
  readonly repository: SnapshotRepository | undefined;
  readonly loadBlob: SnapshotBlobLoader | undefined;
  readonly preview: SnapshotPreview | undefined;
}

function SnapshotRowView({ row, context }: { row: SnapshotRow; context: RowContext }) {
  switch (row.kind) {
    case "user":
      return <UserMessage message={row.message} context={context} />;
    case "assistant":
      return <AssistantMessage message={row.message} model={row.model} context={context} />;
    case "fold":
      return (
        <Disclosure summary={row.label}>
          <div className="flex flex-col gap-1.5 py-1">
            {row.steps.map((step) => (
              <WorkStep key={step.id} step={step} repository={context.repository} />
            ))}
          </div>
        </Disclosure>
      );
    case "step":
      return <WorkStep step={row.step} repository={context.repository} />;
    case "plan":
      return (
        <section className="rounded-xl border border-border px-4 py-3">
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">Plan</h4>
          <ChatMarkdown text={row.plan.markdown} cwd={undefined} headingLevelOffset={4} />
        </section>
      );
    case "answer":
      return <QuestionAnswer answer={row.answer} />;
  }
}

function MessageFrame({
  message,
  context,
  children,
}: {
  message: ConversationMessage;
  context: RowContext;
  children: ReactNode;
}) {
  const marked = context.preview?.markedMessageIds.has(message.id) ?? false;
  const action = context.preview?.messageAction;
  return (
    <div
      className={cn(
        "group/row relative flex min-w-0 gap-2",
        message.role === "user" ? "flex-row-reverse" : "flex-row",
      )}
      data-message-id={message.id}
      data-marked={marked ? "true" : undefined}
    >
      <div
        className={cn(
          "min-w-0",
          message.role === "user" ? "flex max-w-[80%] flex-col items-end" : "flex-1",
          marked && "rounded-md ring-1 ring-warning/50 ring-offset-4 ring-offset-background",
        )}
      >
        {children}
      </div>
      {action ? (
        <div className="shrink-0 pt-1">
          <Button size="xs" variant="ghost-muted-row" onClick={() => action.onSelect(message.id)}>
            {action.label}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function UserMessage({ message, context }: { message: ConversationMessage; context: RowContext }) {
  const text = readerMessageMarkdown(message, context.repository);
  return (
    <MessageFrame message={message} context={context}>
      {text.trim() === "" ? null : (
        <div className="min-w-0 rounded-2xl bg-message px-3 py-2 text-message-foreground">
          <ChatMarkdown
            text={text}
            cwd={undefined}
            className="text-foreground"
            lineBreaks
            parseRawHtml={false}
            headingLevelOffset={MESSAGE_HEADING_LEVEL}
          />
        </div>
      )}
      <Attachments attachments={message.attachments} context={context} />
    </MessageFrame>
  );
}

function AssistantMessage({
  message,
  model,
  context,
}: {
  message: ConversationMessage;
  model: SnapshotAnswerModel | null;
  context: RowContext;
}) {
  const text = readerMessageMarkdown(message, context.repository);
  const modelLabel = model?.model ?? model?.provider ?? null;
  return (
    <MessageFrame message={message} context={context}>
      <div className="px-1 py-0.5">
        <ChatMarkdown
          text={text}
          cwd={undefined}
          messageId={message.id}
          lineBreaks={shouldPreserveAssistantLineBreaks(text)}
          headingLevelOffset={MESSAGE_HEADING_LEVEL}
        />
        <Attachments attachments={message.attachments} context={context} />
        {modelLabel !== null ? (
          <p className="mt-1.5 text-xs text-muted-foreground">{modelLabel}</p>
        ) : null}
      </div>
    </MessageFrame>
  );
}

function Attachments({
  attachments,
  context,
}: {
  attachments: ReadonlyArray<ConversationAttachment>;
  context: RowContext;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap justify-end gap-1.5">
      {attachments.map((attachment) => (
        <AttachmentChip key={attachment.localId} attachment={attachment} context={context} />
      ))}
    </div>
  );
}

function AttachmentChip({
  attachment,
  context,
}: {
  attachment: ConversationAttachment;
  context: RowContext;
}) {
  const sha256 = attachmentBlobSha256(context.conversation, attachment);
  const url = useBlobUrl(attachment.available ? sha256 : null, context.loadBlob);
  if (attachment.kind === "image" && url !== null) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="block rounded-xl focus-visible:outline-2 focus-visible:outline-ring"
      >
        <img
          src={url}
          alt={attachment.name}
          className="max-h-64 max-w-full rounded-xl border border-border object-contain"
        />
      </a>
    );
  }
  const body = (
    <>
      <FileIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{attachment.name}</span>
      <span className="shrink-0 text-muted-foreground tabular-nums">
        {formatAttachmentSize(attachment.sizeBytes)}
      </span>
    </>
  );
  const chipClassName =
    "flex max-w-64 min-w-0 items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs";
  return url === null ? (
    <span className={cn(chipClassName, "text-muted-foreground")}>{body}</span>
  ) : (
    <a
      href={url}
      download={attachment.name}
      className={cn(
        chipClassName,
        "hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
      )}
    >
      {body}
    </a>
  );
}

function useBlobUrl(sha256: string | null, loadBlob: SnapshotBlobLoader | undefined) {
  const [loaded, setLoaded] = useState<{ sha256: string; url: string } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the blob and owns the object URL's lifetime
  useEffect(() => {
    if (sha256 === null || loadBlob === undefined) return;
    let url: string | null = null;
    let cancelled = false;
    loadBlob(sha256).then(
      (blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setLoaded({ sha256, url });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [sha256, loadBlob]);
  return loaded !== null && loaded.sha256 === sha256 ? loaded.url : null;
}

function BlobHtmlFrame({
  title,
  sha256,
  loadBlob,
  contentOrigin,
}: {
  title: string;
  sha256: string;
  loadBlob: SnapshotBlobLoader;
  contentOrigin: string | undefined;
}) {
  const [html, setHtml] = useState<{ sha256: string; text: string } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the visual's HTML from the copy's blob store
  useEffect(() => {
    let cancelled = false;
    loadBlob(sha256)
      .then((blob) => blob.text())
      .then(
        (text) => {
          if (!cancelled) setHtml({ sha256, text });
        },
        () => undefined,
      );
    return () => {
      cancelled = true;
    };
  }, [sha256, loadBlob]);
  if (html === null || html.sha256 !== sha256) return null;
  return (
    <div className="mt-3 px-1">
      <SharedHtmlFrame title={title} html={html.text} contentOrigin={contentOrigin} />
    </div>
  );
}

function Disclosure({
  summary,
  tone = "muted",
  children,
}: {
  summary: ReactNode;
  tone?: "muted" | "error";
  children: ReactNode;
}) {
  return (
    <details className="group/fold px-1">
      <summary
        className={cn(
          "flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm text-sm outline-none focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden",
          tone === "error"
            ? "text-destructive-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 group-open/fold:rotate-90" />
      </summary>
      <div className="mt-1.5 ms-1 border-s border-border ps-3">{children}</div>
    </details>
  );
}

function BoundedBlock({
  label,
  text,
}: {
  label: string;
  text: { text: string; omittedLines: number };
}) {
  return (
    <div className="min-w-0">
      <p className="text-2xs text-muted-foreground">{label}</p>
      <pre className="max-h-72 overflow-auto rounded-md bg-muted/50 px-2 py-1.5 font-mono text-xs whitespace-pre-wrap break-words">
        {text.text}
        {text.omittedLines > 0 ? `\n… ${text.omittedLines} more lines not copied` : ""}
      </pre>
    </div>
  );
}

function WorkStep({
  step,
  repository,
}: {
  step: SnapshotWorkStep;
  repository: SnapshotRepository | undefined;
}) {
  if (step.kind === "reasoning") {
    return (
      <Disclosure summary="Thought">
        <ChatMarkdown
          text={step.reasoning.text}
          cwd={undefined}
          className="text-muted-foreground"
        />
      </Disclosure>
    );
  }
  return <WorkEntry entry={step.entry} repository={repository} />;
}

function workEntryTitle(entry: ConversationWorkLogEntry): string {
  switch (entry._tag) {
    case "tool":
    case "task":
    case "notice":
    case "compaction":
      return entry.title;
    case "plan-steps":
      return "Updated the plan";
  }
}

function WorkEntry({
  entry,
  repository,
}: {
  entry: ConversationWorkLogEntry;
  repository: SnapshotRepository | undefined;
}) {
  const failed =
    ((entry._tag === "tool" || entry._tag === "task") && entry.status === "failed") ||
    (entry._tag === "notice" && entry.level === "error");
  const title = workEntryTitle(entry);
  const details: ReactNode[] = [];
  if (entry._tag === "tool") {
    if (entry.command)
      details.push(<BoundedBlock key="command" label="Command" text={entry.command} />);
    if (entry.detail)
      details.push(<BoundedBlock key="detail" label="Details" text={entry.detail} />);
    if (entry.output)
      details.push(<BoundedBlock key="output" label="Output" text={entry.output} />);
    if (entry.changedFiles.length > 0) {
      details.push(
        <ChangedFiles
          key="files"
          files={entry.changedFiles}
          omitted={entry.omittedChangedFiles}
          repository={repository}
        />,
      );
    }
  } else if ((entry._tag === "task" || entry._tag === "notice") && entry.detail) {
    details.push(<BoundedBlock key="detail" label="Details" text={entry.detail} />);
  } else if (entry._tag === "plan-steps") {
    details.push(
      <ol key="steps" className="list-decimal ps-5 text-sm">
        {entry.steps.map((step) => (
          <li
            key={step.step}
            className={cn(step.status === "completed" && "text-muted-foreground line-through")}
          >
            {step.step}
          </li>
        ))}
      </ol>,
    );
  }
  if (details.length === 0) {
    return (
      <p
        className={cn(
          "truncate px-1 text-sm",
          failed ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      >
        {title}
      </p>
    );
  }
  return (
    <Disclosure summary={title} tone={failed ? "error" : "muted"}>
      <div className="flex flex-col gap-1.5 py-1">{details}</div>
    </Disclosure>
  );
}

function ChangedFiles({
  files,
  omitted,
  repository,
}: {
  files: ReadonlyArray<string>;
  omitted: number;
  repository: SnapshotRepository | undefined;
}) {
  return (
    <ul className="flex flex-col gap-0.5 font-mono text-xs">
      {files.map((file) => {
        const url = repositoryFileUrl(repository, file);
        return (
          <li key={file} className="truncate">
            {url === null ? (
              file
            ) : (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-2 hover:underline"
              >
                {file}
              </a>
            )}
          </li>
        );
      })}
      {omitted > 0 ? <li className="text-muted-foreground">and {omitted} more</li> : null}
    </ul>
  );
}

function QuestionAnswer({ answer }: { answer: ConversationQuestionAnswer }) {
  return (
    <div className="flex flex-col gap-2 px-1">
      {answer.items.map((item) => (
        <div key={`${item.question ?? ""}\u0000${item.answer}`} className="text-sm">
          {item.question !== null ? <p className="text-muted-foreground">{item.question}</p> : null}
          <p className="whitespace-pre-wrap">{item.answer}</p>
        </div>
      ))}
    </div>
  );
}
