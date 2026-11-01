import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { appWindowForSender, ReadyRenderers } from "./appWindows.ts";

/**
 * App windows listening for OS links. Links go to the most recently focused app window once it
 * listens, so a link never lands in a background window. Without a sender, readiness applies to
 * the current window, and not-ready stops every window listening.
 */
export function makeWebLinkRenderers(
  electronWindow: Pick<
    ElectronWindow.ElectronWindow["Service"],
    "appWindows" | "currentMainOrFirst"
  >,
) {
  const listening = new ReadyRenderers();
  return {
    target: Effect.map(electronWindow.currentMainOrFirst, (window) =>
      listening.pick(Option.toArray(window)),
    ),
    setReady: Effect.fn("DesktopWebLinks.setListening")(function* (
      ready: boolean,
      senderId: number | undefined,
    ) {
      if (!ready && senderId === undefined) return listening.clear();
      const window = yield* senderId === undefined
        ? electronWindow.currentMainOrFirst
        : appWindowForSender(electronWindow, senderId);
      if (Option.isNone(window)) return;
      if (ready) listening.add(window.value);
      else listening.delete(window.value);
    }),
  };
}
