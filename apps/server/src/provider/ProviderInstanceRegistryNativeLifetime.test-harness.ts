import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import type { ProviderAdapterV2OpenSessionInput } from "../orchestration-v2/ProviderAdapter.ts";
import { AcpProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/AcpAdapterV2.ts";
import {
  makeNativeSessionAdapterV2,
  NativeSessionOperationError,
} from "../orchestration-v2/Adapters/NativeSessionAdapterV2.ts";
import {
  defaultProviderContinuationIdentity,
  type AnyProviderDriver,
  type ProviderDriverCreateInput,
  type ProviderInstance,
} from "./ProviderDriver.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";

const kind = ProviderDriverKind.make("native-lifetime-test");
export const first = ProviderInstanceId.make("native-first");
export const second = ProviderInstanceId.make("native-second");
const configSchema = Schema.Struct({ revision: Schema.Number });
export const configMap = (revision = 1): ProviderInstanceConfigMap => ({
  [first]: { driver: kind, config: { revision } },
  [second]: { driver: kind, config: { revision: 1 } },
});
export const TestLayer = Layer.mergeAll(NodeServices.layer, IdAllocator.layer);
const unused = () =>
  Effect.die("Retained library or snapshot seam must not execute in native lifetime tests");

export const harness = Effect.fnUntraced(function* (options?: {
  readonly openingStarted?: Deferred.Deferred<void>;
  readonly openingGate?: Deferred.Deferred<void>;
  readonly failOpen?: boolean;
  readonly beforeOpen?: (input: ProviderAdapterV2OpenSessionInput) => Effect.Effect<void>;
}) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const log: string[] = [];
  const driver: AnyProviderDriver = {
    driverKind: kind,
    metadata: { displayName: "Native lifetime test" },
    configSchema,
    defaultConfig: () => ({ revision: 1 }),
    create: ({
      instanceId,
      enabled,
      config,
    }: ProviderDriverCreateInput<typeof configSchema.Type>) =>
      Effect.sync(() => {
        log.push(`create:${instanceId}:${config.revision}`);
        return {
          instanceId,
          driverKind: kind,
          enabled,
          displayName: undefined,
          continuationIdentity: defaultProviderContinuationIdentity({
            driverKind: kind,
            instanceId,
          }),
          snapshot: {
            getSnapshot: unused(),
            refresh: unused(),
            streamChanges: Stream.empty,
            resolveMaintenance: unused,
            applyUsageLimits: unused,
          },
          textGeneration: {
            generateCommitMessage: unused,
            generatePrContent: unused,
            generateBranchName: unused,
            generateThreadTitle: unused,
          },
          orchestrationAdapter: makeNativeSessionAdapterV2({
            instanceId,
            driver: kind,
            idAllocator,
            defaultCwd: "/workspace",
            // This scripted native transport captures the host credential during open.
            mcpSessionInjection: true,
            capabilities: AcpProviderCapabilitiesV2,
            continuations: { offer: () => Effect.void },
            open: (input) =>
              Effect.gen(function* () {
                log.push(`open:${instanceId}:${config.revision}`);
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    log.push(`close:${instanceId}:${config.revision}`);
                  }),
                );
                yield* options?.openingStarted
                  ? Deferred.succeed(options.openingStarted, undefined)
                  : Effect.void;
                yield* options?.openingGate ? Deferred.await(options.openingGate) : Effect.void;
                yield* options?.beforeOpen?.(input) ?? Effect.void;
                if (options?.failOpen)
                  return yield* new NativeSessionOperationError({ detail: "Native open failed" });
                return {
                  nativeId: `native:${instanceId}:${config.revision}`,
                  nativeThreadKnown: false,
                  send: () =>
                    Effect.sync(() => {
                      log.push(`send:${instanceId}`);
                    }),
                  interrupt: Effect.sync(() => {
                    log.push(`interrupt:${instanceId}`);
                  }),
                  resume: () =>
                    Effect.sync(() => {
                      log.push(`resume:${instanceId}`);
                    }),
                  respond: () =>
                    Effect.sync(() => {
                      log.push(`respond:${instanceId}`);
                    }),
                };
              }),
          }),
        } satisfies ProviderInstance;
      }),
  };
  const { registry, mutator } = yield* makeProviderInstanceRegistry({
    drivers: [driver],
    configMap: configMap(),
  });
  const callerScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(callerScope, Exit.void));
  const input = (instanceId: ProviderInstanceId, ordinal = 1) => ({
    threadId: ThreadId.make(`thread:${instanceId}`),
    providerSessionId: ProviderSessionId.make(`session:${instanceId}:${ordinal}`),
    modelSelection: { instanceId, model: "test-model" },
    runtimePolicy: {
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      cwd: null,
    },
  });
  const open = (instanceId: ProviderInstanceId, ordinal = 1) =>
    Effect.gen(function* () {
      const instance = yield* registry.getInstance(instanceId);
      if (!instance) return yield* Effect.die("Missing native test instance");
      return yield* instance.orchestrationAdapter
        .openSession(input(instanceId, ordinal))
        .pipe(Effect.provideService(Scope.Scope, callerScope));
    });
  return { registry, mutator, callerScope, log, input, open };
});
