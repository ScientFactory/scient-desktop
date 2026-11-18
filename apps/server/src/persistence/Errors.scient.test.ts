import { assert, it } from "@effect/vitest";
import { classifySqliteError, SqlError } from "effect/sql/SqlError";

import { toPersistenceSqlError } from "./Errors.ts";

it.each([{ errno: 1555, code: "SQLITE_CONSTRAINT_PRIMARYKEY" }, { errno: 1 }])(
  "names Bun SQLite condition $errno through the SQL error wrapper",
  (condition) => {
    const driver = Object.assign(new Error("bun-sql-private-sentinel"), {
      name: "SQLiteError",
      ...condition,
    });
    const cause = new SqlError({ reason: classifySqliteError(driver) });
    const error = toPersistenceSqlError("AuthSessionRepository.create:query")(cause);

    assert.equal(
      error.message,
      `SQL error in AuthSessionRepository.create:query: SQLITE(${condition.errno})`,
    );
    assert.equal(error.cause, cause);
  },
);
