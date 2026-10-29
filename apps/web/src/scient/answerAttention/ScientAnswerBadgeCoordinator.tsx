import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useNowMinute } from "../../hooks/useNowMinute";
import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import {
  useAllEnvironmentShellsBootstrapped,
  useDelegatedUnderParent,
  useThreadShells,
} from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { useUiStateStore } from "../../uiStateStore";
import { countUnreadConversations, environmentCatalogComplete } from "./unreadConversations";

/** Per device; on unless turned off in Settings. */
export const APP_BADGE_ENABLED_KEY = "scient:app-badge:enabled";

/** One owner above routes: the desktop app icon counts the sidebar's unread threads. */
export function ScientAnswerBadgeCoordinator() {
  return window.desktopBridge?.setUnreadAnswerBadge ? <UnreadAnswerBadge /> : null;
}

function UnreadAnswerBadge() {
  const [enabled] = useLocalStorage(APP_BADGE_ENABLED_KEY, true, Schema.Boolean);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const shellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const threads = useThreadShells();
  const localVisits = useUiStateStore((state) => state.threadLastVisitedAtById);
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const delegatedUnderParent = useDelegatedUnderParent();
  // Snoozes end on their own; a minute late is fine for a badge. The clock omits its UTC zone.
  const now = `${useNowMinute()}:00.000Z`;
  // Until every environment is known and has its threads, the badge keeps its last value.
  const ready =
    environmentCatalogComplete(catalog, isLocalEnvironmentDisabled()) && shellsBootstrapped;
  const count = !enabled
    ? 0
    : ready
      ? countUnreadConversations({ threads, localVisits, serverConfigs, now, delegatedUnderParent })
      : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the count to the OS app badge through the desktop bridge
  useEffect(() => {
    const bridge = window.desktopBridge;
    const setBadge = bridge?.setUnreadAnswerBadge;
    if (!setBadge || count === null) return;
    const image = bridge.getClientPlatform?.() === "win32" ? taskbarOverlay(count) : null;
    const update = () => {
      void setBadge({ count, image }).catch((error: unknown) => {
        console.warn("Could not update the unread-answer badge", error);
      });
    };
    update();
    // Reapply after a user changes the OS badge permission while Scient is open.
    window.addEventListener("focus", update);
    return () => window.removeEventListener("focus", update);
  }, [count]);
  return null;
}

/** Windows shows a count only as an image over the taskbar button. */
function taskbarOverlay(count: number): string | null {
  if (count === 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = "#e5484d";
  context.beginPath();
  context.arc(32, 32, 28, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "white";
  context.font = `600 ${count > 9 ? 30 : 40}px "Segoe UI", sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(count > 9 ? "9+" : String(count), 32, 34);
  return canvas.toDataURL("image/png");
}
