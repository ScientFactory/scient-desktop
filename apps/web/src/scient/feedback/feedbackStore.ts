import type {
  FeedbackErrorContext,
  FeedbackScreenshot,
  FeedbackSource,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { create } from "zustand";

export interface FeedbackRequest {
  readonly source: FeedbackSource;
  /** The error the person pressed Report on; attached until they remove it. */
  readonly error?: FeedbackErrorContext;
  /** The conversation the report may be about; otherwise the one on screen. */
  readonly threadRef?: ScopedThreadRef;
}

export interface AttachedScreenshot extends FeedbackScreenshot {
  readonly url: string;
}

export interface FeedbackDraft {
  readonly open: boolean;
  /** The dialog is hidden while the window is captured. */
  readonly capturing: boolean;
  readonly openKey: number;
  readonly source: FeedbackSource;
  readonly threadRef: ScopedThreadRef | null;
  readonly error: FeedbackErrorContext | null;
  readonly message: string;
  readonly email: string;
  readonly screenshot: AttachedScreenshot | null;
  readonly logs: string | null;
  readonly conversation: string | null;
  /** How the attached conversation is described, such as "3 messages". */
  readonly conversationDetail: string | null;
}

const EMPTY_ATTACHMENTS = {
  screenshot: null,
  logs: null,
  conversation: null,
  conversationDetail: null,
} as const;

export const useFeedbackDraft = create<FeedbackDraft>(() => ({
  open: false,
  capturing: false,
  openKey: 0,
  source: "sidebar",
  threadRef: null,
  error: null,
  message: "",
  email: "",
  ...EMPTY_ATTACHMENTS,
}));

function revokeScreenshot(screenshot: AttachedScreenshot | null) {
  if (screenshot !== null) URL.revokeObjectURL(screenshot.url);
}

/**
 * Opens "Send feedback to Scient". Typed words and the email survive closing; attachments and
 * an earlier error do not follow the person to a new report.
 */
export function requestFeedback(request: FeedbackRequest): void {
  useFeedbackDraft.setState((draft) => {
    revokeScreenshot(draft.screenshot);
    return {
      open: true,
      capturing: false,
      openKey: draft.openKey + 1,
      source: request.source,
      threadRef: request.threadRef ?? null,
      error: request.error ?? null,
      ...EMPTY_ATTACHMENTS,
    };
  });
}

/** Whether the dialog opened as `openKey` is still open; late results for another report are dropped. */
export function feedbackDraftStillOpen(openKey: number): boolean {
  const draft = useFeedbackDraft.getState();
  return draft.open && draft.openKey === openKey;
}

export function closeFeedback(): void {
  useFeedbackDraft.setState({ open: false, capturing: false });
}

export function updateFeedbackDraft(
  patch: Partial<Omit<FeedbackDraft, "open" | "openKey" | "screenshot">>,
): void {
  useFeedbackDraft.setState(patch);
}

export function setFeedbackScreenshot(screenshot: FeedbackScreenshot | null): void {
  useFeedbackDraft.setState((draft) => {
    revokeScreenshot(draft.screenshot);
    return {
      screenshot:
        screenshot === null
          ? null
          : {
              ...screenshot,
              url: URL.createObjectURL(
                new Blob([screenshot.jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }),
              ),
            },
    };
  });
}

/** After a report is saved: the words and attachments go, the email stays for next time. */
export function clearSentFeedback(): void {
  useFeedbackDraft.setState((draft) => {
    revokeScreenshot(draft.screenshot);
    return { open: false, capturing: false, message: "", error: null, ...EMPTY_ATTACHMENTS };
  });
}
