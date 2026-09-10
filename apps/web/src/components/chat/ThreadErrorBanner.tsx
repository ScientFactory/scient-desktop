import { memo } from "react";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { MODEL_TOKEN_LIMIT_MESSAGE } from "@t3tools/shared/model";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

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

/** A new turn supersedes the notice; persisted activity makes reloads deterministic. */
export function getTruncationNoticeKey(
  threadKey: string,
  activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "id" | "kind" | "turnId">>,
  turnId: string | null | undefined,
  status: string | undefined,
): string | null {
  if (!turnId || status === "running" || status === "starting") return null;
  const activity = activities.findLast(
    (entry) => entry.kind === "turn.truncated" && entry.turnId === turnId,
  );
  return activity ? `${threadKey}\u0000truncation\u0000${activity.id}` : null;
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
}: {
  error: string | null;
  onDismiss?: () => void;
}) {
  if (!error) return null;
  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert
        variant="error"
        controlAlignment="first-line"
        className="alert-glass"
        data-variant="error"
      >
        <CircleAlertIcon />
        <AlertDescription>
          <Tooltip>
            <TooltipTrigger render={<div className="line-clamp-3" />}>{error}</TooltipTrigger>
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
              {error}
            </TooltipPopup>
          </Tooltip>
        </AlertDescription>
        {onDismiss && (
          <AlertAction>
            <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={onDismiss}>
              <XIcon className="text-destructive" />
            </Button>
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
