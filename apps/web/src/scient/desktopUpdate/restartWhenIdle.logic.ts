import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { isPullRequestWatchTask } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

export type RestartThread = Pick<
  EnvironmentThreadShell,
  | "runtime"
  | "blockedOnThreadWait"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingBackgroundTasks"
>;

/**
 * Whether restarting this app would cut off work this thread's agent is doing. An agent waiting
 * on you, on another thread, or on a pull request or monitor is not working; it continues after
 * the restart. Work it started and waits on (a build, a subagent) would have to start again.
 */
export function threadBlocksUpdateRestart(thread: RestartThread): boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (thread.pendingSubagentRequest != null) return false;
  const holdsWork = thread.pendingBackgroundTasks.some(
    (task) =>
      !isPullRequestWatchTask(task) &&
      (task.kind === "subagent" ||
        task.kind === "background_task" ||
        (task.kind === "command" && task.awaited === true)),
  );
  if (holdsWork) return true;
  const status = thread.runtime?.status;
  const running =
    status === "preparing" || status === "queued" || status === "starting" || status === "running";
  return running && thread.blockedOnThreadWait !== true;
}
