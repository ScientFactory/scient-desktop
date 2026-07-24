// FILE: ConnectionRecoveryNotifications.tsx
// Purpose: Surfaces calm, actionable local-service connection recovery status.
// Layer: Global web application notifications

import { useEffect } from "react";

import { ConnectionRecoveryNoticeController } from "../connectionRecoveryNotice";
import { activityManager } from "../notifications/activityStore";
import { addWsTransportStateListener } from "../wsTransportEvents";

const CONNECTION_ACTIVITY_KEY = "system:local-service-connection";

export function ConnectionRecoveryNotifications() {
  useEffect(() => {
    const controller = new ConnectionRecoveryNoticeController({
      onClear: () => activityManager.remove(CONNECTION_ACTIVITY_KEY),
      onRecovered: () => {
        activityManager.publish({
          dedupeKey: CONNECTION_ACTIVITY_KEY,
          source: "system",
          status: "recent",
          tone: "success",
          title: "Reconnected",
          description: "Scient is connected to its local service again.",
          preserveRead: true,
        });
      },
      onShow: () => {
        activityManager.publish({
          dedupeKey: CONNECTION_ACTIVITY_KEY,
          source: "system",
          status: "in_progress",
          tone: "info",
          title: "Reconnecting to Scient",
          description:
            "Scient is restoring its local connection. Open chats remain on this computer.",
          preserveRead: true,
        });
      },
      onShowDetails: (stateStartedAt) => {
        activityManager.publish({
          dedupeKey: CONNECTION_ACTIVITY_KEY,
          source: "system",
          status: "needs_attention",
          tone: "warning",
          title: "Scient is still reconnecting",
          description:
            "Scient keeps trying automatically. Open Settings → Advanced if you need diagnostics.",
          destination: {
            type: "connection_diagnostics",
            stateStartedAt: stateStartedAt.toISOString(),
          },
        });
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
