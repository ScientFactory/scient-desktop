import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as SqlClient from "effect/sql/SqlClient";

class CommitPublicationTransactionError extends Schema.TaggedError<CommitPublicationTransactionError>()(
  "CommitPublicationTransactionError",
  { message: Schema.String },
) {}

/** Keep the application cursor's commit and publication order identical. */
export const makeCommitPublication = Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
  const publication = yield* Semaphore.make(1);
  return Effect.fnUntraced(function* <A, E, R>(
    transaction: Effect.Effect<A, E, R>,
    publish: (value: A) => Effect.Effect<void>,
  ) {
    // Every publishing write acquires the permit before the SQL connection.
    // Reject nested callers rather than invert that order or publish a savepoint.
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
      return yield* new CommitPublicationTransactionError({
        message: "EventSink publishing writes must own their SQL transaction.",
      });
    }
    return yield* publication.withPermit(
      Effect.uninterruptibleMask((restore) =>
        // The body can be interrupted and rolled back. SQL commit and the
        // publication tail stay masked so cancellation cannot strand a commit.
        sql.withTransaction(restore(transaction)).pipe(Effect.tap(publish)),
      ),
    );
  });
});
