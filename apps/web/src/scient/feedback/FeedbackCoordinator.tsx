import type { ScopedThreadRef } from "@t3tools/contracts";
import { MegaphoneIcon } from "lucide-react";
import { useEffect } from "react";

import {
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
} from "../../components/CommandPalette.logic";
import { toastManager } from "../../components/ui/toast";
import { registerMenuAction } from "../../shortcuts/dispatcher";
import { FeedbackDialogHost, feedbackAvailable } from "./FeedbackDialog";
import { requestFeedback } from "./feedbackStore";

export const FeedbackIcon = MegaphoneIcon;

/** The desktop Help menu item's action. */
const SEND_FEEDBACK_MENU_ACTION = "send-feedback";

const NOTICE_CHECK_MIN_INTERVAL_MS = 60_000;

/** Shows each "fixed in this version" notice once. */
function showFixedNotices() {
  void window.desktopBridge?.feedback?.takeFixedNotices().then(
    (notices) => {
      for (const notice of notices) {
        toastManager.add({
          type: "success",
          // Shown once ever, so it waits for the person instead of timing out.
          timeout: 0,
          title: `Fixed in Scient ${notice.fixedIn}`,
          description: `"${notice.excerpt}" Thanks for reporting it.${notice.note ? `\n${notice.note}` : ""}`,
        });
      }
    },
    () => undefined,
  );
}

/** Help ▸ Send Feedback, fix notices, and the dialog itself. Desktop only. */
export function FeedbackCoordinator() {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the desktop menu and window focus for fix notices
  useEffect(() => {
    if (!feedbackAvailable()) return;
    const unregister = registerMenuAction(SEND_FEEDBACK_MENU_ACTION, () =>
      requestFeedback({ source: "help-menu" }),
    );
    let lastCheck = 0;
    const check = () => {
      const now = Date.now();
      if (now - lastCheck < NOTICE_CHECK_MIN_INTERVAL_MS) return;
      lastCheck = now;
      showFixedNotices();
    };
    check();
    window.addEventListener("focus", check);
    return () => {
      unregister();
      window.removeEventListener("focus", check);
    };
  }, []);
  return <FeedbackDialogHost />;
}

/** "Send feedback to Scient" in the command palette. */
export function feedbackPaletteItems(
  threadRef: ScopedThreadRef | null,
): ReadonlyArray<CommandPaletteActionItem> {
  if (!feedbackAvailable()) return [];
  return [
    {
      kind: "action",
      value: "action:send-feedback",
      searchTerms: ["feedback", "report", "problem", "bug", "idea", "feature", "request", "help"],
      title: "Send feedback to Scient",
      icon: <FeedbackIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        requestFeedback({
          source: "command-palette",
          ...(threadRef === null ? {} : { threadRef }),
        });
      },
    },
  ];
}
