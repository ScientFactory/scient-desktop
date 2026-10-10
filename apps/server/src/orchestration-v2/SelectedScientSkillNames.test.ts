import { assert, it } from "@effect/vitest";
import { skillReleaseKey } from "@scientfactory/scient-skills";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Layer from "effect/Layer";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { BUILT_IN_SKILL_RELEASES } from "../scient/skills/BuiltInSkillReleases.ts";
import * as ScientSkillSession from "../scient/skills/ScientSkillSession.ts";
import { prepareScientV2SkillTurn } from "../scient/skills/ScientV2SkillTurn.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

/**
 * `selectedScientSkillNames` is the only authority for an explicit Scient skill
 * selection. Upstream's V2 `message.dispatch` cutover dropped it, so the field
 * compiled away and every V2 turn silently ran without the user's skills. These
 * tests drive the real decider, the real event store and the real projection
 * read, then hand the persisted message to the same provider-turn preparation
 * V1 uses — the full hop, not a type check.
 */

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("This suite never opens a provider process"),
} satisfies ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistenceMemory;
const testLayer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  McpProviderSessions.layer,
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "selected-scient-skill-names" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    {
      databaseLayer: database,
      runEffectWorker: false,
      mcpProviderSessionsLayer: McpProviderSessions.layer,
    },
  ),
);

const automaticRelease = BUILT_IN_SKILL_RELEASES.find(
  (release) => release.name === "workspace-readiness-review",
)!;
const explicitRelease = BUILT_IN_SKILL_RELEASES.find(
  (release) => release.name === "improve-workspace-readiness",
)!;
const automatic = {
  releaseKey: skillReleaseKey(automaticRelease),
  id: automaticRelease.id,
  name: automaticRelease.name,
  description: automaticRelease.description,
  origin: automaticRelease.origin,
  activationScope: "user" as const,
  invocationPolicy: "automatic" as const,
};
const explicit = {
  releaseKey: skillReleaseKey(explicitRelease),
  id: explicitRelease.id,
  name: explicitRelease.name,
  description: explicitRelease.description,
  origin: explicitRelease.origin,
  activationScope: "user" as const,
  invocationPolicy: "explicit" as const,
};
const stubPlanner: ScientSkillSession.ScientSkillSessionPlannerShape = {
  resolve: () =>
    Effect.succeed({
      delivery: "mcp" as const,
      catalogStatus: "complete" as const,
      releases: new Map([
        [automatic.releaseKey, automaticRelease],
        [explicit.releaseKey, explicitRelease],
      ]),
      skills: [automatic, explicit],
      diagnostics: [],
    }),
};

/** The text a V2 provider turn would receive for a persisted user message. */
const providerTextFor = (text: string, selectedScientSkillNames: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:selected-skills");
    const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
    const previous = yield* mcpSessions.read(threadId);
    yield* mcpSessions.set({
      environmentId: EnvironmentId.make("selected-skills-fixture"),
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerSessionId: "selected-skills-fixture",
      endpoint: "http://127.0.0.1/mcp",
      authorizationHeader: "Bearer selected-skills-fixture",
      capabilities: new Set(["skills:read"]),
    });
    return yield* prepareScientV2SkillTurn({
      threadId,
      driver: ProviderDriverKind.make("codex"),
      mcpSessionInjection: true,
      projectRoot: undefined,
      text,
      selectedScientSkillNames,
    }).pipe(
      Effect.ensuring(
        previous === undefined ? mcpSessions.clear(threadId) : mcpSessions.set(previous),
      ),
    );
  }).pipe(Effect.provideService(ScientSkillSession.ScientSkillSessionPlanner, stubPlanner));

it.effect(
  "carries the composer's explicit skill selection from message.dispatch through the decider into the provider turn text",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:selected-skills");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-selected-skills"),
        threadId,
        projectId: ProjectId.make("project:selected-skills"),
        title: "Skill selection",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });

      const selectedMessageId = MessageId.make("user-message-selected");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("dispatch-selected-skills"),
        createdBy: "user",
        creationSource: "web",
        threadId,
        messageId: selectedMessageId,
        text: `Use $${explicit.name} now.`,
        attachments: [],
        selectedScientSkillNames: [explicit.name],
        dispatchMode: { type: "defer_start" },
      });

      // Same turn without a selection, so the negative case is dispatched too
      // rather than assumed.
      const unselectedMessageId = MessageId.make("user-message-unselected");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("dispatch-no-selection"),
        createdBy: "user",
        creationSource: "web",
        threadId,
        messageId: unselectedMessageId,
        text: `Use $${explicit.name} now.`,
        attachments: [],
        dispatchMode: { type: "defer_start" },
      });

      const projection = yield* projections.getThreadProjection(threadId);
      const selected = projection.messages.find((message) => message.id === selectedMessageId);
      const unselected = projection.messages.find((message) => message.id === unselectedMessageId);
      assert.isDefined(selected);
      assert.isDefined(unselected);

      // Hop 1: the decider persisted the composer's selection on the turn's
      // user message, so the provider turn can read it back.
      assert.deepStrictEqual(selected.selectedScientSkillNames, [explicit.name]);
      assert.isUndefined(unselected.selectedScientSkillNames);

      // Hop 2: the persisted message drives the provider turn text. The selected
      // skill is named; the automatic-only skill is not treated as selected.
      const providerText = yield* providerTextFor(
        selected.text,
        selected.selectedScientSkillNames ?? [],
      );
      assert.isTrue(
        providerText.includes(`- \`${explicit.name}\` (selected by the user)`),
        `provider turn text did not name the selected skill:\n${providerText}`,
      );
      assert.isFalse(
        providerText.includes(`- \`${automatic.name}\` (selected by the user)`),
        `automatic skill was treated as an explicit selection:\n${providerText}`,
      );

      // Hop 3: without the field the same message produces no selection
      // instruction, so the instruction above is caused by the field alone.
      const unselectedText = yield* providerTextFor(
        unselected.text,
        unselected.selectedScientSkillNames ?? [],
      );
      assert.isFalse(
        unselectedText.includes("(selected by the user)"),
        `an unselected turn still claimed a user selection:\n${unselectedText}`,
      );
      assert.isTrue(unselectedText.startsWith(unselected.text));
      assert.include(unselectedText, "[Scient skill scope for this turn: complete; 1 skill;");
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "a credential without a configured injection channel cannot claim selected skill delivery",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:unsupported-selected-skills");
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      yield* mcpSessions.set({
        environmentId: EnvironmentId.make("selected-skills-fixture"),
        threadId,
        providerInstanceId: ProviderInstanceId.make("external-opencode"),
        providerSessionId: "external",
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer stale",
        capabilities: new Set(["skills:read"]),
      });
      const text = yield* prepareScientV2SkillTurn({
        threadId,
        driver: ProviderDriverKind.make("opencode"),
        mcpSessionInjection: false,
        projectRoot: undefined,
        text: "User request",
        selectedScientSkillNames: [explicit.name],
      }).pipe(Effect.ensuring(mcpSessions.clear(threadId)));
      assert.equal(text, "User request");
    }).pipe(
      Effect.provideService(ScientSkillSession.ScientSkillSessionPlanner, stubPlanner),
      Effect.provide(McpProviderSessions.layer),
    ),
);
