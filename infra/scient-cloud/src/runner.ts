import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type * as SqlClient from "effect/sql/SqlClient";
import { isSqlError, type SqlError } from "effect/sql/SqlError";

import type { RunSql } from "./UserStore.ts";

/**
 * One call at a time per object, so each method's reads and writes act as one step even
 * across awaits. SQL failures are defects: the schema is ours and inputs are validated.
 */
export const serialized = (
  provide: <A, E>(
    effect: Effect.Effect<A, E, SqlClient.SqlClient>,
  ) => Effect.Effect<A, E | SqlError>,
): RunSql => {
  const lock = Semaphore.makeUnsafe(1);
  return (effect) =>
    lock
      .withPermits(1)(provide(effect))
      .pipe(Effect.catchIf(isSqlError, (error) => Effect.die(error))) as never;
};
