// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, beforeAll, expect, it } from "@effect/vitest";
import type { EditorFlushRequest, EditorFlushResponse } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { EditorFlush, layer, layerWith } from "./EditorFlush.ts";

const flushLayer = (startupWait: Duration.Input) =>
  layerWith({ retirement: "5 minutes", startupWait }).pipe(Layer.provide(NodeServices.layer));
/** A new service that waits for nobody. */
const NoStartupWait = flushLayer("0 millis");

let base: string;
let checkoutRoot: string;
beforeAll(() => {
  base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "editor-flush-")));
  checkoutRoot = NodePath.join(base, "thesis");
  NodeFS.mkdirSync(NodePath.join(checkoutRoot, "paper"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(checkoutRoot, "paper-old"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(checkoutRoot, "paper", "locked"));
  NodeFS.writeFileSync(NodePath.join(checkoutRoot, "paper", "main.tex"), "A");
  NodeFS.symlinkSync(checkoutRoot, NodePath.join(base, "alias"));
  NodeFS.chmodSync(NodePath.join(checkoutRoot, "paper", "locked"), 0o000);
});
afterAll(() => {
  NodeFS.chmodSync(NodePath.join(checkoutRoot, "paper", "locked"), 0o700);
  NodeFS.rmSync(base, { recursive: true, force: true });
});

const folder = () =>
  ({ checkoutRoot, folder: "paper", timeout: "5 seconds", overallTimeout: "1 minute" }) as const;

type Answer = Pick<EditorFlushResponse, "saved" | "failures">;

interface FakeWindow {
  readonly connectionId: string;
  readonly requests: Array<EditorFlushRequest>;
  /** Completed when the window receives its first request. */
  readonly asked: Deferred.Deferred<EditorFlushRequest>;
  /** Every request, as it arrives. */
  readonly received: Queue.Queue<EditorFlushRequest>;
}

/**
 * A window of `sessionId` that answers each request with `answer`, or never
 * answers when `answer` is undefined. It stays connected for its scope.
 */
const openWindow = Effect.fn("openWindow")(function* (
  sessionId: string,
  clientId: string,
  answer: ((request: EditorFlushRequest) => Answer) | undefined,
): Effect.fn.Return<FakeWindow, never, EditorFlush | Scope.Scope> {
  const flush = yield* EditorFlush;
  const connected = yield* Deferred.make<string>();
  const asked = yield* Deferred.make<EditorFlushRequest>();
  const requests: Array<EditorFlushRequest> = [];
  const received = yield* Queue.unbounded<EditorFlushRequest>();
  const events = yield* flush.connect(sessionId, { clientId });
  yield* Stream.runForEach(events, (event) => {
    if (event.type === "connected") return Deferred.succeed(connected, event.connectionId);
    requests.push(event.request);
    Queue.offerUnsafe(received, event.request);
    const reply =
      answer === undefined
        ? Effect.void
        : flush
            .respond(sessionId, {
              clientId,
              requestId: event.request.requestId,
              ...answer(event.request),
            })
            .pipe(Effect.asVoid);
    return Deferred.succeed(asked, event.request).pipe(Effect.andThen(reply));
  }).pipe(Effect.forkScoped);
  return { connectionId: yield* Deferred.await(connected), requests, asked, received };
});

const savesEverything = (request: EditorFlushRequest): Answer => ({
  saved: [`${request.folder}/main.tex`],
  failures: [],
});
const savesNothing = (): Answer => ({ saved: [], failures: [] });

it.effect("reports plainly that nothing is unsaved when no window is present", () =>
  Effect.gen(function* () {
    const flush = yield* EditorFlush;
    expect(yield* flush.flushFolder(folder())).toEqual({ _tag: "NoWindowOpen" });
  }).pipe(Effect.provide(NoStartupWait)),
);

it.effect("refuses a folder it cannot examine", () =>
  Effect.gen(function* () {
    const flush = yield* EditorFlush;
    yield* openWindow("session", "window-a", savesEverything);
    const result = yield* flush.flushFolder({ ...folder(), folder: "missing" });
    expect(result._tag).toBe("FolderUnavailable");
  }).pipe(Effect.scoped, Effect.provide(NoStartupWait)),
);

it.effect("asks every window and succeeds when all saved", () =>
  Effect.gen(function* () {
    const flush = yield* EditorFlush;
    const first = yield* openWindow("session", "window-a", savesEverything);
    const second = yield* openWindow("session", "window-b", savesNothing);

    const result = yield* flush.flushFolder(folder());

    expect(result).toEqual({
      _tag: "Answered",
      allSaved: true,
      windows: [
        { _tag: "Saved", window: { clientId: "window-a" }, saved: ["paper/main.tex"] },
        { _tag: "Saved", window: { clientId: "window-b" }, saved: [] },
      ],
    });
    for (const window of [first, second])
      expect(window.requests[0]).toMatchObject({ checkoutRoot, folder: "paper" });
  }).pipe(Effect.scoped, Effect.provide(NoStartupWait)),
);

