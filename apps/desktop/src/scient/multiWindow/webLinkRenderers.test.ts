// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron webContents.
import { assert, it } from "@effect/vitest";
import * as NodeEvents from "node:events";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Electron from "electron";

import type * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { makeWebLinkRenderers } from "./webLinkRenderers.ts";

const fakeWindow = (id: number) =>
  ({
    webContents: Object.assign(new NodeEvents.EventEmitter(), { id, isDestroyed: () => false }),
  }) as unknown as Electron.BrowserWindow;

it.effect("holds links for the focused window until that window's own renderer listens", () =>
  Effect.gen(function* () {
    const focused = fakeWindow(1);
    const background = fakeWindow(2);
    const renderers = makeWebLinkRenderers({
      appWindows: Effect.succeed([focused, background]),
      currentMainOrFirst: Effect.succeedSome(focused),
    } satisfies Pick<
      ElectronWindow.ElectronWindow["Service"],
      "appWindows" | "currentMainOrFirst"
    >);

    yield* renderers.setReady(true, 2);
    assert.isTrue(Option.isNone(yield* renderers.target));

    yield* renderers.setReady(true, 1);
    assert.strictEqual(Option.getOrThrow(yield* renderers.target), focused);
  }),
);
