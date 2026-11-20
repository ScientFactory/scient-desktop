import type { OrchestrationV2ProviderFailureClass } from "@t3tools/contracts";
import {
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_WORKSPACE_ADMIN_REQUEST,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
} from "@t3tools/shared/usageLimits";
import { msg, T, useGT } from "gt-react";
import { memo } from "react";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { MODEL_TOKEN_LIMIT_MESSAGE } from "@t3tools/shared/model";
import { m } from "../../i18n/messages";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { OpenAI } from "../Icons";
import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";
import { ExpandableText } from "../settings/ExpandableText";

export function copyAdminRequest() {
  void writeTextToClipboard(CHATGPT_WORKSPACE_ADMIN_REQUEST, {
    target: "admin request",
    unavailableMessage: msg("Clipboard API is unavailable while copying admin request."),
    failureMessage: msg("Failed to copy admin request to the clipboard."),
  }).then(
    () =>
      toastManager.add({
        type: "success",
        title: m(msg("Request copied")),
        description: m(msg("Send it to your workspace admin.")),
      }),
    () => toastManager.add({ type: "error", title: m(msg("Could not copy the request")) }),
  );
}

export function getThreadErrorBannerMessage(error: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(error);
  } catch {
    return error;
  }
  if (typeof payload !== "object" || payload === null || !("error" in payload)) {
    return error;
  }
  const nestedError = payload.error;
  if (typeof nestedError !== "object" || nestedError === null || !("message" in nestedError)) {
    return error;
  }
  return typeof nestedError.message === "string" && nestedError.message.trim().length > 0
    ? nestedError.message
    : error;
}

export function isTokenLimitError(error: string | null): boolean {
  if (error === null) return false;
  return error === MODEL_TOKEN_LIMIT_MESSAGE;
}

export function getThreadErrorBannerKey(
  threadKey: string,
  error: string | null,
  source: string | null = null,
): string | null {
  return error === null ? null : `${threadKey}\u0000${source ?? ""}\u0000${error}`;
}

export function shouldShowThreadErrorBanner(
  threadKey: string,
  error: string | null,
  isDismissed: boolean,
): boolean {
  return getThreadErrorBannerKey(threadKey, error) !== null && !isDismissed;
}

/** A new run supersedes the notice; the persisted item survives reloads. */
export function getTruncationNoticeKey(
  threadKey: string,
  items: ReadonlyArray<
    | Pick<
        Extract<OrchestrationV2TurnItem, { type: "notification" }>,
        "id" | "type" | "runId" | "source"
      >
    | Pick<Exclude<OrchestrationV2TurnItem, { type: "notification" }>, "id" | "type" | "runId">
  >,
  runId: string | null | undefined,
  status: string | undefined,
): string | null {
  if (!runId || status === "running" || status === "starting") return null;
  const item = items.findLast(
    (entry) =>
      entry.type === "notification" &&
      entry.source?.kind === "output_truncated" &&
      entry.runId === runId,
  );
  return item ? `${threadKey}\u0000truncation\u0000${item.id}` : null;
}

const sessionDismissedThreadErrorBannerKeys = new Set<string>();

export function dismissThreadErrorBannerForSession(bannerKey: string | null): void {
  if (bannerKey !== null) {
    sessionDismissedThreadErrorBannerKeys.add(bannerKey);
  }
}

export function isThreadErrorBannerDismissedForSession(bannerKey: string | null): boolean {
  return bannerKey !== null && sessionDismissedThreadErrorBannerKeys.has(bannerKey);
}

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
  errorClass,
  errorCode,
  // SCIENT-FORK:START — report the failure to the Scient team.
  onReport,
  // SCIENT-FORK:END
}: {
  error: string | null;
  errorClass?: OrchestrationV2ProviderFailureClass | null;
  errorCode?: string | null;
  onDismiss?: () => void;
  // SCIENT-FORK:START — report the failure to the Scient team.
  onReport?: (() => void) | undefined;
  // SCIENT-FORK:END
}) {
  const gt = useGT();
  if (!error) return null;
  const workspaceLimit = errorCode === CHATGPT_WORKSPACE_USAGE_LIMIT_CODE;
  const chatGptLimit = workspaceLimit || errorCode === CHATGPT_USAGE_LIMIT_CODE;
  const variant = errorClass === "usage_limit" || chatGptLimit ? "warning" : "error";
  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert variant={variant} surface="glass" controlAlignment="first-line" data-variant={variant}>
        {chatGptLimit ? (
          <OpenAI className="size-4 text-foreground!" aria-hidden="true" />
        ) : (
          <CircleAlertIcon />
        )}
        <AlertDescription>
          {chatGptLimit ? (
            <div className="space-y-1">
              <p className="font-medium">
                <T>ChatGPT usage limit reached</T>
              </p>
              {workspaceLimit ? (
                <p>
                  {gt(
                    "You've reached your workspace's limit for using your ChatGPT plan in other apps. Copy a request to ask your workspace admin for increased usage limits.",
                  )}
                </p>
              ) : null}
            </div>
          ) : (
            <ExpandableText text={error} collapsedText={getThreadErrorBannerMessage(error)} />
          )}
        </AlertDescription>
        {(chatGptLimit || onDismiss) && (
          <AlertAction>
            {workspaceLimit ? (
              <Button variant="default" size="sm" onClick={copyAdminRequest}>
                <T>Copy request for admin</T>
              </Button>
            ) : chatGptLimit ? (
              <ChatGptUsageButton variant="default" size="sm" />
            ) : null}
            {/* SCIENT-FORK:START — report the failure to the Scient team. */}
            {onReport && !chatGptLimit ? (
              <Button variant="outline" size="xs" onClick={onReport}>
                <T context="button that reports a failure to the Scient team">Report</T>
              </Button>
            ) : null}
            {/* SCIENT-FORK:END */}
            {onDismiss ? (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={gt("Dismiss error")}
                onClick={onDismiss}
              >
                <XIcon />
              </Button>
            ) : null}
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
