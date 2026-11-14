import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

export interface DelegatedTaskOwner {
  readonly threadId: ThreadId;
  readonly childThreadId: ThreadId | null;
}

/** The thread that started an app-owned delegated task; a lookup failure reads as unknown. */
export const findDelegatedTaskOwner = (sql: SqlClient.SqlClient, taskId: string) =>
  sql<{
    readonly thread_id: string;
    readonly child_thread_id: string | null;
  }>`SELECT thread_id, child_thread_id
    FROM orchestration_v2_projection_subagents
    WHERE subagent_id = ${taskId} AND origin = 'app_owned'
    LIMIT 1`.pipe(
    Effect.map(([row]): DelegatedTaskOwner | undefined =>
      row === undefined
        ? undefined
        : {
            threadId: ThreadId.make(row.thread_id),
            childThreadId: row.child_thread_id === null ? null : ThreadId.make(row.child_thread_id),
          },
    ),
    Effect.orElseSucceed(() => undefined),
  );

/** Appended to a task miss the caller may read: whose task it is, and where its work is. */
export const delegatedTaskOwnerHint = (ownerLink: string, childLink: string | undefined) =>
  ` It was started by ${ownerLink}; only that thread can read or cancel it.${
    childLink === undefined
      ? ""
      : ` To see its work, read its child thread ${childLink} with \`scient_thread_inspect\`.`
  }`;
