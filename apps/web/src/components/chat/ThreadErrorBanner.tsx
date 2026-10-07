import type { OrchestrationV2ProviderFailureClass } from "@t3tools/contracts";
import { memo } from "react";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { MODEL_TOKEN_LIMIT_MESSAGE } from "@t3tools/shared/model";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { OpenAI } from "../Icons";
import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";

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

// Session-scoped (module-level so it survives ChatView remounts, e.g. route
// changes between threads). Mirrors the branch-mismatch banner: a dismissal
// is remembered per thread key plus message, so navigating away to a thread
// with no error cannot resurrect the banner, while a different error message
// on the same thread still appears.
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
  chatGptUsageLimit = false,
}: {
  error: string | null;
  errorClass?: OrchestrationV2ProviderFailureClass | null;
  onDismiss?: () => void;
  chatGptUsageLimit?: boolean;
}) {
  if (!error) return null;
  const variant = errorClass === "usage_limit" ? "warning" : "error";
  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert variant={variant} surface="glass" controlAlignment="first-line" data-variant={variant}>
        {chatGptUsageLimit ? (
          <OpenAI className="size-4 text-foreground!" aria-hidden="true" />
        ) : (
          <CircleAlertIcon />
        )}
        <AlertDescription>
          {chatGptUsageLimit ? (
            <div className="space-y-1">
              <p className="font-medium">ChatGPT usage limit reached</p>
              <p>Review your usage settings in ChatGPT to continue.</p>
            </div>
          ) : (
            <Tooltip>
              <TooltipTrigger render={<div className="line-clamp-3" />}>{error}</TooltipTrigger>
              <TooltipPopup side="top" className="whitespace-pre-wrap">
                {error}
              </TooltipPopup>
            </Tooltip>
          )}
        </AlertDescription>
        {(chatGptUsageLimit || onDismiss) && (
          <AlertAction>
            {chatGptUsageLimit ? <ChatGptUsageButton variant="default" size="sm" /> : null}
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
