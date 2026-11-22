import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

export const KEEP_AWAKE_WORK_PATH = "/api/scient/keep-awake/work";

/** A thread appears with the parents it reports to, so a choice on either one finds it. */
export const KeepAwakeWork = Schema.Struct({
  /** Threads with work that stops if the computer sleeps. */
  working: Schema.Array(ThreadId),
  /** Threads that aren't finished but can sleep: they need an answer, or a wait to end. */
  waiting: Schema.Array(ThreadId),
});
export type KeepAwakeWork = typeof KeepAwakeWork.Type;

/** One thread's "until done" choice, on or off. */
export const KeepAwakeChoice = Schema.Struct({
  threadId: ThreadId,
  enabled: Schema.Boolean,
});
export type KeepAwakeChoice = typeof KeepAwakeChoice.Type;

/** The desktop's "until done" choices. The app-wide hold is the server's `keepAwakeWhileAgentsWork`. */
export const KeepAwakeState = Schema.Struct({
  /** The threads on "until done". */
  threads: Schema.Array(ThreadId),
});
export type KeepAwakeState = typeof KeepAwakeState.Type;
