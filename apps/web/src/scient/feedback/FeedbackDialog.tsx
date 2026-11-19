import {
  FEEDBACK_CONVERSATION_MAX_BYTES,
  type FeedbackPreparation,
  type FeedbackScreen,
  type FeedbackSubmitResult,
} from "@t3tools/contracts";
import { useLocation } from "@tanstack/react-router";
import {
  CameraIcon,
  ChevronRightIcon,
  MessagesSquareIcon,
  ScrollTextIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { m } from "../../i18n/messages";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Textarea } from "../../components/ui/textarea";
import { toastManager } from "../../components/ui/toast";
import { namedClipboardTarget, writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useThreadRouteRef } from "../../hooks/useThreadRouteTarget";
import { exportConversation } from "../conversationExport/client";
import { copyMarkdownRequest } from "../conversationExport/exportDialog.logic";
import { exportErrorMessage, localTimeZone } from "../conversationExport/exportActions";
import { feedbackPreviewRows } from "./feedbackPreview";
import {
  clearSentFeedback,
  closeFeedback,
  feedbackDraftStillOpen,
  setFeedbackScreenshot,
  updateFeedbackDraft,
  useFeedbackDraft,
} from "./feedbackStore";

const feedbackBridge = () => window.desktopBridge?.feedback;

/** Whether this client can send feedback (the desktop app). */
export function feedbackAvailable(): boolean {
  return feedbackBridge() !== undefined;
}

const EMAIL_FIELD_ID = "scient-feedback-email";

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** Keeps the end of a long conversation, where the problem usually is. */
function fitConversation(markdown: string): string {
  if (byteLength(markdown) <= FEEDBACK_CONVERSATION_MAX_BYTES) return markdown;
  const notice = "[Earlier messages were left out to fit the size limit.]\n\n";
  let start = markdown.length - Math.floor(FEEDBACK_CONVERSATION_MAX_BYTES / 4);
  while (
    start < markdown.length &&
    byteLength(markdown.slice(start)) > FEEDBACK_CONVERSATION_MAX_BYTES - 200
  ) {
    start += 4096;
  }
  const lineStart = markdown.indexOf("\n", start);
  return notice + markdown.slice(lineStart === -1 ? start : lineStart + 1);
}

function screenFor(pathname: string, hasThread: boolean): FeedbackScreen {
  if (pathname.startsWith("/settings")) return "settings";
  return hasThread ? "chat" : "other";
}

function resultToast(result: Exclude<FeedbackSubmitResult, { _tag: "failed" }>) {
  const copyId = {
    children: m(msg("Copy ID")),
    onClick: () => void writeTextToClipboard(result.id, namedClipboardTarget("feedback report ID")),
  };
  if (result._tag === "sent") {
    toastManager.add({
      type: "success",
      title: m(msg("Feedback sent")),
      description: m(msg("Thank you for helping make Scient better.")),
      actionProps: copyId,
      data: { actionVariant: "outline" },
    });
  } else if (result._tag === "queued") {
    toastManager.add({
      type: "info",
      title: m(msg("Feedback saved")),
      description: m(msg("Scient will send it when you're back online.")),
      actionProps: copyId,
      data: { actionVariant: "outline" },
    });
  } else {
    toastManager.add({
      type: "info",
      title: m(msg("Feedback saved on this computer")),
      description: m(msg("Development builds don't send reports.")),
      actionProps: copyId,
      data: { actionVariant: "outline" },
    });
  }
}

