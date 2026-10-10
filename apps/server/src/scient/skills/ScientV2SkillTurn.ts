import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProviderSession,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import * as Effect from "effect/Effect";

import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { validateProviderCurrentInput } from "../../orchestration-v2/ScientCurrentInput.ts";
import { scientToolProjectionForProvider } from "../../provider/ScientToolProjection.ts";
import { prepareScientSkillTurn } from "./ScientSkillInvocation.ts";
import * as ScientSkillSession from "./ScientSkillSession.ts";

/**
 * The V2 counterpart of V1's `ProviderService.sendTurn` skill block.
 *
 * V1 read `selectedScientSkillNames` off the `thread.turn-start-requested` event
 * payload. V2 persists the same snapshot on the turn's user message and reads it
 * back here, so both engines build one provider turn from one selection set.
 *
 * Everything below is the shared `prepareScientSkillTurn` contract: explicit
 * names are the only selection authority, and serialized provider text is not.
 */
export const prepareScientV2SkillScope = Effect.fnUntraced(function* (input: {
  readonly threadId: ThreadId;
  readonly driver: ProviderDriverKind;
  readonly mcpSessionInjection?: boolean;
  readonly projectRoot: string | undefined;
  readonly text: string;
  readonly selectedScientSkillNames: ReadonlyArray<string>;
}) {
  const planner = yield* ScientSkillSession.ScientSkillSessionPlanner;
  // A token is authority, not proof the configured provider can receive it.
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const mcpSession = yield* mcpSessions.read(input.threadId);
  const plan = yield* planner.resolve({
    provider: input.driver,
    mcpSessionAvailable:
      input.mcpSessionInjection === true && mcpSession?.capabilities.has("skills:read") === true,
    ...(input.projectRoot === undefined ? {} : { projectRoot: input.projectRoot }),
  });
  yield* Effect.forEach(
    plan.diagnostics,
    (diagnostic) =>
      Effect.logWarning("Scient skill delivery was withheld", {
        code: diagnostic.code,
        message: diagnostic.message,
        provider: input.driver,
        ...(plan.projectRoot === undefined ? {} : { projectRoot: plan.projectRoot }),
      }),
    { discard: true },
  );
  const tools = scientToolProjectionForProvider(input.driver);
  // An empty catalog has no release delivery, but still replaces the exact
  // authority of a supported MCP transport on this turn.
  const deliverable =
    ScientSkillSession.scientSkillDeliveryForProvider(input.driver) === "mcp" &&
    plan.delivery !== "unsupported" &&
    input.mcpSessionInjection === true &&
    mcpSession?.capabilities.has("skills:read") === true;
  const projection = {
    skillListToolName: tools.name("scient_skills_list"),
    skillLoadToolName: tools.name("scient_skill_load"),
    providerNativeSkillTool: tools.providerNativeSkillTool,
    deferred: tools.deferred,
  };
  const prepare = (includeCatalogMarker: boolean) =>
    prepareScientSkillTurn(
      input.text,
      deliverable ? plan.skills : [],
      deliverable ? plan.releases : new Map(),
      { ...projection, includeCatalogMarker },
      input.selectedScientSkillNames,
      plan.catalogStatus,
    );
  const skillTurn = prepare(deliverable);
  const text = skillTurn.input ?? input.text;
  const withoutCatalog = prepare(false);
  const withoutCatalogMarker = withoutCatalog.input ?? input.text;
  return {
    baseText: input.text,
    runtimeInstruction: skillTurn.runtimeInstruction,
    runtimeInstructionWithoutCatalogMarker: withoutCatalog.runtimeInstruction,
    text,
    textWithoutCatalogMarker: text === withoutCatalogMarker ? undefined : withoutCatalogMarker,
    // Preparation is inert: shared context validation owns when this scope
    // becomes visible to the provider's already-issued bearer credential.
    publish: deliverable
      ? McpSessionRegistry.replaceActiveMcpSkillScope(input.threadId, skillTurn.skillScope)
      : Effect.void,
  };
});

/** Direct controls retain their existing immediate preparation/publication boundary. */
export const prepareScientV2SkillTurn = Effect.fnUntraced(function* (
  input: Parameters<typeof prepareScientV2SkillScope>[0],
) {
  const prepared = yield* prepareScientV2SkillScope(input);
  yield* prepared.publish;
  return prepared.text;
});

/** A steering message's skill scope, prepared from its persisted selection but not
 * published; the caller publishes after its recheck. Built synchronously and
 * returned unevaluated, so the steer yields exactly the preparation it always did. */
export const prepareScientV2SkillScopeForSteer = (input: {
  readonly threadId: ThreadId;
  readonly session: {
    readonly driver: ProviderDriverKind;
    readonly mcpSessionInjection?: boolean;
    readonly providerSession: Pick<OrchestrationV2ProviderSession, "cwd">;
  };
  readonly message: Pick<
    OrchestrationV2ConversationMessage,
    "text" | "context" | "selectedScientSkillNames"
  >;
  readonly skillPlanner: ScientSkillSession.ScientSkillSessionPlannerShape;
}) =>
  prepareScientV2SkillScope({
    threadId: input.threadId,
    driver: input.session.driver,
    mcpSessionInjection: input.session.mcpSessionInjection === true,
    projectRoot: input.session.providerSession.cwd ?? undefined,
    text: projectComposerContextForProvider({
      text: input.message.text,
      records: input.message.context?.records ?? [],
    }),
    selectedScientSkillNames: input.message.selectedScientSkillNames ?? [],
  }).pipe(Effect.provideService(ScientSkillSession.ScientSkillSessionPlanner, input.skillPlanner));

/** Validates a steer's prepared text as current input, falling back to the
 * catalog-marker-free text when the marked text does not fit; `useFallback` receives
 * that text. Built synchronously, so the steer yields exactly the validation it did. */
export const validateScientV2SteerInput = (input: {
  readonly prepared: {
    readonly text: string;
    readonly textWithoutCatalogMarker: string | undefined;
  };
  readonly attachments: OrchestrationV2ConversationMessage["attachments"];
  readonly attachmentsDir: string;
  readonly useFallback: (text: string) => void;
}) => {
  const validateCurrent = (text: string) =>
    Effect.fromResult(
      validateProviderCurrentInput({
        text,
        attachments: input.attachments,
        attachmentsDir: input.attachmentsDir,
      }),
    );
  return validateCurrent(input.prepared.text).pipe(
    Effect.catchTags({
      ProviderCurrentInputError: (cause) => {
        const fallback = input.prepared.textWithoutCatalogMarker;
        if (fallback === undefined) return Effect.fail(cause);
        input.useFallback(fallback);
        return validateCurrent(fallback);
      },
    }),
  );
};
