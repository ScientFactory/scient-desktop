// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron debugger.
import { describe, expect, it } from "@effect/vitest";
import { DesktopBrowserEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeEvents from "node:events";
import { vi } from "vite-plus/test";

import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopBrowserEvent));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeCdpReply = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Number })),
);
const key = { threadId: "thread-1", tabId: "tab-1" };

/** A tab's webContents and debugger, with the debugger's commands left pending until released. */
const makeDebuggee = () => {
  const emitter = new NodeEvents.EventEmitter();
  const pending: Array<() => void> = [];
  const debuggee = Object.assign(emitter, {
    sendCommand: (method: string) =>
      new Promise((resolve) => {
        if (method === "Target.getTargetInfo") {
          resolve({ targetInfo: { targetId: "GUEST" } });
          return;
        }
        pending.push(() => resolve({ method }));
      }),
  });
  const webContents = {
    getURL: () => "http://localhost/",
    getTitle: () => "Page",
    getUserAgent: () => "Electron",
  };
  return {
    tab: {
      webContents: webContents as unknown as Electron.WebContents,
      debugger: debuggee as unknown as Electron.Debugger,
    },
    emit: (method: string, params: unknown) => emitter.emit("message", {}, method, params, ""),
    release: () => pending.splice(0).forEach((resolve) => resolve()),
  };
};

/** Reads `count` events from one backend's subscription. */
const takeEvents = (host: DesktopBrowserHost.DesktopBrowserHost["Service"], count: number) =>
  host.events.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map((lines) => lines.map((line) => decodeEvent(new TextDecoder().decode(line)))),
  );

describe("DesktopBrowserHost", () => {
  it.effect("announces tabs already attached to a backend that starts later", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      host.attach(key, makeDebuggee().tab);
      // A restarted backend subscribes after the attach and still hears it.
      expect(yield* takeEvents(host, 1)).toEqual([{ type: "attached", ...key }]);
      expect(yield* takeEvents(host, 1)).toEqual([{ type: "attached", ...key }]);
    }),
  );

  it.effect("drops replies from a relay the server released", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const reader = yield* takeEvents(host, 2).pipe(Effect.forkScoped);
      // Wait until the reader has received the announcement.
      yield* Effect.yieldNow;
      const command = (id: number, method: string) =>
        host.handleCommandLine(
          encodeJson({
            type: "cdp",
            ...key,
            message: encodeJson({ id, method, sessionId: "t3-preview-page" }),
          }),
        );
      yield* command(1, "Page.captureScreenshot");
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* command(2, "DOM.enable");
      debuggee.release();
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
      const [, reply] = yield* Fiber.join(reader);
      // Only the new connection's reply arrives; the old one's id could collide.
      expect(reply).toMatchObject({ type: "cdp" });
      expect(decodeCdpReply((reply as { message: string }).message).id).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("saves a server tab's download under its CDP guid where the server asked", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const paths: Array<string> = [];
      const item = {
        setSavePath: (path: string) => void paths.push(path),
      } as unknown as Electron.DownloadItem;
      // Before the server sets a directory, Electron keeps its own handling.
      expect(host.placeDownload(debuggee.tab.webContents, item)).toBe(false);
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({
            id: 1,
            method: "Browser.setDownloadBehavior",
            params: { behavior: "allowAndName", downloadPath: "/srv/downloads" },
          }),
        }),
      );
      debuggee.emit("Browser.downloadWillBegin", { guid: "guid-1", suggestedFilename: "r.csv" });
      expect(host.placeDownload(debuggee.tab.webContents, item)).toBe(true);
      expect(paths).toEqual(["/srv/downloads/guid-1"]);
    }),
  );

  it.effect("attributes only the next download to explicit human input", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({
            id: 1,
            method: "Input.dispatchMouseEvent",
            params: { type: "mousePressed", x: 1, y: 1 },
          }),
        }),
      );
      debuggee.emit("Browser.downloadWillBegin", { guid: "agent-download" });
      expect(host.pendingDownloadWasHuman(debuggee.tab.webContents)).toBe(false);

      host.noteHumanInput(debuggee.tab.webContents);
      debuggee.emit("Browser.downloadWillBegin", { guid: "human-download" });
      expect(host.pendingDownloadWasHuman(debuggee.tab.webContents)).toBe(true);

      debuggee.emit("Browser.downloadWillBegin", { guid: "unattributed-download" });
      expect(host.pendingDownloadWasHuman(debuggee.tab.webContents)).toBe(false);

      host.noteHumanInput(debuggee.tab.webContents);
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: JSON.stringify(
            {
              id: 2,
              method: "Runtime.evaluate",
              params: { expression: "downloadReport()" },
            },
            null,
            2,
          ),
        }),
      );
      debuggee.emit("Browser.downloadWillBegin", { guid: "delayed-agent-download" });
      expect(host.pendingDownloadWasHuman(debuggee.tab.webContents)).toBe(false);
    }),
  );

  it.effect("blocks CDP pointer events from the preload human-input and Downloads path", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      const webContents = debuggee.tab.webContents;
      host.attach(key, debuggee.tab);
      const encodeCommand = (message: unknown) =>
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson(message),
        });
      yield* host.handleCommandLine(
        encodeCommand({
          id: 1,
          method: "Browser.setDownloadBehavior",
          params: { behavior: "allowAndName", downloadPath: "/srv/downloads" },
        }),
      );
      debuggee.release();
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));

      yield* host.handleCommandLine(
        encodeCommand({
          id: 2,
          method: "Input.dispatchMouseEvent",
          params: { type: "mousePressed", x: 10, y: 20, button: "left" },
          sessionId: "t3-preview-page",
        }),
      );
      yield* host.handleCommandLine(
        encodeCommand({
          id: 3,
          method: "Input.dispatchKeyEvent",
          params: { type: "keyDown", key: "Enter", code: "Enter" },
          sessionId: "t3-preview-page",
        }),
      );
      // The preload's synchronous permission check rejects this trusted DOM
      // event while the matching agent CDP command is still dispatching.
      expect(host.canReportHumanInput(webContents, "pointer")).toBe(false);
      expect(host.canReportHumanInput(webContents, "key")).toBe(false);

      const paths: Array<string> = [];
      const item = {
        setSavePath: (path: string) => void paths.push(path),
      } as unknown as Electron.DownloadItem;
      debuggee.emit("Browser.downloadWillBegin", { guid: "agent-download" });
      expect(host.pendingDownloadWasHuman(webContents)).toBe(false);
      expect(host.placeDownload(webContents, item)).toBe(true);
      expect(paths).toEqual(["/srv/downloads/agent-download"]);

      debuggee.release();
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
      expect(host.canReportHumanInput(webContents, "pointer")).toBe(true);

      host.noteHumanInput(webContents);
      debuggee.emit("Browser.downloadWillBegin", { guid: "human-download" });
      expect(host.pendingDownloadWasHuman(webContents)).toBe(true);
    }),
  );
});
