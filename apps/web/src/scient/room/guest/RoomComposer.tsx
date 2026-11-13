import { ROOM_MESSAGE_MAX_LENGTH, type RoomReplyTarget, type RoomRole } from "@t3tools/contracts";
import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";

import { Button } from "~/components/ui/button";
import { guestFilesProblem } from "~/components/guest/guestStream.logic";
import { roomAuthorLabel } from "../RoomMessageRow";
import { postRoom } from "./roomGuestApi";

export function RoomComposer({
  participantId,
  role,
  reply,
  onCancelReply,
  onSent,
}: {
  readonly participantId: string;
  readonly role: RoomRole;
  readonly reply: RoomReplyTarget | null;
  readonly onCancelReply: () => void;
  readonly onSent: (reply: RoomReplyTarget | null) => void;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<ReadonlyArray<{ readonly key: number; readonly file: File }>>(
    [],
  );
  const nextFile = useRef(0);
  const [destination, setDestination] = useState<{
    role: RoomRole;
    to: "people" | "agent";
    reply: RoomReplyTarget | null;
  }>({
    role,
    to: "people",
    reply,
  });
  if (destination.role !== role || destination.reply !== reply) {
    setDestination({ role, to: "people", reply });
  }
  const to =
    role === "agent" && destination.role === role && destination.reply === reply
      ? destination.to
      : "people";
  const [suggested, setSuggested] = useState(false);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const addFiles = (added: ReadonlyArray<File>) => {
    const next = [...files, ...added.map((file) => ({ key: nextFile.current++, file }))];
    const problem = guestFilesProblem(next.map(({ file }) => file));
    setError(problem);
    if (problem === null) setFiles(next);
  };
  const send = async () => {
    const trimmed = text.trim();
    if (role === "watch" || sendingRef.current || (trimmed === "" && files.length === 0)) return;
    sendingRef.current = true;
    setSending(true);
    const sentFiles = files;
    const sentReply = reply;
    const form = new FormData();
    form.append("text", trimmed);
    form.append("to", to);
    if (sentReply !== null && to === "people") form.append("replyTo", sentReply.itemId);
    if (role === "discuss" && suggested) form.append("suggested", "true");
    for (const { file } of sentFiles) form.append("file", file, file.name);
    const failure = await postRoom(participantId, "messages", form);
    sendingRef.current = false;
    setSending(false);
    setError(failure);
    if (failure === null) {
      setText((current) => (current.trim() === trimmed ? "" : current));
      setFiles((current) => current.filter((file) => !sentFiles.includes(file)));
      onSent(to === "people" ? sentReply : null);
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

  if (role === "watch")
    return <p className="text-sm text-muted-foreground">You can watch this room.</p>;
  return (
    <form
      className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-3"
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
      {role === "agent" ? (
        <fieldset className="flex items-center gap-2">
          <legend className="mb-1 text-xs text-muted-foreground">Send to</legend>
          {(["people", "agent"] as const).map((value) => (
            <label key={value} className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name="destination"
                value={value}
                checked={to === value}
                onChange={() => setDestination({ role, to: value, reply })}
              />
              {value === "people" ? "People" : "Agent"}
            </label>
          ))}
        </fieldset>
      ) : null}
      <p
        className={
          to === "agent" ? "text-sm font-medium text-primary" : "text-xs text-muted-foreground"
        }
      >
        {to === "agent" ? "This message goes directly to the agent." : "To people in this room"}
      </p>
      {reply !== null && to === "people" ? (
        <div className="flex items-center gap-2 border-s-2 border-border ps-2 text-xs">
          <span className="min-w-0 flex-1 truncate">
            Replying to {roomAuthorLabel(reply.author, { kind: "guest", participantId })}:{" "}
            {reply.excerpt}
          </span>
          <Button size="xs" variant="ghost-muted" aria-label="Cancel reply" onClick={onCancelReply}>
            Cancel
          </Button>
        </div>
      ) : null}
      <textarea
        aria-label="Message"
        rows={2}
        maxLength={ROOM_MESSAGE_MAX_LENGTH}
        placeholder={to === "agent" ? "Message the agent" : "Message people in the room"}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        className="max-h-60 min-h-12 w-full resize-none bg-transparent text-sm outline-none field-sizing-content placeholder:text-placeholder"
      />
      {files.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label="Attached files">
          {files.map(({ key, file }) => (
            <li key={key} className="flex items-center gap-1 text-xs">
              <span className="max-w-40 truncate">{file.name}</span>
              <Button
                size="xs"
                variant="ghost-muted"
                aria-label={`Remove ${file.name}`}
                onClick={() => setFiles((current) => current.filter((entry) => entry.key !== key))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {role === "discuss" ? (
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={suggested}
            onChange={(event) => setSuggested(event.target.checked)}
          />
          Suggest sending this to the agent
        </label>
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
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
        <Button size="sm" variant="ghost-muted" onClick={() => inputRef.current?.click()}>
          Attach files
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={sending || (text.trim() === "" && files.length === 0)}
        >
          {to === "agent" ? "Send to agent" : "Send to people"}
        </Button>
      </div>
    </form>
  );
}
