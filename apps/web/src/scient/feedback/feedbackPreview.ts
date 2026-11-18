import type {
  FeedbackAppDetails,
  FeedbackErrorContext,
  FeedbackScreen,
  FeedbackSource,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

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
  "help-menu": msg("The Help menu"),
  sidebar: msg("The sidebar"),
  "command-palette": msg("The command palette"),
  "turn-error": msg("A failed turn"),
  "error-page": msg("The error page"),
  "slash-command": msg("The /feedback command"),
};

function openedFrom(source: FeedbackSource, screen: FeedbackScreen, resolve: MessageResolver) {
  const from = resolve(SOURCE_LABELS[source]);
  switch (screen) {
    case "chat":
      return resolve(msg("{source}, in a conversation", { source: from }));
    case "settings":
      return resolve(msg("{source}, in Settings", { source: from }));
    case "other":
      return from;
  }
}

const PLATFORM_LABELS: Record<FeedbackAppDetails["platform"], string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
  other: msg("Other", { $context: "operating system" }),
};

function recentProblems(details: FeedbackAppDetails, resolve: MessageResolver): string {
  const parts: Array<string> = [];
  if (details.recentFailures.length > 0) {
    parts.push(
      resolve(
        msg(
          "{count, plural, one {{count} failed operation, by name and trace ID} other {{count} failed operations, by name and trace ID}}",
          { count: details.recentFailures.length },
        ),
      ),
    );
  }
  if (details.rendererCrashes24h > 0) {
    parts.push(
      resolve(
        msg("{count, plural, one {{count} window crash} other {{count} window crashes}}", {
          count: details.rendererCrashes24h,
        }),
      ),
    );
  }
  return parts.length === 0
    ? resolve(msg("None in the last day"))
    : resolve(msg("{problems}, in the last day", { problems: parts.join("; ") }));
}

/** The "What's sent" list: one row per part of the report the app will upload. */
export function feedbackPreviewRows(
  input: FeedbackPreviewInput,
  resolve: MessageResolver = m,
): ReadonlyArray<FeedbackPreviewRow> {
  const { details } = input;
  const rows: Array<FeedbackPreviewRow> = [];
  const asShown = resolve(msg("As shown", { $context: "sent as it is shown above" }));
  if (input.message.trim().length > 0) {
    rows.push({ label: resolve(msg("Your message")), value: resolve(msg("As written")) });
  }
  if (input.error !== null) {
    rows.push({
      label: resolve(msg("Error", { $context: "the error attached to a feedback report" })),
      value:
        input.error.code || input.error.class
          ? resolve(msg("As shown, with its error code"))
          : asShown,
    });
  }
  if (input.screenshot) {
    rows.push({ label: resolve(msg("Screenshot")), value: resolve(msg("Of this window")) });
  }
  if (input.logs) rows.push({ label: resolve(msg("Recent logs")), value: asShown });
  if (input.conversation !== null) {
    rows.push({ label: resolve(msg("This conversation")), value: input.conversation || asShown });
  }
  if (input.email.trim().length > 0) {
    rows.push({ label: resolve(msg("Reply to")), value: input.email.trim() });
  }
  rows.push(
    { label: resolve(msg("Scient version")), value: `${details.version} (${details.channel})` },
    {
      label: resolve(msg("System", { $context: "operating system" })),
      value: `${resolve(PLATFORM_LABELS[details.platform])} ${details.osVersion}, ${details.arch}, ${details.locale}`,
    },
    { label: resolve(msg("Recent problems")), value: recentProblems(details, resolve) },
    {
      label: resolve(msg("Opened from")),
      value: openedFrom(input.source, input.screen, resolve),
    },
  );
  return rows;
}
