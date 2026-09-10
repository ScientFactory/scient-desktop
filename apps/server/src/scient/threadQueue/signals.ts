import type { ThreadId } from "@t3tools/contracts";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

// Wakeups are hints only. Admission, ordering and completion always re-read SQL.
// Weak keys isolate concurrently running server/test runtimes and release on close.
const listeners = new WeakMap<SqlClient.SqlClient, Set<(threadId: ThreadId) => void>>();
export function listenQueue(sql: SqlClient.SqlClient, listener: (threadId: ThreadId) => void) {
  let set = listeners.get(sql);
  if (!set) {
    set = new Set();
    listeners.set(sql, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}
export function notifyQueue(sql: SqlClient.SqlClient, threadId: ThreadId) {
  for (const listener of listeners.get(sql) ?? []) listener(threadId);
}
