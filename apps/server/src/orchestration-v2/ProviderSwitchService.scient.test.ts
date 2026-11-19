import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSwitch from "./ProviderSwitchService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import {
  CodexCapabilities,
  makeProviderSession,
  makeProviderThread,
  makeThreadCreatedEvent,
  makeProviderAdapter,
  emptyState,
  modelSelection,
} from "./testkit/ProviderSessionManagerTestHarness.ts";
import * as DateTime from "effect/DateTime";
import * as Ref from "effect/Ref";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ThreadId, ProviderSessionId } from "@t3tools/contracts";

it.effect.each([
  { name: "per-thread workspace", multiple: true, perThread: true, transition: "reuse" },
  {
    name: "process-wide workspace",
    multiple: true,
    perThread: false,
    transition: "restart_and_resume",
  },
  { name: "exclusive process", multiple: false, perThread: true, transition: "restart_and_resume" },
] as const)("uses the negotiated $name authority for a second turn", (scenario) =>
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const now = yield* DateTime.now;
    const state = yield* Ref.make(emptyState);
    const capabilities = {
      ...CodexCapabilities,
      sessions: {
        ...CodexCapabilities.sessions,
        supportsMultipleProviderThreadsPerSession: scenario.multiple,
        supportsPerThreadWorkspace: scenario.perThread,
      },
    };
    const adapter = yield* makeProviderAdapter(state, { capabilities });
    const threadId = ThreadId.make("pooled-workspace");
    const providerSessionId = ProviderSessionId.make("shared-process");
    const thread = (yield* makeThreadCreatedEvent({ idAllocator, threadId, now })).payload;
    const providerThread = makeProviderThread({ idAllocator, threadId, providerSessionId, now });
    const projection = {
      thread: { ...thread, worktreePath: "/second-project" },
      providerSessions: [
        {
          ...makeProviderSession({ providerSessionId, now, capabilities }),
          cwd: "/first-project",
        },
      ],
      providerThreads: [{ ...providerThread, nativeMetadata: { cwd: "/second-project" } }],
    } satisfies Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "providerSessions" | "providerThreads"
    >;
    const service = yield* ProviderSwitch.ProviderSwitchServiceV2.pipe(
      Effect.provide(
        ProviderSwitch.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              RuntimePolicy.layer,
              NodeServices.layer,
              Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
                get: () => Effect.succeed(adapter),
                getMetadata: () =>
                  Effect.succeed({
                    driver: adapter.driver,
                    continuationKey: "codex:account:primary",
                    enabled: true,
                    capabilities,
                  }),
              }),
            ),
          ),
        ),
      ),
    );
    const plan = yield* service.plan({ projection, targetModelSelection: modelSelection });
    assert.equal(plan.transition.type, scenario.transition);
    assert.deepEqual(
      plan.releaseProviderSessionIds,
      scenario.transition === "reuse" ? [] : [providerSessionId],
    );

    if (scenario.transition === "reuse") {
      const moved = yield* service.plan({
        projection,
        targetThread: { ...projection.thread, worktreePath: "/third-project" },
        targetModelSelection: modelSelection,
      });
      assert.equal(moved.transition.type, "restart_and_resume");
      assert.deepEqual(moved.releaseProviderSessionIds, [providerSessionId]);
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
    ),
    Effect.scoped,
  ),
);
