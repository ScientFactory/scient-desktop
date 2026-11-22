/**
 * Feedback reports a person sends to the Scient team: the wire format the desktop app uploads and
 * the feedback Worker (`infra/scient-feedback`) accepts, and the desktop bridge that sends them.
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt } from "../baseSchemas.ts";

export const SCIENT_FEEDBACK_ORIGIN = "https://feedback.scientfactory.com";
export const FEEDBACK_CLIENT_ID_HEADER = "x-scient-feedback-client";

export const FEEDBACK_MESSAGE_MAX_LENGTH = 20_000;
const FEEDBACK_ERROR_MAX_LENGTH = 8_000;
export const FEEDBACK_EMAIL_MAX_LENGTH = 254;
export const FEEDBACK_SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;
export const FEEDBACK_LOGS_MAX_BYTES = 256 * 1024;
export const FEEDBACK_CONVERSATION_MAX_BYTES = 1024 * 1024;
export const FEEDBACK_REQUEST_MAX_BYTES = 4 * 1024 * 1024;
/** Ids an app may ask about in one status request. */
export const FEEDBACK_STATUS_MAX_IDS = 20;

const BoundedText = (max: number) => Schema.String.check(Schema.isMaxLength(max));

/** Made by the app; also the idempotency key of the upload. */
export const FeedbackReportId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
);
export type FeedbackReportId = typeof FeedbackReportId.Type;

/** 32 random bytes, base64url; one per installation, separate from analytics. */
export const FeedbackClientId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/));
export type FeedbackClientId = typeof FeedbackClientId.Type;

export const FeedbackSource = Schema.Literals([
  "help-menu",
  "sidebar",
  "command-palette",
  "turn-error",
  "error-page",
  "slash-command",
]);
export type FeedbackSource = typeof FeedbackSource.Type;

export const FeedbackScreen = Schema.Literals(["chat", "settings", "other"]);
export type FeedbackScreen = typeof FeedbackScreen.Type;

export const FeedbackBuildChannel = Schema.Literals([
  "stable",
  "beta",
  "nightly",
  "development",
  "unknown",
]);
export type FeedbackBuildChannel = typeof FeedbackBuildChannel.Type;

export const FeedbackPlatform = Schema.Literals(["darwin", "win32", "linux", "other"]);
export type FeedbackPlatform = typeof FeedbackPlatform.Type;

export const FeedbackEmail = BoundedText(FEEDBACK_EMAIL_MAX_LENGTH).check(
  Schema.isPattern(/^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/),
);

export const FeedbackAttachmentKind = Schema.Literals(["screenshot", "logs", "conversation"]);
export type FeedbackAttachmentKind = typeof FeedbackAttachmentKind.Type;

export const FEEDBACK_ATTACHMENT_MAX_BYTES: Record<FeedbackAttachmentKind, number> = {
  screenshot: FEEDBACK_SCREENSHOT_MAX_BYTES,
  logs: FEEDBACK_LOGS_MAX_BYTES,
  conversation: FEEDBACK_CONVERSATION_MAX_BYTES,
};

export const FEEDBACK_ATTACHMENT_MEDIA_TYPE: Record<FeedbackAttachmentKind, string> = {
  screenshot: "image/jpeg",
  logs: "text/plain; charset=utf-8",
  conversation: "text/markdown; charset=utf-8",
};

/** A failed operation from the app's own trace: its code-given name, when, and its trace id. */
export const FeedbackRecentFailure = Schema.Struct({
  name: BoundedText(120),
  at: BoundedText(32),
  traceId: BoundedText(64),
});
export type FeedbackRecentFailure = typeof FeedbackRecentFailure.Type;

/** Facts the app adds to every report: versions, numbers, listed values and failure ids. */
export const FeedbackAppDetails = Schema.Struct({
  version: BoundedText(64),
  channel: FeedbackBuildChannel,
  platform: FeedbackPlatform,
  osVersion: BoundedText(64),
  arch: BoundedText(16),
  locale: BoundedText(35),
  /** Scient windows that crashed in the last 24 hours. */
  rendererCrashes24h: NonNegativeInt.check(Schema.isLessThanOrEqualTo(1000)),
  /** The latest failed operations in the last 24 hours, newest first; at most five. */
  recentFailures: Schema.Array(FeedbackRecentFailure).check(Schema.isMaxLength(5)),
});
export type FeedbackAppDetails = typeof FeedbackAppDetails.Type;

/** The error the report was opened from; the person can remove it. */
export const FeedbackErrorContext = Schema.Struct({
  message: BoundedText(FEEDBACK_ERROR_MAX_LENGTH),
  class: Schema.optionalKey(BoundedText(64)),
  code: Schema.optionalKey(BoundedText(128)),
});
export type FeedbackErrorContext = typeof FeedbackErrorContext.Type;

