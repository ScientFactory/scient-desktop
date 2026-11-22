import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { skillReleaseKey } from "@scientfactory/scient-skills";
import {
  type ModelSelection,
  EnvironmentId,
  MessageId,
  NodeId,
  type OrchestrationV2ProviderThread,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { McpScientSkillScope } from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import { BUILT_IN_SKILL_RELEASES } from "../scient/skills/BuiltInSkillReleases.ts";
import * as ScientSkillSession from "../scient/skills/ScientSkillSession.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";

const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;
const release = BUILT_IN_SKILL_RELEASES[0]!;

// The real registry: `publish` replaces the skill scope of the thread's issued credential.
const registryLayer = McpSessionRegistry.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      NodeCrypto.layer,
      Layer.succeed(
        HttpServer.HttpServer,
        HttpServer.HttpServer.of({
          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43124),
          serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
        }),
      ),
      Layer.succeed(
        ServerEnvironment.ServerEnvironment,
        ServerEnvironment.ServerEnvironment.of({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("skill-steer-fixture")),
          getDescriptor: Effect.die("No environment descriptor needed"),
        }),
      ),
    ),
  ),
);

/** What changes between the steer's first load and its recheck. */
type PreparationChange = "replaced-session" | "run-attempt" | "turn-attempt" | "closed-cohort";

interface DeliveredSteer {
  readonly text: string;
  /** The credential's skill scope at the moment the provider received the steer. */
  readonly scope: McpScientSkillScope | undefined;
}

/**
 * One running steer target whose skill planner can change the recorded execution
 * mid-preparation, i.e. after the first load and before the recheck.
 */
const makeSteerFixture = Effect.fnUntraced(function* (input: { readonly delegated?: boolean }) {
  const now = yield* DateTime.now;
  const threadId = ThreadId.make("thread:skill-steer");
  const providerSessionId = ProviderSessionId.make("session:skill-steer");
  const providerThreadId = ProviderThreadId.make("provider-thread:skill-steer");
  const providerTurnId = ProviderTurnId.make("provider-turn:skill-steer");
  const attemptId = RunAttemptId.make("attempt:skill-steer");
  const newAttemptId = RunAttemptId.make("attempt:skill-steer:new");
  const runId = RunId.make("run:skill-steer");
  const parentRunId = RunId.make("run:skill-steer:parent");
  const messageId = MessageId.make("message:skill-steer");
  const providerThread: OrchestrationV2ProviderThread = {
    id: providerThreadId,
    driver,
    providerInstanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "active",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const selection = yield* Ref.make<ReadonlyArray<string>>([release.name]);
  const plannedChange = yield* Ref.make<PreparationChange | undefined>(undefined);
  const change = yield* Ref.make<PreparationChange | undefined>(undefined);
  const delivered = yield* Ref.make<ReadonlyArray<DeliveredSteer>>([]);

  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const issued = yield* registry.issue({
    threadId,
    providerInstanceId,
    capabilities: new Set(["skills:read"]),
  });
  yield* mcpSessions.set(issued.config);
  const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
  const publishedScope = registry.resolve(token).pipe(Effect.map((scope) => scope?.skillScope));

  const makeRuntime = (): ProviderAdapter.ProviderAdapterV2SessionRuntime => ({
    instanceId: providerInstanceId,
    driver,
    providerSessionId,
    mcpSessionInjection: true,
    providerSession: {
      id: providerSessionId,
      driver,
      providerInstanceId,
      status: "running",
      cwd: "/workspace",
      model: modelSelection.model,
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    },
    events: Stream.empty,
    ensureThread: () => Effect.die("unused ensure"),
    resumeThread: () => Effect.die("unused resume"),
    startTurn: () => Effect.die("unused start"),
    steerTurn: ({ message }) =>
      publishedScope.pipe(
        Effect.flatMap((scope) =>
          Ref.update(delivered, (steers) => [...steers, { text: message.text, scope }]),
        ),
      ),
    interruptTurn: () => Effect.die("unused interrupt"),
    respondToRuntimeRequest: () => Effect.die("unused request"),
    readThreadSnapshot: () => Effect.die("unused snapshot"),
    rollbackThread: () => Effect.die("unused rollback"),
    forkThread: () => Effect.die("unused fork"),
  });
  const runtime = makeRuntime();
  const replacementRuntime = makeRuntime();

  const dependencies = Layer.mergeAll(
    Layer.succeed(McpProviderSessions.McpProviderSessions, mcpSessions),
    McpAppModelContext.layerEmpty,
    Layer.mock(EventSink.EventSinkV2)({}),
    ServerConfig.layerTest(process.cwd(), { prefix: "mandatory-input-service-" }).pipe(
      Layer.provideMerge(NodeServices.layer),
    ),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getProviderControlContext: () =>
        Effect.all([Ref.get(selection), Ref.get(change)]).pipe(
          Effect.map(([selectedScientSkillNames, changed]) => ({
            providerThread,
            providerTurn: {
              id: providerTurnId,
              providerThreadId,
              nodeId: NodeId.make("node:skill-steer"),
              runAttemptId: changed === "turn-attempt" ? newAttemptId : attemptId,
              nativeTurnRef: { driver, nativeId: "native-turn:skill-steer", strength: "strong" },
              ordinal: 1,
              status: "running" as const,
              startedAt: now,
              completedAt: null,
            },
            attempt: undefined,
            run: {
              id: runId,
              threadId,
              ordinal: 1,
              providerInstanceId,
              modelSelection,
              providerThreadId,
              userMessageId: messageId,
              rootNodeId: null,
              activeAttemptId: changed === "run-attempt" ? newAttemptId : null,
              status: "running" as const,
              requestedAt: now,
              startedAt: now,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
            message: {
              id: messageId,
              threadId,
              runId,
              nodeId: null,
              role: "user" as const,
              text: `Continue $${release.name}`,
              attachments: [],
              selectedScientSkillNames,
              createdBy: "user" as const,
              creationSource: "web" as const,
              createdAt: now,
              updatedAt: now,
              streaming: false,
              ...(input.delegated
                ? { delegatedCompletion: { parentRunId, generation: 1, taskIds: [] } }
                : {}),
            },
          })),
        ),
      getThreadRecords: () =>
        Ref.get(change).pipe(
          Effect.map(
            (changed) =>
              ({
                runs: [
                  {
                    id: parentRunId,
                    delegatedCompletion: {
                      disposition: changed === "closed-cohort" ? "stopped" : "open",
                      nextGeneration: 2,
                      delivery: {
                        generation: 1,
                        messageId,
                        taskIds: [NodeId.make("node:skill-steer:task")],
                      },
                    },
                  },
                ],
              }) as never,
          ),
        ),
    }),
    Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
      get: () =>
        Ref.get(change).pipe(
          Effect.flatMap((changed) =>
            Effect.succeedSome(changed === "replaced-session" ? replacementRuntime : runtime),
          ),
        ),
    }),
    Layer.succeed(ScientSkillSession.ScientSkillSessionPlanner, {
      // Preparation resolves the plan between the first load and the recheck.
      resolve: () =>
        Ref.get(plannedChange).pipe(
          Effect.flatMap((planned) => Ref.set(change, planned)),
          Effect.as({
            delivery: "mcp" as const,
            catalogStatus: "complete" as const,
            skills: [
              {
                releaseKey: skillReleaseKey(release),
                id: release.id,
                name: release.name,
                description: release.description,
                origin: release.origin,
                activationScope: "user" as const,
                invocationPolicy: "explicit" as const,
              },
            ],
            releases: new Map([[skillReleaseKey(release), release]]),
            diagnostics: [],
          }),
        ),
    }),
  );
  const steer = Effect.gen(function* () {
    const service = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
    return yield* service.steer({
      threadId,
      providerSessionId,
      providerThreadId,
      providerTurnId,
      messageId,
    });
  }).pipe(Effect.provide(ProviderTurnControlService.layer.pipe(Layer.provide(dependencies))));
  return {
    steer,
    selection,
    plannedChange,
    publishedScope,
    delivered: Ref.get(delivered),
  };
});

