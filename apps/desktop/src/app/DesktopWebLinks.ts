import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { WEB_LINK_OPEN_CHANNEL } from "../ipc/channels.ts";
// SCIENT-FORK:START — OS links open in the most recently focused app window once it listens.
import { appWindowForSender, ReadyRenderers } from "../scient/multiWindow/appWindows.ts";
// SCIENT-FORK:END
// SCIENT-FORK:START — compatible routing is dormant until browser activation is authorized.
export const desktopWebLinksEnabled = false;
// SCIENT-FORK:END

/** An http(s) link the operating system handed to Scient as the default browser. */
export const isWebLink = (value: string) => {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === "http:" || protocol === "https:";
};

/** An HTML file the operating system asked Scient to open, as browsers are asked to. */
export const isWebPageFile = (path: string) => /\.x?html?$/i.test(path);

/**
 * OS links can arrive before startup or during renderer reload; queue them until the renderer listens.
 * macOS default-browser files arrive as file:// URLs; Scient prompt/thread schemes work on every platform.
 */
export class DesktopWebLinks extends Context.Service<
  DesktopWebLinks,
  {
    readonly receive: (url: string) => Effect.Effect<void>;
    // SCIENT-FORK:START — OS links open in the most recently focused app window once it listens.
    readonly setRendererReady: (ready: boolean, senderId?: number) => Effect.Effect<void>;
    // SCIENT-FORK:END
  }
>()("@t3tools/desktop/app/DesktopWebLinks") {}

const make = Effect.gen(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const pending: Array<string> = [];
  // SCIENT-FORK:START — OS links open in the most recently focused app window once it listens.
  const listening = new ReadyRenderers();
  const senderWindow = (senderId: number | undefined) =>
    senderId === undefined
      ? electronWindow.currentMainOrFirst
      : appWindowForSender(electronWindow, senderId);

  const flush = Effect.gen(function* () {
    if (listening.size === 0 || pending.length === 0) return;
    const window = listening.pick(Option.toArray(yield* electronWindow.currentMainOrFirst));
    if (Option.isNone(window)) return;
    for (const url of pending.splice(0)) window.value.webContents.send(WEB_LINK_OPEN_CHANNEL, url);
    yield* electronWindow.reveal(window.value);
  });

  const setListening = Effect.fn("DesktopWebLinks.setListening")(function* (
    ready: boolean,
    senderId: number | undefined,
  ) {
    const window = yield* senderWindow(senderId);
    if (Option.isNone(window)) {
      if (!ready && senderId === undefined) listening.clear();
      return;
    }
    if (ready) listening.add(window.value);
    else listening.delete(window.value);
  });
  // SCIENT-FORK:END

  return DesktopWebLinks.of({
    receive: Effect.fn("DesktopWebLinks.receive")(function (url) {
      return Effect.suspend(() => {
        pending.push(url);
        return flush;
      });
    }),
    // SCIENT-FORK:START — OS links open in the most recently focused app window once it listens.
    setRendererReady: Effect.fn("DesktopWebLinks.setRendererReady")(function (ready, senderId) {
      return setListening(ready, senderId);
    }, Effect.andThen(flush)),
    // SCIENT-FORK:END
  });
});

export const layer = Layer.effect(DesktopWebLinks, make);
