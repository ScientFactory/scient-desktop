import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { isPullRequestWatchTask } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

export type RestartThread = Pick<
  EnvironmentThreadShell,
  | "runtime"
  | "blockedOnThreadWait"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingBackgroundTasks"
>;

/**
 * Whether a restart would cut off this thread's work. Awaited work blocks even while a question is
 * open; waiting on the user, another thread, a PR watch or a monitor does not. A child's request
 * shown on this thread does not stop its own turn, so it is not counted as waiting.
 */
export function threadBlocksUpdateRestart(thread: RestartThread): boolean {
  const holdsWork = thread.pendingBackgroundTasks.some(
    (task) =>
      !isPullRequestWatchTask(task) &&
      (task.kind === "subagent" ||
        task.kind === "background_task" ||
        (task.kind === "command" && task.awaited === true)),
  );
  if (holdsWork) return true;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  const status = thread.runtime?.status;
  const running =
    status === "preparing" || status === "queued" || status === "starting" || status === "running";
  return running && thread.blockedOnThreadWait !== true;
}
