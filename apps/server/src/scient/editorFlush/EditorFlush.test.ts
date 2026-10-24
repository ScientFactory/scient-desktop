import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { EditorFlushRequest, EditorFlushResponse } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { EditorFlush, layer } from "./EditorFlush.ts";

const TestLayer = layer.pipe(Layer.provide(NodeServices.layer));

type Answer = Pick<EditorFlushResponse, "saved" | "failures">;

interface FakeWindow {
  readonly connectionId: string;
  readonly requests: Array<EditorFlushRequest>;
  /** Completed when the window receives its first request. */
  readonly asked: Deferred.Deferred<EditorFlushRequest>;
}

/**
 * A window that connects and answers each request with `answer`, or never
 * answers when `answer` is undefined. It stays connected for the test's scope.
 */
const openWindow = Effect.fn("openWindow")(function* (
  clientId: string,
  answer: ((request: EditorFlushRequest) => Answer) | undefined,
): Effect.fn.Return<FakeWindow, never, EditorFlush | Scope.Scope> {
  const flush = yield* EditorFlush;
  const connected = yield* Deferred.make<string>();
  const asked = yield* Deferred.make<EditorFlushRequest>();
  const requests: Array<EditorFlushRequest> = [];
  const events = yield* flush.connect({ clientId });
  yield* Stream.runForEach(events, (event) => {
    if (event.type === "connected") return Deferred.succeed(connected, event.connectionId);
    requests.push(event.request);
    const reply =
      answer === undefined
        ? Effect.void
        : flush
            .respond({
              clientId,
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ...answer(event.request),
            })
            .pipe(Effect.asVoid);
    return Deferred.succeed(asked, event.request).pipe(Effect.andThen(reply));
  }).pipe(Effect.forkScoped);
  return { connectionId: yield* Deferred.await(connected), requests, asked };
});

const savesEverything = (request: EditorFlushRequest): Answer => ({
  saved: [`${request.folder}/main.tex`],
  failures: [],
});

const folder = { checkoutRoot: "/work/thesis", folder: "paper", timeout: "5 seconds" } as const;

