import type {
  FeedbackAppDetails,
  FeedbackErrorContext,
  FeedbackScreen,
  FeedbackSource,
} from "@t3tools/contracts";

export interface FeedbackPreviewInput {
  readonly message: string;
  readonly source: FeedbackSource;
  readonly screen: FeedbackScreen;
  readonly email: string;
  readonly details: FeedbackAppDetails;
  readonly error: FeedbackErrorContext | null;
  readonly screenshot: boolean;
  readonly logs: boolean;
  /** How the attached conversation is described, or null when none is attached. */
  readonly conversation: string | null;
}

export interface FeedbackPreviewRow {
  readonly label: string;
  readonly value: string;
}

const SOURCE_LABELS: Record<FeedbackSource, string> = {
  "help-menu": "The Help menu",
  sidebar: "The sidebar",
  "command-palette": "The command palette",
  "turn-error": "A failed turn",
  "error-page": "The error page",
  "slash-command": "The /feedback command",
};

const SCREEN_LABELS: Record<FeedbackScreen, string> = {
  chat: ", in a conversation",
  settings: ", in Settings",
  other: "",
};

const PLATFORM_LABELS: Record<FeedbackAppDetails["platform"], string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
  other: "Other",
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function recentProblems(details: FeedbackAppDetails): string {
  const parts: Array<string> = [];
  if (details.recentFailures.length > 0) {
    parts.push(
      `${plural(details.recentFailures.length, "failed operation", "failed operations")}, by name and trace ID`,
    );
  }
  if (details.rendererCrashes24h > 0) {
    parts.push(plural(details.rendererCrashes24h, "window crash", "window crashes"));
  }
  return parts.length === 0 ? "None in the last day" : `${parts.join("; ")}, in the last day`;
}

/** The "What's sent" list: one row per part of the report the app will upload. */
export function feedbackPreviewRows(
  input: FeedbackPreviewInput,
): ReadonlyArray<FeedbackPreviewRow> {
  const { details } = input;
  const rows: Array<FeedbackPreviewRow> = [];
  if (input.message.trim().length > 0) rows.push({ label: "Your message", value: "As written" });
  if (input.error !== null) {
    rows.push({
      label: "Error",
      value: input.error.code || input.error.class ? "As shown, with its error code" : "As shown",
    });
  }
  if (input.screenshot) rows.push({ label: "Screenshot", value: "Of this window" });
  if (input.logs) rows.push({ label: "Recent logs", value: "As shown" });
  if (input.conversation !== null) {
    rows.push({ label: "This conversation", value: input.conversation || "As shown" });
  }
  if (input.email.trim().length > 0) rows.push({ label: "Reply to", value: input.email.trim() });
  rows.push(
    { label: "Scient version", value: `${details.version} (${details.channel})` },
    {
      label: "System",
      value: `${PLATFORM_LABELS[details.platform]} ${details.osVersion}, ${details.arch}, ${details.locale}`,
    },
    { label: "Recent problems", value: recentProblems(details) },
    {
      label: "Opened from",
      value: `${SOURCE_LABELS[input.source]}${SCREEN_LABELS[input.screen]}`,
    },
  );
  return rows;
}
