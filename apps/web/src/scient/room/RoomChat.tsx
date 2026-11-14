import {
  type OrchestrationV2TurnItem,
  ROOM_MESSAGE_MAX_LENGTH,
  type RoomAuthor,
  type RoomMessageAttribution,
  type RoomReplyTarget,
} from "@t3tools/contracts";
import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/models";
import * as DateTime from "effect/DateTime";
import { ArrowUpIcon, CheckIcon, PaperclipIcon, SendIcon, Trash2Icon, XIcon } from "lucide-react";
import {
  type ClipboardEvent,
  type ComponentType,
  type KeyboardEvent,
  createContext,
  use,
  useRef,
  useState,
} from "react";

import { guestFilesProblem } from "~/components/guest/guestStream.logic";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

export type RoomMessageItem = Extract<OrchestrationV2TurnItem, { readonly type: "room_message" }>;

/** Who reads the chat: the owner, or one participant on the guest page. */
export type RoomViewer =
  | { readonly kind: "owner" }
  | { readonly kind: "guest"; readonly participantId: string };

/** What this viewer can do in the people chat. */
export interface RoomChatActions {
  readonly viewer: RoomViewer;
  readonly canPost: boolean;
  readonly canSendToAgent: boolean;
  /** Deleting anyone's message; people can always delete their own. */
  readonly canDelete: boolean;
  /** Draws a message's files where this viewer can open them. */
  readonly Attachments: ComponentType<{ readonly item: RoomMessageItem }>;
  /** Resolves to an error to show, or null once posted. */
  readonly onPost: (text: string, files: ReadonlyArray<File>) => Promise<string | null>;
  readonly onSend: (item: RoomMessageItem) => Promise<void>;
  readonly onDelete: (item: RoomMessageItem) => Promise<void>;
}

/** The viewer, for the agent-thread rows that say who sent a chat message on. */
export const RoomViewerContext = createContext<RoomViewer>({ kind: "owner" });

const isViewer = (viewer: RoomViewer | null | undefined, author: RoomAuthor) =>
  viewer != null &&
  (author.kind === "owner"
    ? viewer.kind === "owner"
    : viewer.kind === "guest" && viewer.participantId === author.participantId);

/** How the chat names an author to this viewer. */
function roomAuthorLabel(author: RoomReplyTarget["author"], viewer?: RoomViewer | null): string {
  if (author.kind === "agent") return "Agent";
  if (isViewer(viewer, author)) return "You";
  return author.kind === "owner" ? "Owner" : author.name;
}

const timeOf = (value: string) =>
  new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

const postedAtOf = (item: RoomMessageItem) => DateTime.formatIso(item.startedAt ?? item.updatedAt);

/** The chat messages of a thread, oldest first. */
export function roomChatMessages(
  items: ReadonlyArray<OrchestrationV2TurnItem | ThreadStructureTurnItem>,
): ReadonlyArray<RoomMessageItem> {
  return items
    .filter((item): item is RoomMessageItem => item.type === "room_message")
    .toSorted((left, right) => postedAtOf(left).localeCompare(postedAtOf(right)));
}

const sameAuthor = (left: RoomAuthor, right: RoomAuthor) =>
  left.kind === right.kind &&
  (left.kind === "owner" ||
    (right.kind === "guest" &&
      left.kind === "guest" &&
      left.participantId === right.participantId));

const GROUP_GAP_MS = 5 * 60_000;

/**
 * The people's chat beside a shared thread. Nothing here reaches the agent unless someone allowed
 * to presses Send to agent on a message.
 */
export function RoomChat({
  messages,
  actions,
}: {
  readonly messages: ReadonlyArray<RoomMessageItem>;
  readonly actions: RoomChatActions;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Reversed so the list stays pinned to the newest message as messages arrive. */}
      <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto scrollbar-gutter-both px-3 py-2">
        {messages.length === 0 ? (
          <p className="m-auto max-w-56 text-center text-xs text-muted-foreground">
            Talk with the people in this thread here. The agent doesn&apos;t see it.
          </p>
        ) : (
          <ol className="flex flex-col" aria-label="Chat">
            {messages.map((item, index) => {
              const previous = messages[index - 1];
              const grouped =
                previous !== undefined &&
                sameAuthor(previous.author, item.author) &&
                Date.parse(postedAtOf(item)) - Date.parse(postedAtOf(previous)) < GROUP_GAP_MS;
              return (
                <RoomChatMessage
                  key={item.id}
                  item={item}
                  actions={actions}
                  showAuthor={!grouped}
                />
              );
            })}
          </ol>
        )}
      </div>
      {actions.canPost ? (
        <div className="shrink-0 p-2">
          <RoomComposeBox placeholder="Message people" onSubmit={actions.onPost} />
        </div>
      ) : null}
    </div>
  );
}