it.effect("reports plainly that nothing is unsaved when no window is connected", () =>
  Effect.gen(function* () {
    const flush = yield* EditorFlush;
    expect(yield* flush.flushFolder(folder)).toEqual({ _tag: "NoWindowOpen" });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("asks every connected window for the folder and succeeds when all saved", () =>
  Effect.gen(function* () {
    const flush = yield* EditorFlush;
    const first = yield* openWindow("window-a", savesEverything);
    const second = yield* openWindow("window-b", () => ({ saved: [], failures: [] }));

    const result = yield* flush.flushFolder(folder);

    expect(result).toEqual({
      _tag: "Answered",
      allSaved: true,
      windows: [
        {
          _tag: "Saved",
          window: { clientId: "window-a", connectionId: first.connectionId },
          saved: ["paper/main.tex"],
        },
        {
          _tag: "Saved",
          window: { clientId: "window-b", connectionId: second.connectionId },
          saved: [],
        },
      ],
    });
    for (const window of [first, second]) {
      expect(window.requests).toHaveLength(1);
      expect(window.requests[0]).toMatchObject({ checkoutRoot: "/work/thesis", folder: "paper" });
    }
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("names the file and reason when one window cannot save", () =>
  Effect.gen(function* () {
    const flush = yield* EditorFlush;
    yield* openWindow("window-a", savesEverything);
    const failing = yield* openWindow("window-b", () => ({
      saved: ["paper/intro.tex"],
      failures: [
        {
          path: "paper/chapter.tex",
          reason: "unconverted-input",
          message: "This text could not be converted to LaTeX.",
        },
      ],
    }));

    const result = yield* flush.flushFolder(folder);

    expect(result._tag).toBe("Answered");
    if (result._tag !== "Answered") return;
    expect(result.allSaved).toBe(false);
    expect(result.windows[1]).toEqual({
      _tag: "Failed",
      window: { clientId: "window-b", connectionId: failing.connectionId },
      saved: ["paper/intro.tex"],
      failures: [
        {
          path: "paper/chapter.tex",
          reason: "unconverted-input",
          message: "This text could not be converted to LaTeX.",
        },
      ],
    });
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("fails, naming the window, when a window does not answer in time", () =>
  Effect.gen(function* () {
    const flush = yield* EditorFlush;
    yield* openWindow("window-a", savesEverything);
    const silent = yield* openWindow("window-silent", undefined);

    const running = yield* flush.flushFolder(folder).pipe(Effect.forkScoped);
    yield* Deferred.await(silent.asked);
    yield* TestClock.adjust("5 seconds");
    const result = yield* Fiber.join(running);

    expect(result._tag).toBe("Answered");
    if (result._tag !== "Answered") return;
    expect(result.allSaved).toBe(false);
    expect(result.windows.map((window) => window._tag)).toEqual(["Saved", "Unanswered"]);
    expect(result.windows[1]).toEqual({
      _tag: "Unanswered",
      window: { clientId: "window-silent", connectionId: silent.connectionId },
      reason: "timeout",
    });
    // A late answer to a request that already ended is refused.
    const late = yield* flush.respond({
      clientId: "window-silent",
      connectionId: silent.connectionId,
      requestId: silent.requests[0]!.requestId,
      saved: [],
      failures: [],
    });
    expect(late.accepted).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("fails a window that disconnects before answering", () =>
  Effect.gen(function* () {
    const flush = yield* EditorFlush;
    const windowScope = yield* Scope.make();
    const leaving = yield* openWindow("window-leaving", undefined).pipe(Scope.provide(windowScope));

    const running = yield* flush.flushFolder(folder).pipe(Effect.forkScoped);
    yield* Deferred.await(leaving.asked);
    yield* Scope.close(windowScope, Exit.void);
    const result = yield* Fiber.join(running);

    expect(result).toEqual({
      _tag: "Answered",
      allSaved: false,
      windows: [
        {
          _tag: "Unanswered",
          window: { clientId: "window-leaving", connectionId: leaving.connectionId },
          reason: "disconnected",
        },
      ],
    });
    // The window is gone: a later flush has no window to ask.
    expect(yield* flush.flushFolder(folder)).toEqual({ _tag: "NoWindowOpen" });
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("replaces a window's earlier connection when it reconnects", () =>
  Effect.gen(function* () {
    const flush = yield* EditorFlush;
    const stale = yield* openWindow("window-a", undefined);
    const running = yield* flush.flushFolder(folder).pipe(Effect.forkScoped);
    yield* Deferred.await(stale.asked);

    const fresh = yield* openWindow("window-a", savesEverything);
    const interrupted = yield* Fiber.join(running);
    const next = yield* flush.flushFolder(folder);

    expect(interrupted).toMatchObject({
      allSaved: false,
      windows: [{ _tag: "Unanswered", reason: "disconnected" }],
    });
    expect(next).toEqual({
      _tag: "Answered",
      allSaved: true,
      windows: [
        {
          _tag: "Saved",
          window: { clientId: "window-a", connectionId: fresh.connectionId },
          saved: ["paper/main.tex"],
        },
      ],
    });
    expect(stale.requests).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("refuses an answer from another window or for an unknown request", () =>
  Effect.gen(function* () {
    const flush = yield* EditorFlush;
    const silent = yield* openWindow("window-silent", undefined);
    const running = yield* flush.flushFolder(folder).pipe(Effect.forkScoped);
    const request = yield* Deferred.await(silent.asked);

    const fromAnother = yield* flush.respond({
      clientId: "window-other",
      connectionId: silent.connectionId,
      requestId: request.requestId,
      saved: [],
      failures: [],
    });
    const unknown = yield* flush.respond({
      clientId: "window-silent",
      connectionId: silent.connectionId,
      requestId: "no-such-request",
      saved: [],
      failures: [],
    });
    expect(fromAnother.accepted).toBe(false);
    expect(unknown.accepted).toBe(false);

    const accepted = yield* flush.respond({
      clientId: "window-silent",
      connectionId: silent.connectionId,
      requestId: request.requestId,
      saved: [],
      failures: [],
    });
    expect(accepted.accepted).toBe(true);
    const result = yield* Fiber.join(running);
    expect(result).toMatchObject({ _tag: "Answered", allSaved: true });
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);
