// FILE: ConnectionRecoveryNotifications.tsx
// Purpose: Surfaces calm, actionable local-service connection recovery status.
// Layer: Global web application notifications

import { useEffect, useRef } from "react";

import { APP_VERSION } from "../branding";
import {
  ConnectionRecoveryNoticeController,
  formatConnectionRecoveryDiagnostics,
} from "../connectionRecoveryNotice";
import { addWsTransportStateListener } from "../wsTransportEvents";
import { toastManager } from "./ui/toast";

type RecoveryToastId = ReturnType<typeof toastManager.add>;

export function ConnectionRecoveryNotifications() {
  const toastIdRef = useRef<RecoveryToastId | null>(null);

  useEffect(() => {
    const clearToast = () => {
      if (toastIdRef.current !== null) toastManager.close(toastIdRef.current);
      toastIdRef.current = null;
    };

    let controller: ConnectionRecoveryNoticeController;
    controller = new ConnectionRecoveryNoticeController({
      onClear: clearToast,
      onRecovered: () => {
        const toastId = toastIdRef.current;
        if (toastId === null) return;
        toastManager.update(toastId, {
          type: "success",
          title: "Reconnected",
          description: "Scient is connected to its local service again.",
          actionProps: undefined,
          onClose: undefined,
          data: {
            allowCrossThreadVisibility: true,
            dismissAfterVisibleMs: 3_000,
            showDescription: true,
          },
          timeout: 0,
        });
      },
      onShow: () => {
        toastIdRef.current = toastManager.add({
          type: "loading",
          title: "Reconnecting…",
          description:
            "Scient is restoring its local connection. Open chats remain on this computer.",
          onClose: () => {
            controller.dismissCurrentOutage();
            toastIdRef.current = null;
          },
          data: { allowCrossThreadVisibility: true, showDescription: true },
          timeout: 0,
        });
      },
      onShowDetails: (stateStartedAt) => {
        const diagnostics = formatConnectionRecoveryDiagnostics({
          appVersion: APP_VERSION,
          desktopApp: Boolean(window.desktopBridge),
          generatedAt: new Date(),
          navigatorOnline: typeof navigator.onLine === "boolean" ? navigator.onLine : null,
          platform: navigator.platform,
          state: "reconnecting",
          stateStartedAt,
          visibility: document.visibilityState,
        });
        const openLogs = window.desktopBridge?.diagnostics?.openLogsDirectory;
        const nextToast = {
          type: "warning" as const,
          title: "Scient is still reconnecting",
          description:
            "Scient keeps trying automatically. Copy the connection summary or open the logs for details.",
          actionProps: undefined,
          onClose: () => {
            controller.dismissCurrentOutage();
            toastIdRef.current = null;
          },
          data: {
            allowCrossThreadVisibility: true,
            copyLabel: "diagnostics",
            copyText: diagnostics,
            ...(openLogs
              ? {
                  secondaryActionProps: {
                    children: "Open logs",
                    onClick: () => {
                      void openLogs().catch((error: unknown) => {
                        toastManager.add({
                          type: "error",
                          title: "Could not open logs",
                          description:
                            error instanceof Error
                              ? error.message
                              : "The logs folder could not be opened.",
                        });
                      });
                    },
                  },
                }
              : {}),
          },
          timeout: 0,
        };
        if (toastIdRef.current === null) {
          toastIdRef.current = toastManager.add(nextToast);
        } else {
          toastManager.update(toastIdRef.current, nextToast);
        }
      },
    });

    const unsubscribe = addWsTransportStateListener((state) => controller.handleState(state), {
      replayLatest: true,
    });
    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, []);

  return null;
}
