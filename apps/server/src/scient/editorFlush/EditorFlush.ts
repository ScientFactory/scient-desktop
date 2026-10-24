/**
 * Saving the open editors of one folder in every window, before a server
 * operation reads that folder from disk (an Overleaf sync, its agent tools,
 * an undo). Text a person typed is only on disk once the window that holds it
 * has saved it, so the server asks every window connected to this
 * environment and waits for each answer.
 *
 * A window answers with the files it saved and every file it could not save,
 * with the reason. A window that does not answer in time, or disconnects
 * first, is a failure that names it, never a success. With no window
 * connected, no editor holds unsaved text: the result says so.
 *
 * @module EditorFlush
 */
import type {
  EditorFlushFileFailure,
  EditorFlushResponse,
  EditorFlushStreamEvent,
  EditorFlushWindow,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

export interface EditorFlushFolderInput {
  /** Absolute path of the checkout. */
  readonly checkoutRoot: string;
  /** Relative to `checkoutRoot` with "/" separators; "" is the whole checkout. */
  readonly folder: string;
  /** How long each window has to answer. */
  readonly timeout: Duration.Input;
}

/** A connected window: its own id, and the connection it answers on. */
export interface EditorFlushWindowRef {
  readonly clientId: string;
  readonly connectionId: string;
}

export type EditorFlushWindowOutcome =
  | {
      readonly _tag: "Saved";
      readonly window: EditorFlushWindowRef;
      /** Files under the folder this window holds, all now saved. */
      readonly saved: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "Failed";
      readonly window: EditorFlushWindowRef;
      readonly saved: ReadonlyArray<string>;
      readonly failures: ReadonlyArray<EditorFlushFileFailure>;
    }
  | {
      readonly _tag: "Unanswered";
      readonly window: EditorFlushWindowRef;
      readonly reason: "timeout" | "disconnected";
    };

export type EditorFlushResult =
  /** No window is connected, so no editor holds unsaved text. */
  | { readonly _tag: "NoWindowOpen" }
  | {
      readonly _tag: "Answered";
      /** Every window answered and saved every editor under the folder. */
      readonly allSaved: boolean;
      readonly windows: ReadonlyArray<EditorFlushWindowOutcome>;
    };

type WindowAnswer =
  | { readonly _tag: "answered"; readonly response: EditorFlushResponse }
  | { readonly _tag: "disconnected" };

interface ConnectedWindow {
  readonly ref: EditorFlushWindowRef;
  readonly queue: Queue.Queue<EditorFlushStreamEvent, Cause.Done>;
  readonly pending: Map<string, Deferred.Deferred<WindowAnswer>>;
}

export class EditorFlush extends Context.Service<
  EditorFlush,
  {
    /** A window's stream of flush requests; ending it disconnects the window. */
    readonly connect: (
      window: EditorFlushWindow,
    ) => Effect.Effect<Stream.Stream<EditorFlushStreamEvent>>;
    /** A window's answer; not accepted when it names no request waiting on that connection. */
    readonly respond: (
      response: EditorFlushResponse,
    ) => Effect.Effect<{ readonly accepted: boolean }>;
    readonly flushFolder: (input: EditorFlushFolderInput) => Effect.Effect<EditorFlushResult>;
  }
>()("t3/scient/editorFlush/EditorFlush") {}

const disconnected: WindowAnswer = { _tag: "disconnected" };

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const windows = new Map<string, ConnectedWindow>();

  /** Ends a window's connection; every request it has not answered fails as disconnected. */
  const drop = (window: ConnectedWindow) => {
    if (windows.get(window.ref.connectionId) === window) windows.delete(window.ref.connectionId);
    for (const deferred of window.pending.values())
      Deferred.doneUnsafe(deferred, Effect.succeed(disconnected));
    window.pending.clear();
    Queue.endUnsafe(window.queue);
  };

  const acquire = Effect.fn("EditorFlush.acquire")(function* (input: EditorFlushWindow) {
    const queue = yield* Queue.unbounded<EditorFlushStreamEvent, Cause.Done>();
    const connectionId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const window: ConnectedWindow = {
      ref: { clientId: input.clientId, connectionId },
      queue,
      pending: new Map(),
    };
    yield* Effect.sync(() => {
      // A window that reconnects replaces its earlier connection.
      for (const previous of windows.values())
        if (previous.ref.clientId === input.clientId) drop(previous);
      windows.set(connectionId, window);
      Queue.offerUnsafe(queue, { type: "connected", connectionId });
    });
    return window;
  });

  const connect: EditorFlush["Service"]["connect"] = (input) =>
    Effect.succeed(
      Stream.unwrap(
        Effect.acquireRelease(acquire(input), (window) => Effect.sync(() => drop(window))).pipe(
          Effect.map((window) => Stream.fromQueue(window.queue)),
        ),
      ),
    );

  const respond: EditorFlush["Service"]["respond"] = (response) =>
    Effect.sync(() => {
      const window = windows.get(response.connectionId);
      const deferred = window?.pending.get(response.requestId);
      if (
        window === undefined ||
        deferred === undefined ||
        window.ref.clientId !== response.clientId
      )
        return { accepted: false };
      window.pending.delete(response.requestId);
      Deferred.doneUnsafe(deferred, Effect.succeed({ _tag: "answered", response }));
      return { accepted: true };
    });

  const outcomeOf = (
    window: EditorFlushWindowRef,
    answer: Option.Option<WindowAnswer>,
  ): EditorFlushWindowOutcome => {
    if (Option.isNone(answer)) return { _tag: "Unanswered", window, reason: "timeout" };
    if (answer.value._tag === "disconnected")
      return { _tag: "Unanswered", window, reason: "disconnected" };
    const { saved, failures } = answer.value.response;
    return failures.length === 0
      ? { _tag: "Saved", window, saved }
      : { _tag: "Failed", window, saved, failures };
  };

  const flushFolder: EditorFlush["Service"]["flushFolder"] = Effect.fn("EditorFlush.flushFolder")(
    function* (input) {
      const requestId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const request = { requestId, checkoutRoot: input.checkoutRoot, folder: input.folder };
      // Registered and sent in one step, so a window that connects or leaves
      // meanwhile is either asked or not, never asked without being awaited.
      const asked = yield* Effect.sync(() =>
        [...windows.values()].map((window) => {
          const deferred = Deferred.makeUnsafe<WindowAnswer>();
          window.pending.set(requestId, deferred);
          Queue.offerUnsafe(window.queue, {
            type: "request",
            connectionId: window.ref.connectionId,
            request,
          });
          return { window, deferred };
        }),
      );
      if (asked.length === 0) return { _tag: "NoWindowOpen" } as const;
      const outcomes = yield* Effect.forEach(
        asked,
        ({ window, deferred }) =>
          Deferred.await(deferred).pipe(
            Effect.timeoutOption(input.timeout),
            Effect.map((answer) => outcomeOf(window.ref, answer)),
          ),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            for (const { window } of asked) window.pending.delete(requestId);
          }),
        ),
      );
      return {
        _tag: "Answered",
        allSaved: outcomes.every((outcome) => outcome._tag === "Saved"),
        windows: outcomes,
      } as const;
    },
  );

  return EditorFlush.of({ connect, respond, flushFolder });
});

export const layer = Layer.effect(EditorFlush, make);
