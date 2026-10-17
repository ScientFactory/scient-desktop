import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../../config.ts";
import { ProjectStoreV2 } from "../ProjectStore.ts";
import {
  RuntimePolicyResolveError,
  RuntimePolicyV2,
  layer as layerBasePolicy,
} from "../RuntimePolicy.ts";

/** Replay transports keep their policy modes, but workspace authority comes from the fixture. */
export const layer = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const base = yield* RuntimePolicyV2;
    const projects = yield* ProjectStoreV2;
    const config = yield* ServerConfig;
    return RuntimePolicyV2.of({
      resolve: (input) =>
        base.resolve(input).pipe(
          Effect.flatMap((policy) =>
            policy.cwd !== null
              ? Effect.succeed(policy)
              : projects.get(input.thread.projectId).pipe(
                  Effect.mapError(
                    (cause) =>
                      new RuntimePolicyResolveError({
                        projectId: input.thread.projectId,
                        providerInstanceId: input.modelSelection.instanceId,
                        cause,
                      }),
                  ),
                  Effect.map((project) => ({
                    ...policy,
                    cwd: Option.match(project, {
                      onNone: () => config.cwd,
                      onSome: (row) => row.workspaceRoot,
                    }),
                  })),
                ),
          ),
        ),
    });
  }),
).pipe(Layer.provide(layerBasePolicy));