export const FeedbackAttachmentSummary = Schema.Struct({
  kind: FeedbackAttachmentKind,
  bytes: NonNegativeInt,
});

const FeedbackReportFields = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: FeedbackReportId,
  /** ISO 8601, set when the person pressed Send. */
  createdAt: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)),
  message: BoundedText(FEEDBACK_MESSAGE_MAX_LENGTH),
  source: FeedbackSource,
  screen: FeedbackScreen,
  contactEmail: Schema.optionalKey(FeedbackEmail),
  app: FeedbackAppDetails,
  error: Schema.optionalKey(FeedbackErrorContext),
  attachments: Schema.Array(FeedbackAttachmentSummary).check(Schema.isMaxLength(3)),
});

/** The `report` part of an upload. Either words or an attached error. */
export const FeedbackReport = FeedbackReportFields.check(
  Schema.makeFilter((report: typeof FeedbackReportFields.Type) => {
    if (report.message.trim().length === 0 && report.error === undefined) {
      return "A report needs a message or an error.";
    }
    const kinds = new Set(report.attachments.map((attachment) => attachment.kind));
    if (kinds.size !== report.attachments.length) return "Each attachment kind appears once.";
    return report.attachments.every(
      (attachment) => attachment.bytes <= FEEDBACK_ATTACHMENT_MAX_BYTES[attachment.kind],
    )
      ? undefined
      : "An attachment is too large.";
  }),
);
export type FeedbackReport = typeof FeedbackReport.Type;

export const FeedbackReportStatus = Schema.Literals(["new", "seen", "fixed", "closed"]);
export type FeedbackReportStatus = typeof FeedbackReportStatus.Type;

/** What the reporter's app may learn about its own report. */
export const FeedbackStatusEntry = Schema.Struct({
  id: FeedbackReportId,
  status: FeedbackReportStatus,
  fixedIn: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
});
export type FeedbackStatusEntry = typeof FeedbackStatusEntry.Type;

export const FeedbackStatusResponse = Schema.Struct({
  reports: Schema.Array(FeedbackStatusEntry),
});

export const FeedbackAcceptedResponse = Schema.Struct({
  id: FeedbackReportId,
  receivedAt: Schema.String,
});

// Desktop bridge

/** A screenshot of the Scient window, captured when the person asked for it. */
export interface FeedbackScreenshot {
  readonly jpeg: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface FeedbackPreparation {
  readonly details: FeedbackAppDetails;
  /** The email the person used last time, if any. */
  readonly lastContactEmail: string | null;
  /** False in development builds without a test endpoint: reports stay on this computer. */
  readonly canSend: boolean;
  /** Earlier reports saved on this computer that are still waiting to be sent. */
  readonly pendingReports: number;
}

export interface FeedbackSubmitRequest {
  readonly message: string;
  readonly source: FeedbackSource;
  readonly screen: FeedbackScreen;
  readonly contactEmail: string | null;
  /** The details shown in the dialog's "What's sent", sent unchanged. */
  readonly details: FeedbackAppDetails;
  readonly error: FeedbackErrorContext | null;
  readonly screenshot: Uint8Array | null;
  readonly logs: string | null;
  readonly conversation: string | null;
}

export type FeedbackSubmitResult =
  | { readonly _tag: "sent"; readonly id: FeedbackReportId }
  /** Saved on this computer; sent when the service can be reached. */
  | { readonly _tag: "queued"; readonly id: FeedbackReportId }
  /** Development build without a test endpoint. */
  | { readonly _tag: "kept-locally"; readonly id: FeedbackReportId }
  | { readonly _tag: "failed"; readonly message: string };

/** A report the team marked fixed in a version this app now runs. Shown once. */
export interface FeedbackFixedNotice {
  readonly id: FeedbackReportId;
  readonly excerpt: string;
  readonly fixedIn: string;
  readonly note: string | null;
}

export interface DesktopFeedbackBridge {
  prepare: () => Promise<FeedbackPreparation>;
  /** Captures the main window; the caller hides its dialog first. Null when capture failed. */
  captureScreenshot: () => Promise<FeedbackScreenshot | null>;
  /** The end of the app's own logs, with the home folder and secret-shaped text masked. */
  readRecentLogs: () => Promise<string>;
  submit: (request: FeedbackSubmitRequest) => Promise<FeedbackSubmitResult>;
  /** Fix notices not shown yet; taking them marks them shown. */
  takeFixedNotices: () => Promise<ReadonlyArray<FeedbackFixedNotice>>;
}
