/** Rejects thread-management dispatches for a project whose repository clone is
 * still running or failed, before any transcript hydration or native dispatch. */
import type { CommandId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import type { ThreadManagementServiceShape } from "../ThreadManagementService.ts";

/** Rejects a thread command for a project whose clone is running or failed. */
export const rejectThreadCommandDuringClone = (
  cloneTracker: ProjectCloneTracker.ProjectCloneTracker["Service"],
  command: { readonly commandId: CommandId; readonly type: string },
  projectId: ProjectId,
) =>
  ProjectCloneTracker.rejectCommandsDuringClone(cloneTracker, {
    type: "thread.create",
    projectId,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new Orchestrator.OrchestratorCommandRejectedError({
          commandId: command.commandId,
          commandType: command.type,
          cause,
        }),
    ),
  );

export const withProjectCloneGuard = Effect.fn("ThreadDispatchCloneGuard.withProjectCloneGuard")(
  function* <E, R>(make: Effect.Effect<ThreadManagementServiceShape, E, R>) {
    const cloneTracker = yield* ProjectCloneTracker.ProjectCloneTracker;
    const service = yield* make;
    const orchestrator = yield* Orchestrator.OrchestratorV2;

    const dispatch: ThreadManagementServiceShape["dispatch"] = Effect.fn(
      "ThreadDispatchCloneGuard.dispatch",
    )(function* (command) {
      const projectId =
        command.type === "thread.create"
          ? command.projectId
          : command.type === "message.dispatch" ||
              command.type === "queue.resume" ||
              command.type === "queued-message.promote-to-steer"
            ? (yield* orchestrator.getThreadShell(command.threadId))?.projectId
            : undefined;
      if (projectId !== undefined)
        yield* rejectThreadCommandDuringClone(cloneTracker, command, projectId);
      return yield* service.dispatch(command);
    });

    return { ...service, dispatch } satisfies ThreadManagementServiceShape;
  },
);
