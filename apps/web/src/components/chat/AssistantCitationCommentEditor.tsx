import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useThreadShell } from "~/state/entities";
import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH, type AssistantCitation } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { useImperativeHandle, useRef, useState, type Ref } from "react";
import { textDirection } from "~/textDirection";

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
  onDraftChange,
}: {
  citation: Pick<AssistantCitation, "comment" | "environmentId"> &
    Partial<Pick<AssistantCitation, "threadId">>;
  mode?: "create" | "edit";
  inputRef?: Ref<HTMLTextAreaElement>;
  onSubmit: (comment: string) => boolean;
  onSubmitAndSend?: (comment: string) => boolean;
  onCancel: () => void;
  onDraftChange?: (comment: string) => void;
}) {
  const gt = useGT();
  const sourceThread = useThreadShell(
    citation.threadId ? scopeThreadRef(citation.environmentId, citation.threadId) : null,
  );
  const [comment, setComment] = useState(citation.comment ?? "");
  const [voiceBusy, setVoiceBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(inputRef, () => textareaRef.current!, []);
  const commentTooLong = comment.length > ASSISTANT_CITATION_MAX_COMMENT_LENGTH;
  const submissionBlocked = voiceBusy || commentTooLong;
  const submit = () => {
    if (!submissionBlocked) onSubmit(comment);
  };
  const submitAndSend = () => {
    if (submissionBlocked) return;
    if (onSubmitAndSend) {
      onSubmitAndSend(comment);
    } else {
      onSubmit(comment);
    }
  };
  const submitLabel =
    mode === "create" ? gt("Add to chat") : gt("Save", { $context: "verb, saves the comment" });
  const keyboardDescription =
    mode === "create"
      ? gt(
          "Enter to add the citation to chat; Command/Ctrl+Enter to add and send; Shift+Enter for a new line.",
        )
      : gt(
          "Enter to save the citation comment; Command/Ctrl+Enter to save and send; Shift+Enter for a new line.",
        );

  const activeProviderInstanceId =
    sourceThread?.modelSelection?.instanceId ?? sourceThread?.providerInstanceId;
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
        aria-label={gt("Comment on selected text")}
        aria-description={keyboardDescription}
        aria-invalid={commentTooLong || undefined}
        placeholder={gt("Add an optional comment...")}
        rows={2}
        dir={textDirection(comment)}
        className="field-sizing-content block max-h-40 min-h-16 w-full resize-none bg-transparent px-1 py-1.5 text-base outline-none placeholder:text-muted-foreground sm:text-sm"
        value={comment}
        onChange={(event) => {
          setComment(event.currentTarget.value);
          onDraftChange?.(event.currentTarget.value);
        }}
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
          <T>
            Comments can contain up to{" "}
            <Var>{ASSISTANT_CITATION_MAX_COMMENT_LENGTH.toLocaleString()}</Var> characters.
          </T>
        </p>
      ) : null}
      <div
        data-citation-comment-footer="true"
        className="mt-2 flex min-w-0 items-center justify-end gap-2"
      >
        <ScientVoiceCommentControl
          className={voiceBusy ? "min-w-0 flex-1" : ""}
          disabled={commentTooLong}
          environmentId={citation.environmentId}
          {...(activeProviderInstanceId ? { activeProviderInstanceId } : {})}
          projectId={sourceThread?.projectId ?? null}
          onBusyChange={setVoiceBusy}
          onTranscript={(transcript) => {
            const replacement = buildVoiceDraftReplacement(comment, transcript).replacement;
            setComment(replacement);
            onDraftChange?.(replacement);
            queueMicrotask(() => textareaRef.current?.focus({ preventScroll: true }));
          }}
        />
        <div
          className={voiceBusy ? "hidden" : "flex items-center gap-2"}
          inert={voiceBusy || undefined}
          aria-hidden={voiceBusy || undefined}
        >
          <Button
            variant="outline"
            size="xs"
            // Escape cancels; keep Tab from the comment on Save so Enter cannot discard a new citation.
            tabIndex={-1}
            onPointerDown={(event) => event.preventDefault()}
            onClick={onCancel}
          >
            <T>Cancel</T>
          </Button>
          <Button
            size="xs"
            disabled={commentTooLong}
            onPointerDown={(event) => event.preventDefault()}
            onClick={submit}
          >
            {commentTooLong ? gt("Shorten comment") : submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
