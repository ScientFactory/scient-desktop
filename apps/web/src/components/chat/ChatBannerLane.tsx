import type {
  EnvironmentId,
  OrchestrationV2ProviderFailureClass,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type { Dispatch, SetStateAction } from "react";
import {
  dismissProviderStatusBannerForSession,
  ProviderStatusBanner,
} from "./ProviderStatusBanner";
import { dismissThreadErrorBannerForSession, ThreadErrorBanner } from "./ThreadErrorBanner";
// SCIENT-FORK:START — report a failed turn to the Scient team.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { feedbackAvailable } from "../../scient/feedback/FeedbackDialog";
import { requestFeedback } from "../../scient/feedback/feedbackStore";
// SCIENT-FORK:END

/**
 * The banners pinned above the timeline. The dismiss handlers are built here from plain
 * values, so a ChatView render that changes neither banner leaves both cached.
 */
export function ChatBannerLane(props: {
  environmentId: EnvironmentId;
  providerStatus: ServerProvider | null;
  providerStatusDismissalKey: string | null;
  onOpenProviderSetup: (instanceId: ProviderInstanceId) => void;
  threadId: ThreadId;
  threadError: string | null;
  threadErrorClass: OrchestrationV2ProviderFailureClass | null;
  threadErrorCode: string | null;
  threadErrorBannerKey: string | null;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  setThreadErrorBannerDismissTick: Dispatch<SetStateAction<number>>;
}) {
  const {
    providerStatus,
    providerStatusDismissalKey,
    onOpenProviderSetup,
    threadId,
    threadError,
    threadErrorClass,
    threadErrorCode,
    threadErrorBannerKey,
    setThreadError,
    setThreadErrorBannerDismissTick,
  } = props;
  return (
    <div className="chat-banner-lane pointer-events-none absolute top-0 z-30 flex flex-col">
      <ProviderStatusBanner
        environmentId={props.environmentId}
        status={providerStatus}
        onDismiss={() => dismissProviderStatusBannerForSession(providerStatusDismissalKey)}
        onOpenProviderSetup={onOpenProviderSetup}
      />
      <ThreadErrorBanner
        error={threadError}
        errorClass={threadErrorClass}
        errorCode={threadErrorCode}
        onDismiss={() => {
          setThreadError(threadId, null);
          dismissThreadErrorBannerForSession(threadErrorBannerKey);
          setThreadErrorBannerDismissTick((tick) => tick + 1);
        }}
        // SCIENT-FORK:START — report a failed turn to the Scient team.
        onReport={
          feedbackAvailable() && threadError !== null
            ? () =>
                requestFeedback({
                  source: "turn-error",
                  error: {
                    message: threadError.slice(0, 8000),
                    ...(threadErrorClass ? { class: threadErrorClass } : {}),
                    ...(threadErrorCode ? { code: threadErrorCode.slice(0, 128) } : {}),
                  },
                  threadRef: scopeThreadRef(props.environmentId, threadId),
                })
            : undefined
        }
        // SCIENT-FORK:END
      />
    </div>
  );
}
