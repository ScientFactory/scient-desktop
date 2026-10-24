/**
 * Saving the open editors of one folder in every window, before a server
 * operation reads that folder from disk (an Overleaf sync, its agent tools,
 * an undo). Text a person typed is only on disk once the window that holds it
 * has saved it, so the server asks every window of this environment and
 * waits for each answer.
 *
 * A window is known by the authenticated session that registered it and the
 * id it chose; another session can neither replace it nor answer for it. A
 * window stays a member of the environment for a grace period after its
 * connection drops, so a reconnecting window is asked (again, once back) and
 * counts as unanswered, never as absent. A window that registers while a
 * request is open is asked too, and the request waits for it.
 *
 * Each window asks the server which of its editors' files are in the folder
 * (`resolve`); the server compares physical identity, so any spelling of a
 * path is found. A window answers with the files it saved and every file it
 * could not save, with the reason. A window that does not answer in time is a
 * failure that names it. With no window present, no editor holds unsaved
 * text: the result says so.
 *
 * @module EditorFlush
 */
import type {
  EditorFlushFileFailure,
  EditorFlushRequest,
  EditorFlushResolveInput,
  EditorFlushResolveResult,
  EditorFlushResponse,
  EditorFlushStreamEvent,
  EditorFlushWindow,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { identifyFolder, locateFile, type FolderIdentity } from "./folderIdentity.ts";

export interface EditorFlushFolderInput {
  /** Absolute path of the checkout. */
  readonly checkoutRoot: string;
  /** Relative to `checkoutRoot` with "/" separators; "" is the whole checkout. */
  readonly folder: string;
  /** How long each window has to answer from when it is asked. */
  readonly timeout: Duration.Input;
}

/** A window, by the id it chose. */
export interface EditorFlushWindowRef {
  readonly clientId: string;
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
      /** `disconnected`: its connection was down when time ran out, or it left for good. */
      readonly reason: "timeout" | "disconnected";
    };

export type EditorFlushResult =
  /** No window is present, so no editor holds unsaved text. */
  | { readonly _tag: "NoWindowOpen" }
  /** The folder could not be examined, so no window could be asked about it. */
  | { readonly _tag: "FolderUnavailable"; readonly message: string }
  | {
      readonly _tag: "Answered";
      /** Every window answered and saved every editor under the folder. */
      readonly allSaved: boolean;
      readonly windows: ReadonlyArray<EditorFlushWindowOutcome>;
    };

export interface EditorFlushOptions {
  /**
   * How long a window whose connection dropped is still counted as present
   * (and, while the service is this young, how long a flush waits for the
   * first window to connect).
   */
  readonly presenceGrace: Duration.Input;
}

type Answer =
  | { readonly _tag: "answered"; readonly response: EditorFlushResponse }
  | { readonly _tag: "gone" };

interface Presence {
  readonly key: string;
  readonly ref: EditorFlushWindowRef;
  connection: {
    readonly connectionId: string;
    readonly queue: Queue.Queue<EditorFlushStreamEvent, Cause.Done>;
  } | null;
  /** Advances on every disconnect, so only the latest one's grace can remove it. */
  generation: number;
}

interface Member {
  readonly presence: Presence;
  readonly deadline: number;
  answer: Answer | null;
  /** Completed with the answer. */
  readonly answered: Deferred.Deferred<void>;
}

interface Registration {
  readonly presence: Presence;
  readonly connection: NonNullable<Presence["connection"]>;
}

interface OpenRequest {
  readonly request: EditorFlushRequest;
  readonly identity: FolderIdentity;
  readonly timeoutMillis: number;
  readonly members: Map<string, Member>;
  /** Completed (and replaced) whenever a member joins. */
  joined: Deferred.Deferred<void>;
}

export class EditorFlush extends Context.Service<
  EditorFlush,
  {
    /** A window's stream of flush requests, for the session that authenticated it. */
    readonly connect: (
      sessionId: string,
      window: EditorFlushWindow,
    ) => Effect.Effect<Stream.Stream<EditorFlushStreamEvent>>;
    /** Where a member window's editor files are; all unknown for anyone else. */
    readonly resolve: (
      sessionId: string,
      input: EditorFlushResolveInput,
    ) => Effect.Effect<EditorFlushResolveResult>;
    /** A member window's answer; refused for anyone else, or once answered. */
    readonly respond: (
      sessionId: string,
      response: EditorFlushResponse,
    ) => Effect.Effect<{ readonly accepted: boolean }>;
    readonly flushFolder: (input: EditorFlushFolderInput) => Effect.Effect<EditorFlushResult>;
  }
>()("t3/scient/editorFlush/EditorFlush") {}

const windowKey = (sessionId: string, clientId: string) => `${sessionId}\0${clientId}`;

const make = Effect.fn("EditorFlush.make")(function* (options: EditorFlushOptions) {
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Effect.scope;
  const graceMillis = Duration.toMillis(options.presenceGrace);
  const startedAt = yield* Clock.currentTimeMillis;
  const presences = new Map<string, Presence>();
  const open = new Map<string, OpenRequest>();

  const send = (presence: Presence, request: EditorFlushRequest) => {
    if (presence.connection === null) return;
    Queue.offerUnsafe(presence.connection.queue, {
      type: "request",
      connectionId: presence.connection.connectionId,
      request,
    });
  };

  /** Asks a window, unless it is already asked; the request then waits for it. */
  const join = (request: OpenRequest, presence: Presence, now: number) => {
    if (request.members.has(presence.key)) return;
    request.members.set(presence.key, {
      presence,
      deadline: now + request.timeoutMillis,
      answer: null,
      answered: Deferred.makeUnsafe<void>(),
    });
    send(presence, request.request);
    const joined = request.joined;
    request.joined = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(joined, Effect.void);
  };

  const settle = (member: Member, answer: Answer) => {
    if (member.answer !== null) return false;
    member.answer = answer;
    Deferred.doneUnsafe(member.answered, Effect.void);
    return true;
  };

  const acquire = Effect.fn("EditorFlush.acquire")(function* (
    sessionId: string,
    input: EditorFlushWindow,
  ) {
    const queue = yield* Queue.unbounded<EditorFlushStreamEvent, Cause.Done>();
    const connectionId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const now = yield* Clock.currentTimeMillis;
    return yield* Effect.sync((): Registration => {
      const key = windowKey(sessionId, input.clientId);
      let presence = presences.get(key);
      if (presence === undefined) {
        presence = { key, ref: { clientId: input.clientId }, connection: null, generation: 0 };
        presences.set(key, presence);
      }
      // The same window reconnecting replaces its earlier connection.
      if (presence.connection !== null) Queue.endUnsafe(presence.connection.queue);
      const connection = { connectionId, queue };
      presence.connection = connection;
      Queue.offerUnsafe(queue, { type: "connected", connectionId });
      for (const request of open.values()) {
        const member = request.members.get(key);
        if (member === undefined) join(request, presence, now);
        else if (member.answer === null) send(presence, request.request);
      }
      return { presence, connection };
    });
  });

  /** Gone for good: every request still waiting on it stops waiting. */
  const remove = (presence: Presence, generation: number) =>
    Effect.sync(() => {
      if (presence.connection !== null || presence.generation !== generation) return;
      if (presences.get(presence.key) === presence) presences.delete(presence.key);
      for (const request of open.values()) {
        const member = request.members.get(presence.key);
        if (member !== undefined) settle(member, { _tag: "gone" });
      }
    });

  const release = ({ presence, connection }: Registration) =>
    Effect.suspend(() => {
      Queue.endUnsafe(connection.queue);
      if (presence.connection !== connection) return Effect.void;
      presence.connection = null;
      const generation = ++presence.generation;
      return Effect.sleep(graceMillis).pipe(
        Effect.andThen(remove(presence, generation)),
        Effect.forkIn(scope),
        Effect.asVoid,
      );
    });

  const connect: EditorFlush["Service"]["connect"] = (sessionId, input) =>
    Effect.succeed(
      Stream.unwrap(
        Effect.acquireRelease(acquire(sessionId, input), release).pipe(
          Effect.map(({ connection }) => Stream.fromQueue(connection.queue)),
        ),
      ),
    );

  const memberOf = (sessionId: string, clientId: string, requestId: string) =>
    open.get(requestId)?.members.get(windowKey(sessionId, clientId));

  const resolve: EditorFlush["Service"]["resolve"] = Effect.fn("EditorFlush.resolve")(
    function* (sessionId, input) {
      const request = open.get(input.requestId);
      if (
        request === undefined ||
        memberOf(sessionId, input.clientId, input.requestId) === undefined
      )
        return { files: input.files.map(() => ({ status: "unknown" as const })) };
      const files = yield* Effect.forEach(
        input.files,
        (file) => Effect.promise(() => locateFile(request.identity, file.cwd, file.relativePath)),
        { concurrency: 16 },
      );
      return { files };
    },
  );

  const respond: EditorFlush["Service"]["respond"] = (sessionId, response) =>
    Effect.sync(() => {
      const member = memberOf(sessionId, response.clientId, response.requestId);
      return {
        accepted: member !== undefined && settle(member, { _tag: "answered", response }),
      };
    });

  const outcomeOf = (member: Member): EditorFlushWindowOutcome => {
    const window = member.presence.ref;
    const answer = member.answer;
    if (answer === null)
      return {
        _tag: "Unanswered",
        window,
        reason: member.presence.connection === null ? "disconnected" : "timeout",
      };
    if (answer._tag === "gone") return { _tag: "Unanswered", window, reason: "disconnected" };
    const { saved, failures } = answer.response;
    return failures.length === 0
      ? { _tag: "Saved", window, saved }
      : { _tag: "Failed", window, saved, failures };
  };

  const flushFolder: EditorFlush["Service"]["flushFolder"] = Effect.fn("EditorFlush.flushFolder")(
    function* (input) {
      const identity = yield* Effect.tryPromise(() =>
        identifyFolder(input.checkoutRoot, input.folder),
      ).pipe(Effect.option);
      if (identity._tag === "None")
        return {
          _tag: "FolderUnavailable",
          message: "The folder could not be found or examined.",
        } as const;
      const requestId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const request: OpenRequest = {
        request: { requestId, checkoutRoot: input.checkoutRoot, folder: input.folder },
        identity: identity.value,
        timeoutMillis: Duration.toMillis(input.timeout),
        members: new Map(),
        joined: Deferred.makeUnsafe<void>(),
      };
      const start = yield* Clock.currentTimeMillis;
      yield* Effect.sync(() => {
        open.set(requestId, request);
        for (const presence of presences.values()) join(request, presence, start);
      });
      // A server just started may not have heard from its windows yet.
      const settleUntil = startedAt + graceMillis;
      return yield* Effect.gen(function* () {
        for (;;) {
          const now = yield* Clock.currentTimeMillis;
          const waiting = [...request.members.values()].filter(
            (member) => member.answer === null && member.deadline > now,
          );
          const settling = request.members.size === 0 && now < settleUntil;
          if (waiting.length === 0 && !settling) break;
          const wakeAt = settling
            ? settleUntil
            : Math.min(...waiting.map((member) => member.deadline));
          yield* Effect.raceAll([
            ...waiting.map((member) => Deferred.await(member.answered)),
            Deferred.await(request.joined),
            Effect.sleep(Math.max(0, wakeAt - now)),
          ]);
        }
        if (request.members.size === 0) return { _tag: "NoWindowOpen" } as const;
        const windows = [...request.members.values()].map(outcomeOf);
        return {
          _tag: "Answered",
          allSaved: windows.every((outcome) => outcome._tag === "Saved"),
          windows,
        } as const;
      }).pipe(Effect.ensuring(Effect.sync(() => open.delete(requestId))));
    },
  );

  return EditorFlush.of({ connect, resolve, respond, flushFolder });
});

/** A window whose connection dropped counts as present for this long. */
const DEFAULT_PRESENCE_GRACE: Duration.Input = "10 seconds";

export const layerWith = (options: EditorFlushOptions) => Layer.effect(EditorFlush, make(options));

export const layer = layerWith({ presenceGrace: DEFAULT_PRESENCE_GRACE });
