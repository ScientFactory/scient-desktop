import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { initializeScientProject } from "@scientfactory/project-init";
import { skillReleaseKey, toSkillReleaseRef } from "@scientfactory/scient-skills";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { requireThreadScope, type McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { scientInvocationForMcp } from "../../mcp/ScientMcpInvocation.ts";
import {
  listScientSkillsForInvocation,
  loadScientSkillForInvocation,
} from "../../mcp/toolkits/skills/handlers.ts";
import { providerMessageTextWithAttachmentPaths } from "../../orchestration-v2/AttachmentPrompt.ts";
import { AcpProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/AcpAdapterV2.ts";
import { makeNativeSessionAdapterV2 } from "../../orchestration-v2/Adapters/NativeSessionAdapterV2.ts";
import { runDaemonWithOptions } from "../../orchestration-v2/EffectWorker.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../../orchestration-v2/IdAllocator.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { layerFromAdapters as makeLayer } from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "../../orchestration-v2/testkit/ReplayFixtureWorkspace.ts";
import { AgentInvocationContext } from "../operations/AgentInvocationContext.ts";
import { dispatchScientOperation } from "../operations/AgentOperationDispatcher.ts";
import { BUILT_IN_SKILL_RELEASES } from "./BuiltInSkillReleases.ts";
import * as ScientSkillPolicy from "./ScientSkillPolicy.ts";
import * as ScientSkillRegistry from "./ScientSkillRegistry.ts";
import * as ScientSkillSession from "./ScientSkillSession.ts";
import { prepareScientSkillTurn } from "./ScientSkillInvocation.ts";
import { prepareScientV2SkillScope, prepareScientV2SkillTurn } from "./ScientV2SkillTurn.ts";

const registryLayer = McpSessionRegistry.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(
        HttpServer.HttpServer,
        HttpServer.HttpServer.of({
          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
          serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
        }),
      ),
      Layer.succeed(
        ServerEnvironment.ServerEnvironment,
        ServerEnvironment.ServerEnvironment.of({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("empty-skill-scope-fixture")),
          getDescriptor: Effect.die("No environment descriptor needed"),
        }),
      ),
    ),
  ),
);
const emptyPolicy = { userSkills: [], projectSkills: [], trustedProjects: [] };
const emptyPlanner = ScientSkillSession.layer.pipe(
  Layer.provide(
    Layer.merge(
      ScientSkillRegistry.layerFromCatalog({ releases: [], diagnostics: [] }),
      ScientSkillPolicy.layerFromSnapshot(emptyPolicy),
    ),
  ),
);
const loadFor = Effect.fnUntraced(function* (scope: McpInvocationScope, name: string) {
  const threadScope = yield* requireThreadScope(scope, "skills.load");
  return yield* dispatchScientOperation("skills.load", loadScientSkillForInvocation({ name })).pipe(
    Effect.provideService(AgentInvocationContext, scientInvocationForMcp(threadScope)),
  );
});
const listFor = Effect.fnUntraced(function* (scope: McpInvocationScope) {
  const threadScope = yield* requireThreadScope(scope, "skills.list");
  return yield* dispatchScientOperation("skills.list", listScientSkillsForInvocation()).pipe(
    Effect.provideService(AgentInvocationContext, scientInvocationForMcp(threadScope)),
  );
});

