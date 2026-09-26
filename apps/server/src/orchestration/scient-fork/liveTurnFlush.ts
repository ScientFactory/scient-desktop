/**
 * Persist a running turn's buffered text before a fork of it is decided.
 *
 * SCIENT-OWNED. Runtime ingestion holds streamed assistant and reasoning text
 * in memory and writes it in paragraphs, so the event store can lag what the
 * provider has already produced. A fork of the running turn must copy its
 * latest state, so the fork request asks ingestion to write that text first.
 * Ingestion runs the flush on its own ordered queue (never concurrently with
 * the provider events it is still processing) and registers it here, because
 * the fork reactor and ingestion cannot depend on each other directly.
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

type FlushThread = (threadId: ThreadId) => Effect.Effect<void>;

export interface ScientLiveTurnFlushShape {
  readonly register: (flush: FlushThread) => Effect.Effect<void>;
  /** Writes buffered text for the thread; a no-op when ingestion is absent. */
  readonly flush: (threadId: ThreadId) => Effect.Effect<void>;
}

export class ScientLiveTurnFlush extends Context.Service<
  ScientLiveTurnFlush,
  ScientLiveTurnFlushShape
>()("t3/orchestration/scient-fork/liveTurnFlush/ScientLiveTurnFlush") {}

/** A fork should not wait long on a busy ingestion queue; it copies what is persisted. */
const FLUSH_TIMEOUT = Duration.seconds(5);

export const ScientLiveTurnFlushLive = Layer.effect(
  ScientLiveTurnFlush,
  Effect.gen(function* () {
    const registered = yield* Ref.make<FlushThread | null>(null);
    return {
      register: (flush) => Ref.set(registered, flush),
      flush: (threadId) =>
        Ref.get(registered).pipe(
          Effect.flatMap((flush) =>
            flush === null
              ? Effect.void
              : flush(threadId).pipe(Effect.timeoutOption(FLUSH_TIMEOUT), Effect.asVoid),
          ),
        ),
    } satisfies ScientLiveTurnFlushShape;
  }),
);
