// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron debugger.
import { describe, expect, it } from "@effect/vitest";
import { DesktopBrowserEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeEvents from "node:events";

import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopBrowserEvent));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeCdpReply = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Number })),
);
const key = { threadId: "thread-1", tabId: "tab-1" };

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

const takeEvents = (
  host: DesktopBrowserHost.DesktopBrowserHost["Service"],
  count: number,
  onEvent: (event: DesktopBrowserEvent) => Effect.Effect<unknown> = () => Effect.void,
) =>
  host.events.pipe(
    Stream.map((line) => decodeEvent(new TextDecoder().decode(line))),
    Stream.tap(onEvent),
    Stream.take(count),
    Stream.runCollect,
  );

describe("DesktopBrowserHost", () => {
  it.effect("announces tabs already attached to a backend that starts later", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      host.attach(key, makeDebuggee().tab);

      expect(yield* takeEvents(host, 1)).toEqual([{ type: "attached", ...key }]);
      expect(yield* takeEvents(host, 1)).toEqual([{ type: "attached", ...key }]);
    }),
  );

  it.effect("drops replies from a relay the server released", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const attached = yield* Deferred.make<void>();
      const reader = yield* takeEvents(host, 2, (event) =>
        event.type === "attached" ? Deferred.succeed(attached, undefined) : Effect.void,
      ).pipe(Effect.forkScoped);

      yield* Deferred.await(attached);
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
      const [, reply] = yield* Fiber.join(reader);

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
      const attached = yield* Deferred.make<void>();
      const configured = Promise.withResolvers<void>();
      const inputsCompleted = Promise.withResolvers<void>();
      const inputReplyIds = new Set<number>();
      const reader = yield* takeEvents(host, 4, (event) => {
        if (event.type === "attached") return Deferred.succeed(attached, undefined);
        if (event.type === "cdp")
          return Effect.sync(() => {
            const id = decodeCdpReply(event.message).id;
            if (id === 1) configured.resolve();
            if (id === 2 || id === 3) inputReplyIds.add(id);
            if (inputReplyIds.size === 2) inputsCompleted.resolve();
          });
        return Effect.void;
      }).pipe(Effect.forkScoped);
      // Subscribing announces the tab and resets its relay; finish that before sending commands.
      yield* Deferred.await(attached);
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
      yield* Effect.promise(() => configured.promise);

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
      // Reply publication precedes CdpRelay's synchronous onComplete. The reply's
      // Promise receipt resumes after that callback, when input permission is restored.
      yield* Effect.promise(() => inputsCompleted.promise);
      const events = yield* Fiber.join(reader);
      expect(
        events
          .filter((event) => event.type === "cdp")
          .map((event) => decodeCdpReply(event.message).id)
          .toSorted(),
      ).toEqual([1, 2, 3]);
      expect(host.canReportHumanInput(webContents, "pointer")).toBe(true);
      expect(host.canReportHumanInput(webContents, "key")).toBe(true);

      host.noteHumanInput(webContents);
      debuggee.emit("Browser.downloadWillBegin", { guid: "human-download" });
      expect(host.pendingDownloadWasHuman(webContents)).toBe(true);
    }).pipe(Effect.scoped),
  );
});
