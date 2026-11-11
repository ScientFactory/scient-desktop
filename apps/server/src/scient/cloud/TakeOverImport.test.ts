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

const dependencies = (state: typeof emptyCloudSyncState) =>
  Layer.mergeAll(
    Layer.succeed(CloudApi, {
      ...unused<CloudApi["Service"]>(),
      getThread: () => Effect.die("A repeated take-over must not download again"),
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
      list: () => Effect.succeed([]),
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