it.effect("names the file and reason when one window cannot save", () =>
  Effect.gen(function* () {
    const flush = yield* EditorFlush;
    yield* openWindow("session", "window-a", savesEverything);
    yield* openWindow("session", "window-b", () => ({
      saved: ["paper/intro.tex"],
      failures: [
        { path: "paper/chapter.tex", reason: "unconverted-input", message: "Not LaTeX yet." },
      ],
    }));

    const result = yield* flush.flushFolder(folder());

    expect(result).toMatchObject({ _tag: "Answered", allSaved: false });
    if (result._tag !== "Answered") return;
    expect(result.windows[1]).toEqual({
      _tag: "Failed",
      window: { clientId: "window-b" },
      saved: ["paper/intro.tex"],
      failures: [
        { path: "paper/chapter.tex", reason: "unconverted-input", message: "Not LaTeX yet." },
      ],
    });
  }).pipe(Effect.scoped, Effect.provide(NoStartupWait)),
);

it.effect("fails, naming the window, when a window does not answer in time", () =>
  Effect.gen(function* () {
    const flush = yield* EditorFlush;
    yield* openWindow("session", "window-a", savesEverything);
    const silent = yield* openWindow("session", "window-silent", undefined);

    const running = yield* flush.flushFolder(folder()).pipe(Effect.forkScoped);
    yield* Deferred.await(silent.asked);
    yield* TestClock.adjust("5 seconds");
    const result = yield* Fiber.join(running);

    expect(result).toMatchObject({ _tag: "Answered", allSaved: false });
    if (result._tag !== "Answered") return;
    expect(result.windows[1]).toEqual({
      _tag: "Unanswered",
      window: { clientId: "window-silent" },
      reason: "timeout",
    });
    // A late answer to a request that already ended is refused.
    const late = yield* flush.respond("session", {
      clientId: "window-silent",
      requestId: silent.requests[0]!.requestId,
      ...savesNothing(),
    });
    expect(late.accepted).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NoStartupWait)),
);

it.effect("asks a window that connects while the request is open, and waits for it", () =>
  Effect.gen(function* () {
    const flush = yield* EditorFlush;
    const first = yield* openWindow("session", "window-a", undefined);
    const running = yield* flush.flushFolder(folder()).pipe(Effect.forkScoped);
    const request = yield* Deferred.await(first.asked);

    const late = yield* openWindow("session", "window-late", () => ({
      saved: [],
      failures: [{ path: "paper/main.tex", reason: "composing", message: "Composing." }],
    }));
    yield* Deferred.await(late.asked);
    yield* flush.respond("session", {
      clientId: "window-a",
      requestId: request.requestId,
      ...savesNothing(),
    });
    const result = yield* Fiber.join(running);

    expect(result).toEqual({
      _tag: "Answered",
      allSaved: false,
      windows: [
        { _tag: "Saved", window: { clientId: "window-a" }, saved: [] },
        {
          _tag: "Failed",
          window: { clientId: "window-late" },
          saved: [],
          failures: [{ path: "paper/main.tex", reason: "composing", message: "Composing." }],
        },
      ],
    });
  }).pipe(Effect.scoped, Effect.provide(NoStartupWait)),
);

it.effect("asks a reconnecting window once it is back, instead of treating it as absent", () =>
  Effect.gen(function* () {
    const flush = yield* EditorFlush;
    // The service is older than its grace, so only the window's own grace keeps it.
    yield* TestClock.adjust("10 seconds");
    const firstConnection = yield* Scope.make();
    yield* openWindow("session", "window-a", undefined).pipe(Scope.provide(firstConnection));
    yield* Scope.close(firstConnection, Exit.void);
    const helper = yield* openWindow("session", "window-helper", savesNothing);

    // Within its grace the window is asked while away; the request reaches it once back.
    const running = yield* flush.flushFolder(folder()).pipe(Effect.forkScoped);
    yield* Deferred.await(helper.asked);
    const back = yield* openWindow("session", "window-a", savesEverything);
    yield* Deferred.await(back.asked);
    expect(yield* Fiber.join(running)).toEqual({
      _tag: "Answered",
      allSaved: true,
      windows: [
        { _tag: "Saved", window: { clientId: "window-a" }, saved: ["paper/main.tex"] },
        { _tag: "Saved", window: { clientId: "window-helper" }, saved: [] },
      ],
    });
  }).pipe(Effect.scoped, Effect.provide(flushLayer("10 seconds"))),
);

