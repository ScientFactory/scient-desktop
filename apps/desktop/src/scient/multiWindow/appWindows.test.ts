import * as NodeEvents from "node:events";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

import type * as ElectronWindow from "../../electron/ElectronWindow.ts";
import {
  appWindowForSender,
  appWindowUrl,
  cascadeWindowBounds,
  parseAppWindowRoute,
  ReadyRenderers,
} from "./appWindows.ts";

// Like Electron, a destroyed window throws on `webContents` before its contents emit `destroyed`.
function fakeWindow(id: number) {
  let destroyed = false;
  const webContents = Object.assign(new NodeEvents.EventEmitter(), {
    id,
    isDestroyed: () => destroyed,
  });
  const window = {
    id,
    isDestroyed: () => destroyed,
    get webContents() {
      if (destroyed) throw new TypeError("Object has been destroyed");
      return webContents;
    },
  };
  return {
    window: window as unknown as Electron.BrowserWindow,
    webContents,
    destroy: () => {
      destroyed = true;
      webContents.emit("destroyed");
    },
  };
}

describe("parseAppWindowRoute", () => {
  it.each([
    [undefined, Option.none()],
    ["", Option.none()],
    [`/${"a".repeat(2_048)}`, Option.none()],
    ["environment/thread", Option.none()],
    ["//evil.example/thread", Option.none()],
    ["/environment/thread#x", Option.none()],
    ["/environment/thread name", Option.none()],
    ["/environment\\thread", Option.none()],
    ["/environment-1/thread-1", Option.some("/environment-1/thread-1")],
  ])("parses %j", (route, expected) => {
    assert.deepEqual(parseAppWindowRoute(route), expected);
  });
});

describe("appWindowUrl", () => {
  it("routes a new window through the hash router without touching the application URL", () => {
    assert.equal(appWindowUrl("scient://app/index.html", Option.none()), "scient://app/index.html");
    assert.equal(
      appWindowUrl("http://127.0.0.1:5733/#/old", Option.some("/environment/thread")),
      "http://127.0.0.1:5733/#/environment/thread",
    );
  });
});

describe("cascadeWindowBounds", () => {
  const primary = { x: 0, y: 25, width: 1_440, height: 875 };
  const secondary = { x: 1_440, y: 0, width: 1_920, height: 1_080 };

  it("offsets the new window within the source window's display", () => {
    assert.deepEqual(
      cascadeWindowBounds({ x: 1_500, y: 40, width: 1_200, height: 800 }, [primary, secondary]),
      { x: 1_528, y: 68, width: 1_200, height: 800 },
    );
  });

  it("wraps to the work area's corner when the offset window would leave it", () => {
    assert.deepEqual(
      cascadeWindowBounds({ x: 200, y: 75, width: 1_200, height: 800 }, [primary, secondary]),
      { x: 0, y: 25, width: 1_200, height: 800 },
    );
  });

  it("offsets without clamping when no display is known", () => {
    assert.deepEqual(cascadeWindowBounds({ x: 10, y: 10, width: 800, height: 600 }, []), {
      x: 38,
      y: 38,
      width: 800,
      height: 600,
    });
  });
});

describe("appWindowForSender", () => {
  it.effect("finds only a live app window owned by the sender", () =>
    Effect.gen(function* () {
      const first = fakeWindow(1);
      const second = fakeWindow(2);
      const service = {
        appWindows: Effect.sync(() =>
          [first.window, second.window].filter((window) => !window.isDestroyed()),
        ),
      } as unknown as ElectronWindow.ElectronWindow["Service"];

      assert.deepEqual(yield* appWindowForSender(service, 2), Option.some(second.window));
      assert.deepEqual(yield* appWindowForSender(service, 3), Option.none());
      assert.deepEqual(yield* appWindowForSender(service, undefined), Option.none());
      second.destroy();
      assert.deepEqual(yield* appWindowForSender(service, 2), Option.none());
    }),
  );
});

describe("ReadyRenderers", () => {
  it("picks the first ready window among the given windows", () => {
    const first = fakeWindow(1);
    const second = fakeWindow(2);
    const third = fakeWindow(3);
    const ready = new ReadyRenderers();
    ready.add(second.window);
    ready.add(third.window);

    assert.deepEqual(
      ready.pick([first.window, third.window, second.window]),
      Option.some(third.window),
    );
    assert.deepEqual(ready.pick([first.window]), Option.none());
  });

  it("forgets a window whose document is replaced or destroyed, and reports it once", () => {
    const onRemove = vi.fn();
    const ready = new ReadyRenderers(onRemove);
    const navigated = fakeWindow(1);
    const destroyed = fakeWindow(2);
    ready.add(navigated.window);
    ready.add(destroyed.window);

    navigated.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    navigated.webContents.emit("did-start-navigation", {
      isMainFrame: false,
      isSameDocument: false,
    });
    assert.equal(ready.size, 2);

    navigated.webContents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
    });
    destroyed.destroy();
    assert.equal(ready.size, 0);
    assert.deepEqual(ready.pick([navigated.window, destroyed.window]), Option.none());
    assert.deepEqual(onRemove.mock.calls, [[navigated.window], [destroyed.window]]);
    assert.equal(navigated.webContents.listenerCount("did-start-navigation"), 0);
    assert.equal(navigated.webContents.listenerCount("render-process-gone"), 0);
  });
});
