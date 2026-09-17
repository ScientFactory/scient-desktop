import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH, type AssistantCitation } from "@t3tools/contracts";
import { useImperativeHandle, useRef, useState, type Ref } from "react";

import { ScientVoiceCommentControl } from "~/scient/voice/ScientVoiceCommentControl";
import { buildVoiceDraftReplacement } from "~/scient/voice/voiceComposerInsert";

import { Button } from "../ui/button";

export function AssistantCitationCommentEditor({
  citation,
  mode = "edit",
  inputRef,
  onSubmit,
  onSubmitAndSend,
  onCancel,
}: {
  citation: Pick<AssistantCitation, "comment" | "environmentId">;
  mode?: "create" | "edit";
  inputRef?: Ref<HTMLTextAreaElement>;
  onSubmit: (comment: string) => boolean;
  onSubmitAndSend?: (comment: string) => boolean;
  onCancel: () => void;
}) {
  const [comment, setComment] = useState(citation.comment ?? "");
  const [voiceBusy, setVoiceBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(inputRef, () => textareaRef.current!, []);
  const commentTooLong = comment.length > ASSISTANT_CITATION_MAX_COMMENT_LENGTH;
  const submit = () => {
    if (!commentTooLong) onSubmit(comment);
  };
  const submitAndSend = () => {
    if (commentTooLong) return;
    if (onSubmitAndSend) {
      onSubmitAndSend(comment);
    } else {
      onSubmit(comment);
    }
  };
  const submitLabel = mode === "create" ? "Add to chat" : "Save";
  const keyboardDescription =
    mode === "create"
      ? "Enter to add the citation to chat; Command/Ctrl+Enter to add and send; Shift+Enter for a new line."
      : "Enter to save the citation comment; Command/Ctrl+Enter to save and send; Shift+Enter for a new line.";

  return (
    <div
      data-citation-comment-editor="true"
      aria-busy={voiceBusy || undefined}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <textarea
        ref={textareaRef}
        aria-label="Comment on selected text"
        aria-description={keyboardDescription}
        aria-invalid={commentTooLong || undefined}
        placeholder="Add an optional comment..."
        rows={2}
        className="field-sizing-content block max-h-40 min-h-16 w-full resize-none bg-transparent px-1 py-1.5 text-base outline-none placeholder:text-muted-foreground sm:text-sm"
        value={comment}
        onChange={(event) => setComment(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault();
            if (event.metaKey || event.ctrlKey) {
              submitAndSend();
            } else {
              submit();
            }
          }
        }}
      />
      {commentTooLong ? (
        <p role="status" className="pt-1 text-xs text-destructive">
          Comments can contain up to {ASSISTANT_CITATION_MAX_COMMENT_LENGTH.toLocaleString()}{" "}
          characters.
        </p>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        <ScientVoiceCommentControl
          className="relative min-w-0 flex-1"
          disabled={commentTooLong}
          environmentId={citation.environmentId}
          onBusyChange={setVoiceBusy}
          onTranscript={(transcript) => {
            setComment((current) => buildVoiceDraftReplacement(current, transcript).replacement);
            queueMicrotask(() => textareaRef.current?.focus({ preventScroll: true }));
          }}
        />
        {voiceBusy ? null : (
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="xs"
              onPointerDown={(event) => event.preventDefault()}
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button
              size="xs"
              disabled={commentTooLong}
              onPointerDown={(event) => event.preventDefault()}
              onClick={submit}
            >
              {commentTooLong ? "Shorten comment" : submitLabel}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
