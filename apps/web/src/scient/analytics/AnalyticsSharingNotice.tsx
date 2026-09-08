import { useLocation, useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState } from "react";
import { ArrowRightIcon } from "lucide-react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { usePreparedConnection } from "../../state/session";
import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { AnalyticsSharingInfo } from "./AnalyticsSharingInfo";
import { readScientAnalyticsStatus } from "./client";

/** One-time disclosure for installations whose analytics sharing is active. */
export function AnalyticsSharingNotice() {
  const environmentId = usePrimaryEnvironmentId();
  // A separate keyed lifetime prevents a pending read or dismissal crossing environments.
  return environmentId === null ? null : (
    <EnvironmentSharingNotice key={environmentId} environmentId={environmentId} />
  );
}

function EnvironmentSharingNotice({
  environmentId,
}: {
  environmentId: NonNullable<ReturnType<typeof usePrimaryEnvironmentId>>;
}) {
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const inPrivacySettings = pathname === "/settings/general";
  const [dismissed, setDismissed] = useLocalStorage(
    `scient:analytics-sharing-notice:v1:${environmentId}`,
    false,
    Schema.Boolean,
  );
  // Keep dismissal effective for this session even if persistent storage is unavailable.
  const [dismissedThisSession, setDismissedThisSession] = useState(false);
  const dismissVisibleNotice = useRef<(() => void) | null>(null);
  const previousPathname = useRef(pathname);

  useEffect(() => {
    // Only a notice already shown is consumed by navigation; loading is not disclosure.
    if (previousPathname.current !== pathname) dismissVisibleNotice.current?.();
    previousPathname.current = pathname;
  }, [pathname]);

  useEffect(() => {
    if (prepared === null || dismissed || dismissedThisSession || inPrivacySettings) return;
    let active = true;
    let toastId: ReturnType<typeof toastManager.add> | undefined;
    const dismiss = () => {
      dismissVisibleNotice.current = null;
      if (toastId !== undefined) toastManager.close(toastId);
      setDismissedThisSession(true);
      setDismissed(true);
    };
    const onLeave = () => {
      if (toastId !== undefined) dismiss();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") onLeave();
    };
    window.addEventListener("blur", onLeave);
    document.addEventListener("visibilitychange", onVisibilityChange);
    void readScientAnalyticsStatus(prepared)
      .then((status) => {
        if (!active || !status.available || status.consent === "off") return;
        toastId = toastManager.add(
          stackedThreadToast({
            type: "info",
            title: "Analytics sharing is on",
            description: (
              <p>
                {status.consent === "essential"
                  ? "Scient shares reliability information to help fix problems."
                  : "Scient shares how you use the app and what goes wrong to help improve it."}{" "}
                Analytics never collects your conversations, files, or credentials. You can turn
                sharing off in Settings.
              </p>
            ),
            timeout: 0,
            actionProps: {
              children: (
                <>
                  Review in settings <ArrowRightIcon aria-hidden="true" />
                </>
              ),
              onClick: () => {
                dismiss();
                if (toastId !== undefined) toastManager.close(toastId);
                void navigate({ to: "/settings/general", hash: "scient-analytics" });
              },
            },
            actionVariant: "link",
            data: {
              hideCopyButton: true,
              onClose: dismiss,
              fullWidthDescription: true,
              actionLeadingContent: <AnalyticsSharingInfo consent={status.consent} />,
            },
          }),
        );
        dismissVisibleNotice.current = dismiss;
      })
      .catch(() => {
        // A failed status read must not block startup or claim that sharing is on.
      });
    return () => {
      active = false;
      window.removeEventListener("blur", onLeave);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (toastId !== undefined) toastManager.close(toastId);
    };
  }, [prepared, dismissed, dismissedThisSession, inPrivacySettings, navigate, setDismissed]);

  return null;
}
