import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { ComputeMcpGateway } from "./ComputeMcpGateway.ts";
import { listScientComputeInventory } from "./handlers.ts";

it.effect("requires the compute grant before touching the gateway", () => {
  const runtimeInventory = vi.fn(() => Effect.succeed({ languages: [] }));
  return Effect.gen(function* () {
    const error = yield* listScientComputeInventory().pipe(
      Effect.provideService(AgentInvocationContext.AgentInvocationContext, {
        environmentId: EnvironmentId.make("environment-compute-handler-test"),
        threadId: ThreadId.make("thread-compute-handler-test"),
        providerSessionId: "provider-session-compute-handler-test",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set<AgentInvocationContext.OperationCapability>(),
        issuedAt: 1,
      }),
      Effect.provide(Layer.mock(ComputeMcpGateway)({ runtimeInventory })),
      Effect.flip,
    );
    expect(error).toMatchObject({ code: "capability-unavailable" });
    expect(runtimeInventory).not.toHaveBeenCalled();
  });
});
