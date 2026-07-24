// FILE: FeedbackDialog.tsx
// Purpose: Collects categorized Scient feedback with privacy-safe diagnostics.
// Layer: Shared UI component
// Depends on: Feedback delivery logic and the shared dialog primitives.

import { useEffect, useRef, useState } from "react";
import { CircleCheckIcon } from "../lib/icons";
import {
  buildFeedbackSubmission,
  FEEDBACK_CATEGORIES,
  submitFeedback,
  type FeedbackCategory,
  type FeedbackThreadContext,
} from "../feedback";
import { Button } from "./ui/button";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "./ui/dialog";
import { Spinner } from "./ui/spinner";
import { Textarea } from "./ui/textarea";

export interface FeedbackDialogProps {
  open: boolean;
  context: FeedbackThreadContext;
  onOpenChange: (open: boolean) => void;
}

export function FeedbackDialog({ open, context, onOpenChange }: FeedbackDialogProps) {
  const [category, setCategory] = useState<FeedbackCategory | null>(null);
  const [details, setDetails] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const successRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef(0);
  const requestRef = useRef(0);

  useEffect(() => {
    sessionRef.current += 1;
    requestRef.current += 1;
    if (!open) return;
    setCategory(null);
    setDetails("");
    setIsSending(false);
    setSubmitError(null);
    setSubmitted(false);
    const frame = window.requestAnimationFrame(() => textareaRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open || !submitted) return;
    const frame = window.requestAnimationFrame(() => successRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open, submitted]);

  const canSubmit = details.trim().length > 0 && !isSending;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    const session = sessionRef.current;
    const request = ++requestRef.current;
    setSubmitError(null);
    setIsSending(true);
    try {
      await submitFeedback(buildFeedbackSubmission({ category, details, context }));
      if (sessionRef.current !== session || requestRef.current !== request) return;
      setIsSending(false);
      setSubmitted(true);
    } catch (error) {
      if (sessionRef.current !== session || requestRef.current !== request) return;
      setIsSending(false);
      setSubmitError(
        error instanceof Error ? error.message : "An unexpected delivery error occurred.",
      );
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isSending) onOpenChange(nextOpen);
      }}
    >
      <DialogPopup surface="solid" className="max-w-xl" showCloseButton={!isSending}>
        <DialogHeader className="gap-0 px-5 pt-5 pb-3">
          <DialogTitle className="text-xl tracking-[-0.01em]">Share feedback</DialogTitle>
        </DialogHeader>

        {submitted ? (
          <div
            ref={successRef}
            className="flex flex-col items-center gap-3 px-5 pb-5 pt-2 text-center outline-none"
            role="status"
            aria-live="polite"
            tabIndex={-1}
          >
            <CircleCheckIcon aria-hidden className="size-7 text-success" />
            <div>
              <p className="text-sm font-medium text-foreground">Feedback sent</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Thanks for helping make Scient better.
              </p>
            </div>
            <Button type="button" className="w-full" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        ) : (
          <form
            className="flex min-h-0 flex-col gap-3 px-5 pb-5"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSubmit();
            }}
          >
            <div className="flex flex-wrap gap-1.5" aria-label="Feedback category">
              {FEEDBACK_CATEGORIES.map((option) => {
                const selected = category === option.value;
                return (
                  <Button
                    key={option.value}
                    type="button"
                    variant={selected ? "secondary" : "outline"}
                    size="sm"
                    aria-pressed={selected}
                    // Reference pills breathe at ~14px per side; the default `sm`
                    // padding (10px) crams the label against the pill wall.
                    className="rounded-full px-3.5 font-normal"
                    disabled={isSending}
                    // Keeps the caret (and the field's focus ring) in the details
                    // textarea, so picking a category never interrupts typing.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setCategory(selected ? null : option.value)}
                  >
                    <span aria-hidden="true">{selected ? "−" : "+"}</span>
                    {option.label}
                  </Button>
                );
              })}
            </div>

            <Textarea
              ref={textareaRef}
              value={details}
              maxLength={5_000}
              placeholder="Share details (required)"
              aria-label="Feedback details"
              disabled={isSending}
              className="[&_[data-slot=textarea]]:min-h-32 [&_[data-slot=textarea]]:resize-y"
              onChange={(event) => setDetails(event.target.value)}
            />

            <p className="text-xs leading-relaxed text-muted-foreground">
              Diagnostics include app version, OS, provider/model, modes, and session state — never
              prompts, messages, paths, or logs.
            </p>

            {submitError ? (
              <p className="text-xs leading-relaxed text-destructive" role="alert">
                Could not send feedback: {submitError}
              </p>
            ) : null}

            <Button type="submit" className="w-full" disabled={!canSubmit}>
              {isSending ? (
                <>
                  <Spinner />
                  Sending…
                </>
              ) : (
                "Submit"
              )}
            </Button>
          </form>
        )}
      </DialogPopup>
    </Dialog>
  );
}
