import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../ProjectStore.ts";
import * as RuntimePolicy from "../RuntimePolicy.ts";

/**
 * A replay thread's workspace, resolved as production resolves it: its worktree, else its
 * project's root. Upstream's test policy leaves a local thread's cwd null, and the
 * orchestrator then checkpoints `process.cwd()`, which in tests is the source checkout. A
 * thread with no project, which production refuses, gets the disposable replay profile.
 */
export const layer: Layer.Layer<
  RuntimePolicy.RuntimePolicyV2,
  never,
  ProjectStore.ProjectStoreV2 | ServerConfig.ServerConfig
> = Layer.effect(
  RuntimePolicy.RuntimePolicyV2,
  Effect.gen(function* () {
    const base = yield* RuntimePolicy.RuntimePolicyV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const { baseDir } = yield* ServerConfig.ServerConfig;
    return RuntimePolicy.RuntimePolicyV2.of({
      resolve: (input) =>
        base.resolve(input).pipe(
          Effect.filterOrElse(
            (policy) => policy.cwd !== null,
            (policy) =>
              projects.get(input.thread.projectId).pipe(
                Effect.mapError(
                  (cause) =>
                    new RuntimePolicy.RuntimePolicyResolveError({
                      projectId: input.thread.projectId,
                      providerInstanceId: input.modelSelection.instanceId,
                      cause,
                    }),
                ),
                Effect.map((project) => ({
                  ...policy,
                  cwd: Option.match(project, {
                    onNone: () => baseDir,
                    onSome: (row) => row.workspaceRoot,
                  }),
                })),
              ),
          ),
        ),
    });
  }),
).pipe(Layer.provide(RuntimePolicy.layer));