function RoomChatMessage({
  item,
  actions,
  showAuthor,
}: {
  readonly item: RoomMessageItem;
  readonly actions: RoomChatActions;
  readonly showAuthor: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const { viewer } = actions;
  const mine = isViewer(viewer, item.author);
  const deleted = item.deletedAt !== undefined;
  const sent = item.deliveries?.findLast((delivery) => delivery.status === "sent");
  const author = roomAuthorLabel(item.author, viewer);
  const canDelete = !deleted && (actions.canDelete || mine);
  const canSend = !deleted && actions.canSendToAgent;
  const run = (action: () => Promise<void>) => {
    setBusy(true);
    void action().finally(() => setBusy(false));
  };
  const postedAt = postedAtOf(item);

  return (
    <li
      className={cn(
        "group relative rounded-md px-2 py-0.5 hover:bg-accent/50",
        showAuthor && "mt-2",
      )}
      data-room-message={item.roomMessageId}
    >
      {showAuthor ? (
        <p className="flex items-baseline gap-2 text-xs">
          <span className="font-medium text-foreground">{author}</span>
          <time className="text-2xs text-muted-foreground" dateTime={postedAt}>
            {timeOf(postedAt)}
          </time>
        </p>
      ) : (
        <span className="sr-only">{author}</span>
      )}
      {deleted ? (
        <p className="text-sm text-muted-foreground italic">Message deleted</p>
      ) : (
        <div className="flex flex-col gap-1">
          {(item.attachments?.length ?? 0) > 0 ? <actions.Attachments item={item} /> : null}
          {item.text ? (
            <p className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
              {item.text}
            </p>
          ) : null}
        </div>
      )}
      {sent !== undefined ? (
        <p className="flex items-center gap-1 text-2xs text-muted-foreground">
          <CheckIcon aria-hidden className="size-3" />
          Sent to agent
          {isViewer(viewer, sent.by) ? "" : ` by ${roomAuthorLabel(sent.by, viewer)}`}
        </p>
      ) : null}
      {canSend || canDelete ? (
        <div className="absolute end-1 -top-3 flex items-center rounded-md border border-border bg-popover opacity-0 shadow-xs group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:static pointer-coarse:justify-end pointer-coarse:border-0 pointer-coarse:bg-transparent pointer-coarse:opacity-100 pointer-coarse:shadow-none">
          {canSend ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={busy}
                    aria-label={`Send ${mine ? "your" : `${author}'s`} message to the agent`}
                    onClick={() => run(() => actions.onSend(item))}
                  />
                }
              >
                <SendIcon />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {sent === undefined ? "Send to agent" : "Send to agent again"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {canDelete ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={busy}
                    aria-label="Delete message"
                    onClick={() => run(() => actions.onDelete(item))}
                  />
                }
              >
                <Trash2Icon />
              </TooltipTrigger>
              <TooltipPopup side="top">Delete</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** One line of text and files, sent with Enter. Used for the people chat and a guest's agent box. */
export function RoomComposeBox({
  placeholder,
  onSubmit,
}: {
  readonly placeholder: string;
  readonly onSubmit: (text: string, files: ReadonlyArray<File>) => Promise<string | null>;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<ReadonlyArray<{ readonly key: number; readonly file: File }>>(
    [],
  );
  const nextFile = useRef(0);
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const addFiles = (added: ReadonlyArray<File>) => {
    const next = [...files, ...added.map((file) => ({ key: nextFile.current++, file }))];
    const problem = guestFilesProblem(next.map(({ file }) => file));
    setError(problem);
    if (problem === null) setFiles(next);
  };
  const empty = text.trim() === "" && files.length === 0;
  const send = async () => {
    const trimmed = text.trim();
    if (sendingRef.current || (trimmed === "" && files.length === 0)) return;
    sendingRef.current = true;
    setSending(true);
    const sentFiles = files;
    const failure = await onSubmit(
      trimmed,
      sentFiles.map(({ file }) => file),
    );
    sendingRef.current = false;
    setSending(false);
    setError(failure);
    if (failure === null) {
      setText((current) => (current.trim() === trimmed ? "" : current));
      setFiles((current) => current.filter((file) => !sentFiles.includes(file)));
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(event.clipboardData.files);
    if (
      pasted.length === 0 ||
      (!pasted.some((file) => file.type.startsWith("image/")) &&
        event.clipboardData.getData("text/plain") !== "")
    )
      return;
    event.preventDefault();
    addFiles(pasted);
  };

  return (
    <form
      className="flex flex-col gap-1 rounded-xl border border-border bg-card p-1.5 focus-within:border-ring"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {files.length > 0 ? (
        <ul className="flex flex-wrap gap-1 px-1" aria-label="Attached files">
          {files.map(({ key, file }) => (
            <li
              key={key}
              className="flex items-center gap-0.5 rounded-md bg-accent ps-2 text-xs text-foreground"
            >
              <span className="max-w-40 truncate">{file.name}</span>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Remove ${file.name}`}
                onClick={() => setFiles((current) => current.filter((entry) => entry.key !== key))}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-end gap-1">
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          aria-label="Files to attach"
          onChange={(event) => {
            addFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Attach files"
          onClick={() => inputRef.current?.click()}
        >
          <PaperclipIcon />
        </Button>
        <textarea
          aria-label={placeholder}
          rows={1}
          maxLength={ROOM_MESSAGE_MAX_LENGTH}
          placeholder={placeholder}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className="max-h-40 min-h-6 min-w-0 flex-1 resize-none bg-transparent py-0.5 text-sm outline-none field-sizing-content placeholder:text-placeholder"
        />
        <Button type="submit" size="icon-xs" aria-label="Send" disabled={sending || empty}>
          <ArrowUpIcon />
        </Button>
      </div>
      {error !== null ? (
        <p role="alert" className="px-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/**
 * Above a message the agent got from the chat. A guest's own message already carries their name,
 * so this only says who sent someone else's message on.
 */
export function RoomSentLine({ room }: { readonly room: RoomMessageAttribution }) {
  const viewer = use(RoomViewerContext);
  if (room.itemId === undefined) return null;
  return (
    <p className="me-1 text-2xs text-muted-foreground">
      From the chat · sent by {roomAuthorLabel(room.sentBy, viewer)}
    </p>
  );
}