const provideFixture = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.merge(registryLayer, McpProviderSessions.layer)));

it.effect(
  "prepares steering from the persisted explicit skill selection and clears removed selections",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeSteerFixture({});
      yield* fixture.steer;
      yield* Ref.set(fixture.selection, []);
      yield* fixture.steer;
      const steers = yield* fixture.delivered;
      assert.include(steers[0]!.text, "selected by the user");
      assert.notInclude(steers[1]!.text, "selected by the user");
      assert.include(steers[1]!.text, `$${release.name}`);
      // Each steer's scope is published before the provider receives it, and the
      // second publication clears the removed selection.
      assert.deepEqual(
        steers.map((steer) => steer.scope?.skills.map((skill) => skill.name)),
        [[release.name], []],
      );
    }).pipe(provideFixture),
);

it.effect.each([
  { change: "replaced-session", delegated: false, fails: true },
  { change: "run-attempt", delegated: false, fails: true },
  { change: "turn-attempt", delegated: false, fails: true },
  { change: "closed-cohort", delegated: true, fails: false },
] as const)(
  "never publishes a steer's skill scope when the recheck sees $change",
  ({ change, delegated, fails }) =>
    Effect.gen(function* () {
      const fixture = yield* makeSteerFixture({ delegated });
      yield* Ref.set(fixture.plannedChange, change);
      const result = yield* Effect.result(fixture.steer);
      if (fails) {
        assert.isTrue(result._tag === "Failure");
        assert.equal(
          result._tag === "Failure" ? result.failure.cause : undefined,
          "The recorded steering execution changed during input preparation.",
        );
      } else {
        // A closed delegated cohort drops the steer silently.
        assert.isTrue(result._tag === "Success");
      }
      assert.deepEqual(yield* fixture.delivered, []);
      assert.isUndefined(yield* fixture.publishedScope);
    }).pipe(provideFixture),
);

it.effect("publishes a delegated steer's skill scope when its cohort stays open", () =>
  Effect.gen(function* () {
    const fixture = yield* makeSteerFixture({ delegated: true });
    yield* fixture.steer;
    const steers = yield* fixture.delivered;
    assert.equal(steers.length, 1);
    assert.deepEqual(
      steers[0]!.scope?.skills.map((skill) => skill.name),
      [release.name],
    );
  }).pipe(provideFixture),
);
