import type { OrchestrationV2ProviderFailureClass } from "@t3tools/contracts";
import {
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_WORKSPACE_ADMIN_REQUEST,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
} from "@t3tools/shared/usageLimits";
import { memo } from "react";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { MODEL_TOKEN_LIMIT_MESSAGE } from "@t3tools/shared/model";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { OpenAI } from "../Icons";
import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";
import { ExpandableText } from "../settings/ExpandableText";

function copyAdminRequest() {
  void writeTextToClipboard(CHATGPT_WORKSPACE_ADMIN_REQUEST, "admin request").then(
    () =>
      toastManager.add({
        type: "success",
        title: "Request copied",
        description: "Send it to your workspace admin.",
      }),
    () => toastManager.add({ type: "error", title: "Could not copy the request" }),
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
  turnId?: string | null,
): string | null {
  if (error === null) return null;
  const occurrence = isTokenLimitError(error) && turnId ? `\u0000${turnId}` : "";
  return `${threadKey}\u0000${error}${occurrence}`;
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
}: {
  error: string | null;
  errorClass?: OrchestrationV2ProviderFailureClass | null;
  errorCode?: string | null;
  onDismiss?: () => void;
}) {
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
              <p className="font-medium">ChatGPT usage limit reached</p>
              <p>
                {workspaceLimit
                  ? "You've reached your workspace's limit for using your ChatGPT plan in other apps. Copy a request to ask your workspace admin for increased usage limits."
                  : "Review your usage settings in ChatGPT."}
              </p>
            </div>
          ) : (
            <ExpandableText text={error} collapsedText={getThreadErrorBannerMessage(error)} />
          )}
        </AlertDescription>
        {(chatGptLimit || onDismiss) && (
          <AlertAction>
            {workspaceLimit ? (
              <Button variant="default" size="sm" onClick={copyAdminRequest}>
                Copy request for admin
              </Button>
            ) : chatGptLimit ? (
              <ChatGptUsageButton variant="default" size="sm" />
            ) : null}
            {onDismiss ? (
              <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={onDismiss}>
                <XIcon />
              </Button>
            ) : null}
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