// SCIENT-FORK: share the real native initial-open/ordinary-offer harness across skill policies.
it.live.each(
  (["codex", "cursor", "antigravity", "future-provider"] as const).map((driverName) => {
    const testName =
      driverName === "future-provider"
        ? "withholds initial skill authority for an injectable unknown driver on ordinary V2 native offers"
        : `replaces ${driverName} skills from nonempty to empty on ordinary V2 native offers`;

    return { caseTitle: testName, driverName, testName };
  }),
)("$caseTitle", ({ driverName, testName }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(`empty-skills-${driverName}`);
      const fs = yield* FileSystem.FileSystem;
      yield* Effect.promise(() => initializeScientProject({ root: cwd }));
      const skillPath = `${cwd}/.scient/skills/project-method`;
      yield* fs.makeDirectory(skillPath, { recursive: true });
      yield* fs.writeFileString(
        `${skillPath}/SKILL.md`,
        "---\nname: project-method\ndescription: Reviews bounded fixture evidence.\n---\n\n# Method\n\nPreserve the evidence.\n",
      );
      const allocator = yield* IdAllocatorV2;
      const registry = Context.get(
        yield* Layer.build(registryLayer),
        McpSessionRegistry.McpSessionRegistry,
      );
      const issued = yield* Queue.unbounded<{
        request: McpSessionRegistry.McpCredentialRequest;
        config: McpProviderSession.McpProviderSessionConfig;
      }>();
      const observedRegistry = {
        ...registry,
        issue: (request: McpSessionRegistry.McpCredentialRequest) =>
          registry
            .issue(request)
            .pipe(
              Effect.tap((credential) =>
                Queue.offer(issued, { request, config: credential.config }),
              ),
            ),
      };
      const offered = yield* Queue.unbounded<{
        text: string;
        token: string;
        scope: McpInvocationScope;
      }>();
      const opened = yield* Queue.unbounded<{
        scope: McpInvocationScope;
        config: McpProviderSession.McpProviderSessionConfig;
      }>();
      const threadId = ThreadId.make(`empty-skills-${driverName}`);
      const instanceId = ProviderInstanceId.make(
        driverName === "future-provider" ? "future-provider_skills" : driverName,
      );
      const modelSelection = { instanceId, model: "empty-scope-fixture" };
      let opens = 0;
      const adapter = makeNativeSessionAdapterV2({
        instanceId,
        driver: ProviderDriverKind.make(driverName),
        mcpSessionInjection: true,
        capabilities: AcpProviderCapabilitiesV2,
        idAllocator: allocator,
        defaultCwd: cwd,
        continuations: { offer: () => Effect.die("No native continuation in this fixture") },
        open: (input, publish) =>
          Effect.gen(function* () {
            opens += 1;
            assert.isTrue(input.configureMcp);
            assert.equal(input.threadId, threadId);
            assert.equal(input.modelSelection.instanceId, instanceId);
            const config = McpProviderSession.readMcpProviderSession(input.threadId);
            assert.isDefined(config);
            const token = config!.authorizationHeader.replace(/^Bearer\s+/, "");
            const initial = yield* registry.resolve(token);
            assert.isDefined(initial);
            yield* Queue.offer(opened, { scope: initial!, config: config! });
            return {
              nativeId: `empty-skills-native:${input.providerSessionId}`,
              nativeThreadKnown: true,
              resume: () => Effect.void,
              respond: () => Effect.die("No native question in this fixture"),
              interrupt: publish({ type: "terminal", status: "cancelled" }),
              send: (turn) =>
                Effect.gen(function* () {
                  const scope = yield* registry.resolve(token);
                  assert.isDefined(scope);
                  yield* Queue.offer(offered, {
                    text: providerMessageTextWithAttachmentPaths({
                      ...turn.message,
                      attachmentsDir: cwd,
                    }),
                    token,
                    scope: scope!,
                  });
                  yield* publish({ type: "terminal", status: "completed" });
                }),
            };
          }),
      });
      const serverSettingsLayer = ServerSettings.layerTest({
        enableAgentBrowserAccess: false,
        enableAgentDeviceAccess: false,
      }).pipe(Layer.orDie);
      const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
        { name: `empty-skills-${driverName}`, runtimePolicyOverride: { cwd } },
        makeLayer([adapter]),
        {
          configureMcp: true,
          mcpSessionRegistryLayer: Layer.succeed(
            McpSessionRegistry.McpSessionRegistry,
            observedRegistry,
          ),
          layerServerSettings: serverSettingsLayer,
          runEffectWorker: false,
        },
      ).pipe(Layer.provide(emptyPlanner), Layer.provide(serverSettingsLayer));
      yield* Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        yield* runDaemonWithOptions({ concurrency: 1 }).pipe(Effect.forkScoped);
        const waitFor = Effect.fnUntraced(function* (
          predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
        ) {
          const cursor = yield* orchestrator.getThreadEventSequence(threadId);
          const pull = yield* Stream.toPull(
            orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
          );
          const found = yield* Stream.concat(
            Stream.fromEffect(orchestrator.getThreadProjection(threadId)),
            Stream.fromPull(Effect.succeed(pull)).pipe(
              Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
            ),
          ).pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("10 seconds"));
          assert.isTrue(Option.isSome(found));
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create-${driverName}`),
          threadId,
          projectId: ProjectId.make(`project-${driverName}`),
          title: "Empty scope transition",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const dispatch = (label: string) =>
          orchestrator.dispatch({
            type: "message.dispatch" as const,
            commandId: CommandId.make(`dispatch-${driverName}-${label}`),
            threadId,
            messageId: MessageId.make(`message-${driverName}-${label}`),
            text:
              driverName === "future-provider" ? "Inspect this project." : `User request ${label}`,
            attachments: [],
            dispatchMode: { type: "start_immediately" as const },
            createdBy: "user" as const,
            creationSource: "web" as const,
          });
        yield* dispatch("first");
        const openedSession = yield* Queue.take(opened).pipe(Effect.timeout("10 seconds"));
        const initial = openedSession.scope;
        const issuance = yield* Queue.take(issued).pipe(Effect.timeout("10 seconds"));
        // V2 deliberately retains orchestration/worktree alongside the original tool policy.
        const genericCapabilities = [
          "orchestration",
          "worktree",
          "pull-requests",
          "documents:build",
          "compute:inventory",
          "sources:read",
          "sources:write",
          "threads:read",
        ] as const;
        const expectedCapabilities = new Set([
          ...genericCapabilities,
          ...(driverName === "future-provider" ? [] : (["skills:read"] as const)),
        ]);
        assert.deepEqual(issuance.request.capabilities, expectedCapabilities);
        assert.deepEqual(issuance.config.capabilities, expectedCapabilities);
        assert.deepEqual(openedSession.config.capabilities, expectedCapabilities);
        assert.deepEqual(initial.capabilities, expectedCapabilities);
        assert.isFalse(issuance.request.browserToolsAvailable);
        assert.isUndefined(issuance.config.agentDeviceEnvironment);
        assert.isUndefined(openedSession.config.agentDeviceEnvironment);
        for (const binding of [issuance.request, issuance.config, openedSession.config]) {
          assert.equal(binding.threadId, threadId);
          assert.equal(binding.providerInstanceId, instanceId);
        }
        assert.equal(initial.thread?.threadId, threadId);
        assert.equal(initial.thread?.providerInstanceId, instanceId);
        assert.equal(initial.thread?.providerSessionId, issuance.config.providerSessionId);
        assert.equal(openedSession.config.providerSessionId, issuance.config.providerSessionId);
        if (driverName === "future-provider") {
          assert.isUndefined(issuance.request.skillScope);
          assert.isUndefined(initial.skillScope);
          const first = yield* Queue.take(offered).pipe(Effect.timeout("10 seconds"));
          assert.equal(first.text, "Inspect this project.");
          assert.notInclude(first.text, "Scient skill");
          assert.deepEqual(first.scope, initial);
          yield* waitFor(
            (projection) =>
              projection.providerTurns.length === 1 &&
              projection.providerTurns[0]!.status === "completed" &&
              projection.runs.length === 1 &&
              projection.runs[0]!.status === "completed",
          );
          assert.equal(opens, 1);
          assert.equal(yield* Queue.size(issued), 0);
          return;
        }
        assert.isTrue(initial.capabilities.has("skills:read"));
        assert.deepEqual(initial.skillScope, {
          catalog: { status: "pending" },
          releases: new Map(),
          skills: [],
        });
        assert.deepEqual(issuance.request.skillScope, initial.skillScope);
        const first = yield* Queue.take(offered).pipe(Effect.timeout("10 seconds"));
        assert.include(first.text, "User request first");
        assert.include(first.text, "[Scient skill scope for this turn: complete; 1 skill;");
        assert.deepEqual(
          first.scope.skillScope?.skills.map((skill) => skill.name),
          ["project-method"],
        );
        const descriptor = first.scope.skillScope!.skills[0]!;
        assert.deepEqual([...first.scope.skillScope!.releases.keys()], [descriptor.releaseKey]);
        const loaded = yield* loadFor(first.scope, "project-method");
        assert.equal(loaded.skill.releaseKey, descriptor.releaseKey);
        assert.include(loaded.instructions, "Preserve the evidence.");
        yield* waitFor((projection) =>
          projection.providerTurns.some((turn) => turn.status === "completed"),
        );
        yield* waitFor(
          (projection) =>
            projection.runs.length === 1 && projection.runs[0]!.status === "completed",
        );
        yield* fs.remove(skillPath, { recursive: true });
        yield* dispatch("second");
        const second = yield* Queue.take(offered).pipe(Effect.timeout("10 seconds"));
        assert.equal(second.token, first.token);
        assert.equal(opens, 1);
        assert.include(second.text, "User request second");
        assert.equal(second.scope.skillScope?.catalog?.status, "complete");
        assert.match(second.scope.skillScope!.catalog!.digest!, /^sha256:[0-9a-f]{64}$/u);
        assert.notEqual(
          second.scope.skillScope?.catalog?.digest,
          first.scope.skillScope?.catalog?.digest,
        );
        assert.deepEqual(second.scope.skillScope?.skills, []);
        assert.deepEqual(second.scope.skillScope?.releases, new Map());
        assert.include(second.text, "complete and empty (0 skills)");
        const listing = yield* listFor(second.scope);
        assert.deepEqual(listing.skills, []);
        if (listing.scope.status === "pending")
          return yield* Effect.die("The second turn must have a prepared skill scope");
        assert.equal(listing.scope.status, "complete");
        assert.isTrue(listing.scope.includesAllSkills);
        assert.equal(listing.scope.digest, second.scope.skillScope?.catalog?.digest);
        const denied = yield* loadFor(second.scope, "project-method").pipe(Effect.flip);
        assert.equal(denied._tag, "ScientSkillToolError");
        assert.propertyVal(denied, "code", "not-found");
        yield* waitFor(
          (projection) =>
            projection.providerTurns.length === 2 &&
            projection.providerTurns.every((turn) => turn.status === "completed"),
        );
      }).pipe(Effect.provide(runtime));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, idAllocatorLayer))),
  ),
);

const release = BUILT_IN_SKILL_RELEASES.find(
  (candidate) => candidate.name === "workspace-readiness-review",
)!;
const priorScope = prepareScientSkillTurn(
  "Previous turn",
  [
    {
      releaseKey: skillReleaseKey(release),
      id: release.id,
      name: release.name,
      description: release.description,
      origin: release.origin,
      activationScope: "user",
      invocationPolicy: "automatic",
    },
  ],
  new Map([[skillReleaseKey(release), release]]),
).skillScope;

it.effect(
  "prepares both structural suffixes inertly and publishes the same selected scope once",
  () =>
    Effect.gen(function* () {
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const threadId = ThreadId.make("structural-skill-suffix");
      const issued = yield* registry.issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["skills:read"]),
      });
      McpProviderSession.setMcpProviderSession(issued.config);
      const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
      const before = yield* registry.resolve(token);
      const baseText = "[Scient selected skills for this turn:\nauthored marker\n]";
      const prepared = yield* prepareScientV2SkillScope({
        threadId,
        driver: ProviderDriverKind.make("codex"),
        mcpSessionInjection: true,
        projectRoot: undefined,
        text: baseText,
        selectedScientSkillNames: [release.name],
      }).pipe(
        Effect.provideService(ScientSkillSession.ScientSkillSessionPlanner, {
          resolve: () =>
            Effect.succeed({
              delivery: "mcp" as const,
              catalogStatus: "complete" as const,
              skills: priorScope.skills,
              releases: priorScope.releases,
              diagnostics: [],
            }),
        }),
        Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
      );
      assert.equal(prepared.baseText, baseText);
      assert.equal(prepared.text, `${baseText}\n\n${prepared.runtimeInstruction}`);
      assert.include(prepared.runtimeInstruction!, "Scient skill scope for this turn");
      assert.include(prepared.runtimeInstruction!, "Scient selected skills for this turn");
      assert.notInclude(prepared.runtimeInstruction!, "authored marker");
      assert.equal(
        prepared.textWithoutCatalogMarker,
        `${baseText}\n\n${prepared.runtimeInstructionWithoutCatalogMarker}`,
      );
      assert.notInclude(prepared.runtimeInstructionWithoutCatalogMarker!, "Scient skill scope");
      assert.include(prepared.runtimeInstructionWithoutCatalogMarker!, "Scient selected skills");
      assert.deepEqual(yield* registry.resolve(token), before);
      yield* prepared.publish;
      const after = yield* registry.resolve(token);
      assert.deepEqual(after?.skillScope?.skills, priorScope.skills);
      assert.deepEqual(after?.skillScope?.releases, priorScope.releases);
      assert.notEqual(after?.skillScope?.catalog?.digest, before?.skillScope?.catalog?.digest);
    }).pipe(Effect.provide(registryLayer)),
);

it.effect("replaces incomplete empty authority without claiming a complete empty catalog", () =>
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const threadId = ThreadId.make("incomplete-empty-skill-scope");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["skills:read"]),
      skillScope: priorScope,
    });
    McpProviderSession.setMcpProviderSession(issued.config);
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const text = yield* prepareScientV2SkillTurn({
      threadId,
      driver: ProviderDriverKind.make("codex"),
      mcpSessionInjection: true,
      projectRoot: undefined,
      text: "Next request",
      selectedScientSkillNames: [],
    }).pipe(
      Effect.provide(
        ScientSkillSession.layer.pipe(
          Layer.provide(
            Layer.merge(
              ScientSkillRegistry.layerFromCatalog({ releases: [release], diagnostics: [] }),
              ScientSkillPolicy.layerFromSnapshot(
                {
                  ...emptyPolicy,
                  userSkills: [
                    {
                      release: toSkillReleaseRef(release),
                      active: false,
                      invocationPolicy: "automatic",
                    },
                  ],
                },
                false,
              ),
            ),
          ),
        ),
      ),
      Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
    );
    assert.include(text, "scope for this turn is incomplete; emptiness cannot be inferred");
    assert.notInclude(text, "complete and empty");
    const scope = yield* registry.resolve(token);
    assert.isDefined(scope);
    assert.equal(scope!.skillScope?.catalog?.status, "incomplete");
    assert.deepEqual(scope!.skillScope?.releases, new Map());
    const listing = yield* listFor(scope!);
    assert.equal(listing.scope.status, "incomplete");
    const denied = yield* loadFor(scope!, release.name).pipe(Effect.flip);
    assert.equal(denied._tag, "ScientSkillToolError");
    assert.propertyVal(denied, "code", "not-found");
  }).pipe(Effect.provide(registryLayer)),
);

it.effect.each(
  [
    {
      label: "planner transport rejection",
      driver: "codex",
      injection: true,
      session: true,
      skillsGrant: true,
      plan: {
        delivery: "unsupported" as const,
        catalogStatus: "incomplete" as const,
        releases: new Map<string, typeof release>(),
        skills: [],
        diagnostics: [],
      },
    },
    {
      label: "unknown provider",
      driver: "future-provider",
      injection: true,
      session: true,
      skillsGrant: true,
    },
    {
      label: "no injection channel",
      driver: "codex",
      injection: false,
      session: true,
      skillsGrant: true,
    },
    {
      label: "missing skill grant",
      driver: "codex",
      injection: true,
      session: true,
      skillsGrant: false,
    },
    {
      label: "missing credential",
      driver: "codex",
      injection: true,
      session: false,
      skillsGrant: true,
    },
  ].map((negative) => {
    const forcedPlan = "plan" in negative ? negative.plan : undefined;

    return {
      caseTitle: `withholds empty scope injection for ${negative.label}`,
      negative,
      forcedPlan,
    };
  }),
)("$caseTitle", ({ negative, forcedPlan }) =>
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const threadId = ThreadId.make(`empty-skill-negative-${negative.label}`);
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make(negative.driver),
      capabilities: new Set(negative.skillsGrant ? ["skills:read"] : []),
      skillScope: priorScope,
    });
    if (negative.session) McpProviderSession.setMcpProviderSession(issued.config);
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const before = yield* registry.resolve(token);
    const text = yield* prepareScientV2SkillTurn({
      threadId,
      driver: ProviderDriverKind.make(negative.driver),
      mcpSessionInjection: negative.injection,
      projectRoot: undefined,
      text: "Untouched user request",
      selectedScientSkillNames: [],
    }).pipe(
      Effect.provide(
        forcedPlan === undefined
          ? emptyPlanner
          : Layer.succeed(ScientSkillSession.ScientSkillSessionPlanner, {
              resolve: () => Effect.succeed(forcedPlan),
            }),
      ),
      Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
    );
    assert.equal(text, "Untouched user request");
    assert.deepEqual(yield* registry.resolve(token), before);
  }).pipe(Effect.provide(registryLayer)),
);
