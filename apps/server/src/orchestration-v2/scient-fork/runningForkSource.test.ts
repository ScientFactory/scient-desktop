import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as ProjectionStore from "../ProjectionStore.ts";
import type * as ProjectStore from "../ProjectStore.ts";
import { readCurrentRunningForkOwner } from "./runningForkSource.ts";

const owner = {
  threadId: ThreadId.make("running-source"),
  runId: RunId.make("running-run"),
  activeAttemptId: RunAttemptId.make("running-attempt"),
  rootNodeId: NodeId.make("running-root"),
  runOrdinal: 1,
  providerThreadId: ProviderThreadId.make("running-provider-thread"),
  nativeThreadId: "native-thread",
  providerTurnId: ProviderTurnId.make("running-provider-turn"),
  nativeTurnId: "native-turn",
  providerSessionId: ProviderSessionId.make("running-session"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
};

it.effect("a running fork's owner check reads control records, never the history", () =>
  Effect.gen(function* () {
    const requests: Array<{ readonly fields: ReadonlyArray<string>; readonly filter: unknown }> =
      [];
    const projectionStore = {
      getThreadProjection: () => Effect.die("A running fork's owner check read the history."),
      getThreadRecords: (_threadId: ThreadId, fields: ReadonlyArray<string>, filter?: unknown) =>
        Effect.sync(() => {
          requests.push({ fields, filter });
          return {
            thread: { projectId: "project", archivedAt: null, deletedAt: null },
            runs: [],
            attempts: [],
            nodes: [],
            providerThreads: [],
            providerTurns: [],
            providerSessions: [],
            turnItems: [],
          } as never;
        }),
    } as unknown as ProjectionStore.ProjectionStoreV2Shape;
    const projectStore = {
      get: () => Effect.succeed(Option.none()),
    } as unknown as ProjectStore.ProjectStoreV2["Service"];
    // The run is gone from these records: the owner is lost, read without the history.
    const lost = yield* readCurrentRunningForkOwner({ projectionStore, projectStore }, owner).pipe(
      Effect.flip,
    );
    assert.ok(lost._tag === "ProviderTextSnapshotError");
    assert.equal(lost.reason, "owner-lost");
    assert.lengthOf(requests, 1);
    assert.notInclude(requests[0]!.fields, "messages");
    assert.deepEqual(requests[0]!.filter, {
      turnItemRunIds: [owner.runId],
      turnItemTypes: ["run_interrupt_request", "run_interrupt_result"],
    });
  }),
);