it.effect("keeps failing on a window lost without a goodbye until it is retired", () =>
  Effect.gen(function* () {
    const flush = yield* EditorFlush;
    // The service is past its startup wait.
    yield* TestClock.adjust("10 seconds");
    const helper = yield* openWindow("session", "window-helper", savesNothing);
    const connection = yield* Scope.make();
    yield* openWindow("session", "window-a", undefined).pipe(Scope.provide(connection));
    yield* Scope.close(connection, Exit.void);
    const lostWindow = {
      _tag: "Unanswered",
      window: { clientId: "window-a" },
      reason: "disconnected",
    } as const;
    const helperSaved = { _tag: "Saved", window: { clientId: "window-helper" }, saved: [] };

    // Well past any reconnect, the lost window still stops the flush.
    for (const after of ["11 seconds", "4 minutes"] as const) {
      yield* TestClock.adjust(after);
      const running = yield* flush
        .flushFolder({ ...folder(), overallTimeout: "2 seconds" })
        .pipe(Effect.forkScoped);
      yield* Queue.take(helper.received);
      yield* TestClock.adjust("2 seconds");
      expect(yield* Fiber.join(running)).toEqual({
        _tag: "Answered",
        allSaved: false,
        windows: [helperSaved, lostWindow],
      });
    }

    // Retired five minutes after it was lost.
    yield* TestClock.adjust("1 minute");
    expect(yield* flush.flushFolder(folder())).toEqual({
      _tag: "Answered",
      allSaved: true,
      windows: [helperSaved],
    });
    // The production retirement and startup wait.
  }).pipe(Effect.scoped, Effect.provide(layer.pipe(Layer.provide(NodeServices.layer)))),
);

it.effect("forgets a window that says goodbye at once, even while a request awaits it", () =>
  Effect.gen(function* () {
    const flush = yield* EditorFlush;
    const window = yield* openWindow("session", "window-a", undefined);
    const running = yield* flush.flushFolder(folder()).pipe(Effect.forkScoped);
    yield* Deferred.await(window.asked);

    // Another session cannot say goodbye for it.
    expect((yield* flush.leave("session-other", { clientId: "window-a" })).accepted).toBe(false);
    expect((yield* flush.leave("session", { clientId: "window-a" })).accepted).toBe(true);

    expect(yield* Fiber.join(running)).toEqual({ _tag: "NoWindowOpen" });
    expect(yield* flush.flushFolder(folder())).toEqual({ _tag: "NoWindowOpen" });
  }).pipe(Effect.scoped, Effect.provide(NoStartupWait)),
);

it.effect("starts a window's answer time when the request reaches it", () =>
  Effect.gen(function* () {
    const flush = yield* EditorFlush;
    yield* TestClock.adjust("10 seconds");
    const helper = yield* openWindow("session", "window-helper", savesNothing);
    const connection = yield* Scope.make();
    yield* openWindow("session", "window-a", undefined).pipe(Scope.provide(connection));
    yield* Scope.close(connection, Exit.void);

    const running = yield* flush.flushFolder(folder()).pipe(Effect.forkScoped);
    yield* Deferred.await(helper.asked);
    // Back after 4 s of a 5 s answer time: it still has 5 s from now.
    yield* TestClock.adjust("4 seconds");
    const back = yield* openWindow("session", "window-a", undefined);
    const request = yield* Deferred.await(back.asked);
    yield* TestClock.adjust("4 seconds");
    yield* flush.respond("session", {
      clientId: "window-a",
      requestId: request.requestId,
      ...savesNothing(),
    });

    expect(yield* Fiber.join(running)).toMatchObject({ _tag: "Answered", allSaved: true });
  }).pipe(Effect.scoped, Effect.provide(flushLayer("10 seconds"))),
);

it.effect("ends the whole request at its overall deadline", () =>
  Effect.gen(function* () {
    const flush = yield* EditorFlush;
    yield* TestClock.adjust("10 seconds");
    const helper = yield* openWindow("session", "window-helper", savesNothing);
    const connection = yield* Scope.make();
    yield* openWindow("session", "window-a", undefined).pipe(Scope.provide(connection));
    yield* Scope.close(connection, Exit.void);

    const running = yield* flush
      .flushFolder({ ...folder(), overallTimeout: "6 seconds" })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(helper.asked);
    // A window that joins late is asked, but cannot extend the request.
    yield* TestClock.adjust("4 seconds");
    const late = yield* openWindow("session", "window-late", undefined);
    yield* Deferred.await(late.asked);
    yield* TestClock.adjust("2 seconds");

    expect(yield* Fiber.join(running)).toEqual({
      _tag: "Answered",
      allSaved: false,
      windows: [
        { _tag: "Saved", window: { clientId: "window-helper" }, saved: [] },
        { _tag: "Unanswered", window: { clientId: "window-a" }, reason: "disconnected" },
        { _tag: "Unanswered", window: { clientId: "window-late" }, reason: "timeout" },
      ],
    });
  }).pipe(Effect.scoped, Effect.provide(flushLayer("10 seconds"))),
);

