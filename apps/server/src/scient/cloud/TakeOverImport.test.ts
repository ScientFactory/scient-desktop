import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type EnvironmentSessionPrincipalShape,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { RepositoryIdentityResolver } from "../../project/RepositoryIdentityResolver.ts";
import { ConversationExportFiles } from "../conversationExport/ConversationExportFiles.ts";
import { ConversationImportStaging } from "../conversationImport/ConversationImportStaging.ts";
import { CloudApi } from "./CloudApi.ts";
import { emptyCloudSyncState, layerInMemory } from "./CloudSyncState.ts";
import { TakeOverImport, layer } from "./TakeOverImport.ts";

const SOURCE = { environmentId: EnvironmentId.make("env-a"), threadId: ThreadId.make("thread-a") };
const IMPORTED = ThreadId.make("thread-b1");
const PROJECT = ProjectId.make("project-lab");

const unused = <S>() => ({}) as unknown as S;

const continuedHere = {
  ...emptyCloudSyncState,
  userId: "user_1",
  continuedFrom: {
    [IMPORTED]: { env: SOURCE.environmentId, thread: SOURCE.threadId, generation: 1 },
  },
};

const refuseDownload: CloudApi["Service"]["getThread"] = () =>
  Effect.die("A repeated take-over must not download again");

const dependencies = (
  state: typeof emptyCloudSyncState,
  getThread: CloudApi["Service"]["getThread"] = refuseDownload,
) =>
  Layer.mergeAll(
    Layer.succeed(CloudApi, {
      ...unused<CloudApi["Service"]>(),
      environmentId: Effect.succeed(EnvironmentId.make("env-b")),
      getThread,
    }),
    Layer.succeed(ProjectionStoreV2, {
      ...unused<ProjectionStoreV2["Service"]>(),
      getThreadShell: (threadId: ThreadId) =>
        Effect.succeed(
          threadId === IMPORTED
            ? ({ id: IMPORTED, projectId: PROJECT, archivedAt: null } as never)
            : null,
        ),
    }),
    Layer.succeed(ProjectStoreV2, {
      ...unused<ProjectStoreV2["Service"]>(),
      list: () =>
        Effect.succeed(
          getThread === refuseDownload
            ? []
            : ([{ projectId: PROJECT, title: "Lab", deletedAt: null, archivedAt: null }] as never),
        ),
    }),
    Layer.succeed(RepositoryIdentityResolver, unused()),
    Layer.succeed(ConversationImportStaging, unused()),
    Layer.succeed(ConversationExportFiles, unused()),
    Layer.succeed(SecureRandom.SecureRandom, unused()),
    layerInMemory(state),
    NodeServices.layer,
  );

const request = {
  source: SOURCE,
  generation: 2,
  projectKey: "github.com/acme/lab",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
};

it.effect("returns the conversation already continued here instead of importing it again", () =>
  Effect.gen(function* () {
    const takeOvers = yield* TakeOverImport;
    const result = yield* takeOvers.takeOver(request, unused<EnvironmentSessionPrincipalShape>());
    expect(result).toEqual({ _tag: "imported", threadId: IMPORTED, projectId: PROJECT });
  }).pipe(Effect.provide(layer.pipe(Layer.provide(dependencies(continuedHere))))),
);

it.effect("does not return a continuation that has itself moved to another computer", () =>
  Effect.gen(function* () {
    const takeOvers = yield* TakeOverImport;
    const result = yield* takeOvers.takeOver(request, unused<EnvironmentSessionPrincipalShape>());
    expect(result).toEqual({ _tag: "choose-project", candidates: [] });
  }).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provide(
          dependencies({
            ...continuedHere,
            moved: {
              [IMPORTED]: {
                movedTo: EnvironmentId.make("env-c"),
                movedAt: "2026-11-11T00:00:00.000Z",
              },
            },
          }),
        ),
      ),
    ),
  ),
);

it.effect("refuses to import when another computer took the lease after this one", () =>
  Effect.gen(function* () {
    const takeOvers = yield* TakeOverImport;
    const error = yield* takeOvers
      .takeOver({ ...request, projectId: PROJECT }, unused<EnvironmentSessionPrincipalShape>())
      .pipe(Effect.flip);
    expect(error.message).toBe("Another computer continued this conversation after you did.");
  }).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provide(
          dependencies({ ...emptyCloudSyncState, userId: "user_1" }, () =>
            Effect.succeed({
              json: new TextEncoder().encode("{}"),
              lease: { holder: "env-c", generation: 3 },
            }),
          ),
        ),
      ),
    ),
  ),
);

it.effect("refuses an invented lease generation", () =>
  Effect.gen(function* () {
    const takeOvers = yield* TakeOverImport;
    const error = yield* takeOvers
      .takeOver(
        { ...request, projectId: PROJECT, generation: 999 },
        unused<EnvironmentSessionPrincipalShape>(),
      )
      .pipe(Effect.flip);
    expect(error.message).toBe("Another computer continued this conversation after you did.");
  }).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provide(
          dependencies({ ...emptyCloudSyncState, userId: "user_1" }, () =>
            Effect.succeed({
              json: new TextEncoder().encode("{}"),
              lease: { holder: "env-b", generation: 2 },
            }),
          ),
        ),
      ),
    ),
  ),
);