function AttachmentRow(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly detail: string;
  readonly removeLabel: string;
  readonly onRemove: () => void;
  readonly children: ReactNode;
}) {
  const gt = useGT();
  const [shown, setShown] = useState(false);
  return (
    <li className="rounded-lg border border-border/70">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
        <span className="text-muted-foreground [&_svg]:size-4">{props.icon}</span>
        <span className="min-w-0 flex-1 truncate text-sm">
          <span className="font-medium">{props.label}</span>
          <span className="text-muted-foreground"> {props.detail}</span>
        </span>
        <Button type="button" variant="ghost" size="xs" onClick={() => setShown(!shown)}>
          {shown ? gt("Hide") : gt("Show")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={props.removeLabel}
          onClick={props.onRemove}
        >
          <XIcon />
        </Button>
      </div>
      {shown ? <div className="border-t border-border/70 p-2">{props.children}</div> : null}
    </li>
  );
}

function TextPreview({ text }: { readonly text: string }) {
  return (
    <pre className="max-h-48 overflow-auto text-xs whitespace-pre-wrap wrap-anywhere text-foreground/85">
      {text}
    </pre>
  );
}

/** Mounted once at the app root, and on the error page, which replaces the app. */
export function FeedbackDialogHost() {
  const draft = useFeedbackDraft();
  const capturing = draft.open && draft.capturing;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- captures the window after the hidden dialog has left the screen
  useEffect(() => {
    if (!capturing) return;
    let cancelled = false;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const bridge = feedbackBridge();
        if (bridge === undefined || cancelled) return;
        void bridge.captureScreenshot().then(
          (screenshot) => {
            if (cancelled) return;
            if (screenshot === null) {
              toastManager.add({ type: "error", title: m(msg("Couldn't capture the window")) });
            } else {
              setFeedbackScreenshot(screenshot);
            }
            updateFeedbackDraft({ capturing: false });
          },
          () => {
            if (!cancelled) updateFeedbackDraft({ capturing: false });
          },
        );
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [capturing]);

  if (!draft.open || draft.capturing || feedbackBridge() === undefined) return null;
  return <FeedbackDialog key={draft.openKey} />;
}

function FeedbackDialog() {
  const gt = useGT();
  const resolve = useMessages();
  const draft = useFeedbackDraft();
  const routeThreadRef = useThreadRouteRef();
  const pathname = useLocation({ select: (location) => location.pathname });
  const threadRef = draft.threadRef ?? routeThreadRef;
  const [preparation, setPreparation] = useState<FeedbackPreparation | null>(null);
  const [busy, setBusy] = useState<"logs" | "conversation" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the app details the desktop process will send, ignoring replies after close
  useEffect(() => {
    let cancelled = false;
    void feedbackBridge()
      ?.prepare()
      .then((prepared) => {
        if (cancelled) return;
        setPreparation(prepared);
        if (prepared.lastContactEmail && useFeedbackDraft.getState().email === "") {
          updateFeedbackDraft({ email: prepared.lastContactEmail });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const screen = screenFor(pathname, threadRef !== null);
  const hasWords = draft.message.trim().length > 0;
  const canSubmit = preparation !== null && busy === null && (hasWords || draft.error !== null);
  const emailInvalid = draft.email.trim().length > 0 && !/^\S+@\S+\.\S+$/.test(draft.email.trim());

  const addLogs = () => {
    const openKey = draft.openKey;
    setBusy("logs");
    void feedbackBridge()
      ?.readRecentLogs()
      .then(
        (logs) => {
          if (feedbackDraftStillOpen(openKey)) updateFeedbackDraft({ logs });
        },
        () => setError(m(msg("Scient couldn't read its logs."))),
      )
      .then(() => setBusy(null));
  };

  const addConversation = () => {
    if (threadRef === null) return;
    const openKey = draft.openKey;
    setBusy("conversation");
    exportConversation(
      threadRef.environmentId,
      copyMarkdownRequest(threadRef.threadId, localTimeZone()),
    )
      .then(
        (result) => {
          if (!feedbackDraftStillOpen(openKey)) return;
          const text = result.text ?? "";
          if (text.trim().length === 0) {
            setError(m(msg("This conversation has nothing to attach yet.")));
            return;
          }
          const withoutRunningTurn = result.warnings.some(
            (warning) => warning.code === "running-turn-omitted",
          );
          updateFeedbackDraft({
            conversation: fitConversation(text),
            conversationDetail: withoutRunningTurn
              ? m(
                  msg(
                    "{count, plural, =1 {1 message, without the running turn} other {{count} messages, without the running turn}}",
                    { count: result.messageCount },
                  ),
                )
              : m(
                  msg("{count, plural, =1 {1 message} other {{count} messages}}", {
                    count: result.messageCount,
                  }),
                ),
          });
        },
        (cause: unknown) => setError(exportErrorMessage(cause)),
      )
      .then(() => setBusy(null));
  };

  const submit = () => {
    const bridge = feedbackBridge();
    if (!canSubmit || bridge === undefined || preparation === null) return;
    if (emailInvalid) {
      document.getElementById(EMAIL_FIELD_ID)?.focus();
      return;
    }
    setBusy("send");
    setError(null);
    bridge
      .submit({
        message: draft.message,
        source: draft.source,
        screen,
        contactEmail: draft.email.trim() || null,
        details: preparation.details,
        error: draft.error,
        screenshot: draft.screenshot?.jpeg ?? null,
        logs: draft.logs,
        conversation: draft.conversation,
      })
      .then(
        (result) => {
          if (result._tag === "failed") {
            setError(result.message);
            setBusy(null);
            return;
          }
          clearSentFeedback();
          resultToast(result);
        },
        () => {
          setError(m(msg("Scient couldn't save the report. Your text is still here.")));
          setBusy(null);
        },
      );
  };

  const rows =
    preparation === null
      ? []
      : feedbackPreviewRows(
          {
            message: draft.message,
            source: draft.source,
            screen,
            email: emailInvalid ? "" : draft.email,
            details: preparation.details,
            error: draft.error,
            screenshot: draft.screenshot !== null,
            logs: draft.logs !== null,
            conversation: draft.conversation === null ? null : (draft.conversationDetail ?? ""),
          },
          resolve,
        );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && busy !== "send") closeFeedback();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {draft.error === null
              ? gt("Send feedback to Scient")
              : gt("Report a problem to Scient")}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel spacing="compact">
          <Textarea
            aria-label={gt("Your feedback")}
            autoFocus
            dir="auto"
            rows={5}
            value={draft.message}
            placeholder={
              draft.error === null
                ? gt("What happened, or what would make Scient better?")
                : gt("What were you doing when this happened? (optional)")
            }
            onChange={(event) => updateFeedbackDraft({ message: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
              }
            }}
          />

          {draft.error !== null ||
          draft.screenshot !== null ||
          draft.logs !== null ||
          draft.conversation !== null ? (
            <ul
              className="space-y-1.5"
              aria-label={gt("Attached", { $context: "files attached to the feedback" })}
            >
              {draft.error !== null ? (
                <AttachmentRow
                  icon={<TriangleAlertIcon />}
                  label={gt("Error", { $context: "the error attached to a feedback report" })}
                  detail={draft.error.message.split("\n")[0] ?? ""}
                  removeLabel={gt("Remove error")}
                  onRemove={() => updateFeedbackDraft({ error: null })}
                >
                  <TextPreview text={draft.error.message} />
                </AttachmentRow>
              ) : null}
              {draft.screenshot !== null ? (
                <AttachmentRow
                  icon={<CameraIcon />}
                  label={gt("Screenshot")}
                  detail={gt("of this window", { $context: "after: Screenshot" })}
                  removeLabel={gt("Remove screenshot")}
                  onRemove={() => setFeedbackScreenshot(null)}
                >
                  <img
                    src={draft.screenshot.url}
                    alt={gt("Screenshot that will be sent")}
                    className="max-h-72 w-full rounded-md object-contain"
                  />
                </AttachmentRow>
              ) : null}
              {draft.logs !== null ? (
                <AttachmentRow
                  icon={<ScrollTextIcon />}
                  label={gt("Recent logs")}
                  detail=""
                  removeLabel={gt("Remove recent logs")}
                  onRemove={() => updateFeedbackDraft({ logs: null })}
                >
                  <TextPreview text={draft.logs} />
                </AttachmentRow>
              ) : null}
              {draft.conversation !== null ? (
                <AttachmentRow
                  icon={<MessagesSquareIcon />}
                  label={gt("This conversation")}
                  detail={draft.conversationDetail ?? ""}
                  removeLabel={gt("Remove this conversation")}
                  onRemove={() => updateFeedbackDraft({ conversation: null })}
                >
                  <TextPreview text={draft.conversation} />
                </AttachmentRow>
              ) : null}
            </ul>
          ) : null}

          <div className="flex flex-wrap gap-1.5">
            {draft.screenshot === null ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={busy !== null}
                onClick={() => updateFeedbackDraft({ capturing: true })}
              >
                <CameraIcon />
                <T>Add screenshot</T>
              </Button>
            ) : null}
            {draft.logs === null ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={busy !== null}
                onClick={addLogs}
              >
                <ScrollTextIcon />
                {busy === "logs" ? gt("Reading logs…") : gt("Add recent logs")}
              </Button>
            ) : null}
            {draft.conversation === null && threadRef !== null ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={busy !== null}
                onClick={addConversation}
              >
                <MessagesSquareIcon />
                {busy === "conversation" ? gt("Preparing…") : gt("Add this conversation")}
              </Button>
            ) : null}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor={EMAIL_FIELD_ID}>
              <T>Email for a reply</T>{" "}
              <span className="font-normal text-muted-foreground">
                <T>(optional)</T>
              </span>
            </Label>
            <Input
              id={EMAIL_FIELD_ID}
              type="email"
              autoComplete="email"
              value={draft.email}
              aria-invalid={emailInvalid || undefined}
              placeholder="name@university.edu"
              onChange={(event) => updateFeedbackDraft({ email: event.target.value })}
            />
          </div>

          {preparation !== null ? (
            <Collapsible>
              <CollapsibleTrigger className="group flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground">
                <ChevronRightIcon className="size-3.5 transition-transform group-data-[panel-open]:rotate-90" />
                <T>What's sent</T>
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                  {rows.map((row) => (
                    <div key={row.label} className="contents">
                      <dt className="text-muted-foreground">{row.label}</dt>
                      <dd className="min-w-0 whitespace-pre-line wrap-anywhere">{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </CollapsiblePanel>
            </Collapsible>
          ) : null}

          {error !== null ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <p className="text-muted-foreground text-xs sm:me-auto sm:self-center">
            {preparation?.canSend === false
              ? gt("Development builds keep reports on this computer.")
              : preparation !== null && preparation.pendingReports > 0
                ? gt("Sent privately to the Scient team · {count} waiting to send", {
                    count: preparation.pendingReports,
                  })
                : gt("Sent privately to the Scient team.")}
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={busy === "send"}
            onClick={() => closeFeedback()}
          >
            <T>Cancel</T>
          </Button>
          <Button type="button" disabled={!canSubmit} onClick={submit}>
            {busy === "send"
              ? gt("Sending…")
              : gt("Send", { $context: "verb, sends the feedback" })}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