it.effect("waits for the first windows of a service that has just started", () =>
  Effect.gen(function* () {
    const flush = yield* EditorFlush;
    const running = yield* flush.flushFolder(folder()).pipe(Effect.forkScoped);
    yield* TestClock.adjust("1 second");
    const window = yield* openWindow("session", "window-a", savesEverything);
    yield* Deferred.await(window.asked);
    expect(yield* Fiber.join(running)).toMatchObject({ _tag: "Answered", allSaved: true });
  }).pipe(Effect.scoped, Effect.provide(flushLayer("10 seconds"))),
);

it.effect("keeps another session from replacing a window or answering for it", () =>
  Effect.gen(function* () {
    const flush = yield* EditorFlush;
    const owner = yield* openWindow("session-owner", "window-a", undefined);
    // Another session claims the same window id: it is another window, asked on its own.
    const intruder = yield* openWindow("session-intruder", "window-a", undefined);
    const running = yield* flush.flushFolder(folder()).pipe(Effect.forkScoped);
    const request = yield* Deferred.await(owner.asked);
    yield* Deferred.await(intruder.asked);
    const answer = (sessionId: string, failures: EditorFlushResponse["failures"]) =>
      flush.respond(sessionId, {
        clientId: "window-a",
        requestId: request.requestId,
        saved: [],
        failures,
      });

    expect((yield* answer("session-nobody", [])).accepted).toBe(false);
    const peek = yield* flush.resolve("session-nobody", {
      clientId: "window-a",
      requestId: request.requestId,
      files: [{ cwd: checkoutRoot, relativePath: "paper/main.tex" }],
    });
    expect(peek.files).toEqual([{ status: "unknown" }]);
    // The intruder's answer settles only its own window, never the owner's.
    expect((yield* answer("session-intruder", [])).accepted).toBe(true);
    expect((yield* answer("session-intruder", [])).accepted).toBe(false);
    const failure = {
      path: "paper/main.tex",
      reason: "save-failed",
      message: "Disk full.",
    } as const;
    expect((yield* answer("session-owner", [failure])).accepted).toBe(true);

    expect(yield* Fiber.join(running)).toEqual({
      _tag: "Answered",
      allSaved: false,
      windows: [
        { _tag: "Failed", window: { clientId: "window-a" }, saved: [], failures: [failure] },
        { _tag: "Saved", window: { clientId: "window-a" }, saved: [] },
      ],
    });
  }).pipe(Effect.scoped, Effect.provide(NoStartupWait)),
);

it.effect("locates files by physical identity, whatever path spelling an editor uses", () =>
  Effect.gen(function* () {
    const flush = yield* EditorFlush;
    const window = yield* openWindow("session", "window-a", undefined);
    const running = yield* flush.flushFolder(folder()).pipe(Effect.forkScoped);
    const request = yield* Deferred.await(window.asked);
    const upper = checkoutRoot.replace(/thesis$/u, "THESIS");
    const caseInsensitive = NodeFS.existsSync(upper);

    const located = yield* flush.resolve("session", {
      clientId: "window-a",
      requestId: request.requestId,
      files: [
        { cwd: checkoutRoot, relativePath: "paper/main.tex" },
        { cwd: NodePath.join(base, "alias"), relativePath: "paper/main.tex" },
        { cwd: NodePath.join(base, "alias", "paper"), relativePath: "sub/new.tex" },
        { cwd: checkoutRoot, relativePath: "paper-old/main.tex" },
        { cwd: checkoutRoot, relativePath: "paper/../paper-old/main.tex" },
        { cwd: upper, relativePath: "paper/main.tex" },
        { cwd: checkoutRoot, relativePath: "paper/locked/hidden.tex" },
      ],
    });

    expect(located.files).toEqual([
      { status: "inside", path: "paper/main.tex" },
      { status: "inside", path: "paper/main.tex" },
      { status: "inside", path: "paper/sub/new.tex" },
      { status: "outside" },
      { status: "outside" },
      caseInsensitive ? { status: "inside", path: "paper/main.tex" } : { status: "outside" },
      { status: "unknown" },
    ]);
    yield* flush.respond("session", {
      clientId: "window-a",
      requestId: request.requestId,
      ...savesNothing(),
    });
    yield* Fiber.join(running);
  }).pipe(Effect.scoped, Effect.provide(NoStartupWait)),
);
