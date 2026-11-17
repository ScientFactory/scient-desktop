import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CommandId, RunId, ThreadId, type OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import * as DocumentText from "../../provider/DocumentText.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { OrchestratorDispatchError } from "../Orchestrator.ts";
import * as ThreadManagementService from "../ThreadManagementService.ts";
import { dispatchCommand } from "../ThreadMessageIntake.ts";

// Scient builds before 0.6.26 send a held message now as `queue.resume` with its runId.
// Client intake reads that as upstream's `queued-run.start`.

const layerIntake = ServerConfig.layerTest(process.cwd(), {
  prefix: "scient-queued-run-send-",
}).pipe(
  Layer.provideMerge(
    Layer.merge(
      DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer)),
      Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
);

const capturingDispatch = (captured: OrchestrationV2ServerCommand[]) =>
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    dispatch: (command: OrchestrationV2ServerCommand) => {
      captured.push(command);
      return Effect.fail(
        new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Stop after intake",
        }),
      );
    },
  });

const threadId = ThreadId.make("thread-held-queue");

it.effect("reads an older client's queue.resume with a runId as queued-run.start", () =>
  Effect.gen(function* () {
    const captured: OrchestrationV2ServerCommand[] = [];
    yield* dispatchCommand({
      type: "queue.resume",
      commandId: CommandId.make("older-client-send"),
      threadId,
      runId: RunId.make("second-held-run"),
    }).pipe(Effect.provide(capturingDispatch(captured)), Effect.result);
    expect(captured).toEqual([
      {
        type: "queued-run.start",
        commandId: CommandId.make("older-client-send"),
        threadId,
        runId: RunId.make("second-held-run"),
      },
    ]);
  }).pipe(Effect.provide(layerIntake)),
);

it.effect("passes a plain queue.resume through unchanged", () =>
  Effect.gen(function* () {
    const captured: OrchestrationV2ServerCommand[] = [];
    const resume = {
      type: "queue.resume" as const,
      commandId: CommandId.make("resume-queue"),
      threadId,
    };
    yield* dispatchCommand(resume).pipe(Effect.provide(capturingDispatch(captured)), Effect.result);
    expect(captured).toEqual([resume]);
  }).pipe(Effect.provide(layerIntake)),
);
