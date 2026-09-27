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
import * as Schema from "effect/Schema";

export class ScientLiveTurnFlushError extends Schema.TaggedError<ScientLiveTurnFlushError>()(
  "ScientLiveTurnFlushError",
  { detail: Schema.String },
) {}

type FlushThread = (threadId: ThreadId) => Effect.Effect<void, ScientLiveTurnFlushError>;

export interface ScientLiveTurnFlushShape {
  readonly register: (flush: FlushThread) => Effect.Effect<void>;
  /** Writes buffered state or fails explicitly when capture cannot complete. */
  readonly flush: FlushThread;
}

export class ScientLiveTurnFlush extends Context.Service<
  ScientLiveTurnFlush,
  ScientLiveTurnFlushShape
>()("t3/orchestration/scient-fork/liveTurnFlush/ScientLiveTurnFlush") {}

/** Bound the wait without mistaking a timeout for completed capture. */
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
              ? Effect.fail(
                  new ScientLiveTurnFlushError({
                    detail:
                      "The running turn cannot be captured because ingestion is unavailable. Retry after reconnecting.",
                  }),
                )
              : flush(threadId).pipe(
                  Effect.timeout(FLUSH_TIMEOUT),
                  Effect.catchTag("TimeoutError", () =>
                    Effect.fail(
                      new ScientLiveTurnFlushError({
                        detail:
                          "Capturing the running turn timed out. Retry the fork; no conversation was created.",
                      }),
                    ),
                  ),
                ),
          ),
        ),
    } satisfies ScientLiveTurnFlushShape;
  }),
);
