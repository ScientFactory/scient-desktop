import { ROOM_MESSAGE_MAX_LENGTH } from "@t3tools/contracts";
import { ArrowUpIcon, PaperclipIcon, XIcon } from "lucide-react";
import { type ClipboardEvent, type KeyboardEvent, type ReactNode, useRef, useState } from "react";

import { guestFilesProblem } from "~/components/guest/guestStream.logic";
import { Button } from "~/components/ui/button";

/** A guest's composer: text and files, sent with Enter. Beside Send, an optional agent switch. */
export function RoomComposeBox({
  placeholder,
  onSubmit,
  agentSwitch,
}: {
  readonly placeholder: string;
  readonly onSubmit: (text: string, files: ReadonlyArray<File>) => Promise<string | null>;
  readonly agentSwitch?: ReactNode;
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
        {agentSwitch}
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
