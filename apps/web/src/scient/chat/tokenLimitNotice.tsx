import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { InfoIcon } from "lucide-react";
import { useMemo } from "react";

import type { ComposerBannerStackItem } from "~/components/chat/ComposerBannerStack";
import {
  dismissThreadErrorBannerForSession,
  getTruncationNoticeKey,
  isThreadErrorBannerDismissedForSession,
  isTokenLimitError as isTokenLimitThreadError,
} from "~/components/chat/ThreadErrorBanner";

const EMPTY_TURN_ITEMS: ReadonlyArray<OrchestrationV2TurnItem> = [];

/**
 * A response that stopped at a token limit shows a composer notice instead of
 * the thread error banner, once the thread is no longer working.
 */
export function useTokenLimitNotice(input: {
  readonly routeThreadKey: string;
  readonly visibleThreadError: string | null;
  readonly threadErrorBannerKey: string | null;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem> | undefined;
  readonly latestRunId: string | null | undefined;
  readonly runtimeStatus: string | undefined;
}) {
  const {
    routeThreadKey,
    visibleThreadError,
    threadErrorBannerKey,
    turnItems,
    latestRunId,
    runtimeStatus,
  } = input;
  const isTokenLimitError = isTokenLimitThreadError(visibleThreadError);
  const truncationNoticeKey = useMemo(
    () =>
      getTruncationNoticeKey(
        routeThreadKey,
        turnItems ?? EMPTY_TURN_ITEMS,
        latestRunId,
        runtimeStatus,
      ),
    [routeThreadKey, turnItems, latestRunId, runtimeStatus],
  );
  const tokenLimitNoticeKey =
    truncationNoticeKey ?? (isTokenLimitError ? threadErrorBannerKey : null);
  const hasTokenLimitNotice =
    tokenLimitNoticeKey !== null &&
    !isThreadErrorBannerDismissedForSession(tokenLimitNoticeKey) &&
    runtimeStatus !== "running" &&
    runtimeStatus !== "starting";
  return { isTokenLimitError, tokenLimitNoticeKey, hasTokenLimitNotice };
}

/** The composer banner for a token-limit stop; dismissing it masks it for the session. */
export function tokenLimitBannerItems(input: {
  readonly hasTokenLimitNotice: boolean;
  readonly tokenLimitNoticeKey: string | null;
  readonly onDismissed: () => void;
}): ComposerBannerStackItem[] {
  const { hasTokenLimitNotice, tokenLimitNoticeKey, onDismissed } = input;
  return hasTokenLimitNotice
    ? [
        {
          id: `token-limit:${tokenLimitNoticeKey}`,
          variant: "info",
          priority: "urgent",
          icon: <InfoIcon />,
          title: "Response stopped at a token limit.",
          dismissLabel: "Dismiss token limit notice",
          onDismiss: () => {
            dismissThreadErrorBannerForSession(tokenLimitNoticeKey);
            onDismissed();
          },
        },
      ]
    : [];
}
