import { ComputeLanguageId } from "@scientfactory/compute";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { WorkspaceBindingResolutionError } from "../../../scient/projectScope/WorkspaceBinding.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import { ComputeMcpGateway } from "./ComputeMcpGateway.ts";
import { listScientComputeInventory } from "./handlers.ts";

it.effect("lets an agent without the compute grant read what is installed", () => {
  const runtimeInventory = vi.fn(() =>
    Effect.succeed({
      languages: [
        {
          descriptor: {
            languageId: ComputeLanguageId.make("cpp"),
            displayName: "C++",
            sourceExtensions: [],
            capabilities: [],
          },
          enabled: true,
          configuredExecutable: null,
          managedRuntime: null,
          toolkits: [],
          installations: [],
          tools: [
            {
              name: "clang++",
              executable: "/usr/bin/clang++",
              version: null,
              origin: "Xcode tools",
            },
          ],
          failureMessage: null,
        },
        {
          descriptor: {
            languageId: ComputeLanguageId.make("zig"),
            displayName: "Zig",
            sourceExtensions: [],
            capabilities: [],
          },
          enabled: true,
          configuredExecutable: null,
          managedRuntime: null,
          toolkits: [],
          installations: [],
          failureMessage: null,
        },
      ],
    }),
  );
  const inspectRuntimes = vi.fn(() =>
    Effect.succeed({ contractVersion: 1 as const, scope: "environment" as const, languages: [] }),
  );
  return Effect.gen(function* () {
    const inventory = yield* listScientComputeInventory().pipe(
      Effect.provideService(AgentInvocationContext.AgentInvocationContext, {
        environmentId: EnvironmentId.make("environment-compute-handler-test"),
        threadId: ThreadId.make("thread-compute-handler-test"),
        providerSessionId: "provider-session-compute-handler-test",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set<AgentInvocationContext.OperationCapability>(),
        issuedAt: 1,
      }),
      Effect.provide(Layer.mock(ComputeMcpGateway)({ runtimeInventory, inspectRuntimes })),
      Effect.provide(
        Layer.mock(WorkspaceBindingResolver)({
          resolveThread: () =>
            Effect.fail(
              new WorkspaceBindingResolutionError({
                operation: "test-resolve",
                kind: "project-required",
              }),
            ),
        }),
      ),
    );
    expect(inventory).toEqual({
      languages: [
        {
          language: "cpp",
          name: "C++",
          status: "clang++ · Xcode tools",
          use: "shell",
          default: null,
          runtimes: [{ executable: "/usr/bin/clang++", version: null, origin: "Xcode tools" }],
        },
      ],
      notFound: ["Zig"],
    });
  });
});
