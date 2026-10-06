/** Rejects thread-management dispatches for a project whose repository clone is
 * still running or failed, before any transcript hydration or native dispatch. */
import * as Effect from "effect/Effect";

import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import type { ThreadManagementServiceShape } from "../ThreadManagementService.ts";

export const withProjectCloneGuard = <E, R>(
  make: Effect.Effect<ThreadManagementServiceShape, E, R>,
) =>
  Effect.gen(function* () {
    const cloneTracker = yield* ProjectCloneTracker.ProjectCloneTracker;
    const service = yield* make;
    const orchestrator = yield* Orchestrator.OrchestratorV2;

    const dispatch: ThreadManagementServiceShape["dispatch"] = (command) =>
      Effect.gen(function* () {
        const projectId =
          command.type === "thread.create"
            ? command.projectId
            : command.type === "message.dispatch" ||
                command.type === "queue.resume" ||
                command.type === "queued-message.promote-to-steer"
              ? (yield* orchestrator.getThreadShell(command.threadId))?.projectId
              : undefined;
        if (projectId !== undefined)
          yield* ProjectCloneTracker.rejectCommandsDuringClone(cloneTracker, {
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
        return yield* service.dispatch(command);
      });

    return { ...service, dispatch } satisfies ThreadManagementServiceShape;
  });
