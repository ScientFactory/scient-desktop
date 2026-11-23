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
 * The automatic skill index each thread's current provider session last accepted, by catalog
 * digest. A new provider session (restart, resume in a new process, provider switch) or a changed
 * catalog sends the index again; otherwise the turn points back to it. Server memory only, and
 * bounded: after a server restart or eviction a session simply gets the index once more.
 */
interface SkillIndexDelivery {
  readonly providerSessionId: string;
  readonly digest: string;
  /** The message that carried it: a retry of that same message sends the same full text. */
  readonly messageId: string | undefined;
}
const deliveredSkillIndex = new Map<ThreadId, SkillIndexDelivery>();
const DELIVERED_SKILL_INDEX_LIMIT = 2_000;

const rememberSkillIndex = (threadId: ThreadId, delivery: SkillIndexDelivery) => {
  deliveredSkillIndex.delete(threadId);
  deliveredSkillIndex.set(threadId, delivery);
  if (deliveredSkillIndex.size > DELIVERED_SKILL_INDEX_LIMIT) {
    const oldest = deliveredSkillIndex.keys().next().value;
    if (oldest !== undefined) deliveredSkillIndex.delete(oldest);
  }
};

/**
 * Explicit names on the persisted user message are the sole skill-selection authority; serialized
 * provider text cannot select skills. Prepare each turn from that one snapshot.
 */
export const prepareScientV2SkillScope = Effect.fnUntraced(function* (input: {
  readonly threadId: ThreadId;
  readonly driver: ProviderDriverKind;
  readonly mcpSessionInjection?: boolean;
  readonly projectRoot: string | undefined;
  readonly text: string;
  readonly selectedScientSkillNames: ReadonlyArray<string>;
  /** The persisted message this turn delivers; a retry of it repeats the same text. */
  readonly messageId?: string;
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
  const prepare = (includeCatalogMarker: boolean, catalogIndex?: "full" | "unchanged") =>
    prepareScientSkillTurn(
      input.text,
      deliverable ? plan.skills : [],
      deliverable ? plan.releases : new Map(),
      { ...projection, includeCatalogMarker, ...(catalogIndex ? { catalogIndex } : {}) },
      input.selectedScientSkillNames,
      plan.catalogStatus,
    );
  const fullTurn = prepare(deliverable, "full");
  const digest = deliverable ? fullTurn.catalogIndexDigest : undefined;
  const providerSessionId = mcpSession?.providerSessionId;
  const previous = deliveredSkillIndex.get(input.threadId);
  const alreadyIndexed =
    plan.catalogStatus === "complete" &&
    digest !== undefined &&
    previous !== undefined &&
    previous.providerSessionId === providerSessionId &&
    previous.digest === digest &&
    (input.messageId === undefined || previous.messageId !== input.messageId);
  const skillTurn = alreadyIndexed ? prepare(deliverable, "unchanged") : fullTurn;
  const sendsIndex =
    deliverable &&
    !alreadyIndexed &&
    providerSessionId !== undefined &&
    digest !== undefined &&
    skillTurn.catalogIndexIncluded;
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
    /**
     * Run after the provider accepted a turn that carried this text with its catalog note
     * (not the size fallback, a compaction or a promptless resume).
     */
    recordCatalogDelivered: Effect.sync(() => {
      if (sendsIndex && providerSessionId !== undefined && digest !== undefined)
        rememberSkillIndex(input.threadId, {
          providerSessionId,
          digest,
          messageId: input.messageId,
        });
    }),
  };
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
    "id" | "text" | "context" | "selectedScientSkillNames"
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
    messageId: input.message.id,
  }).pipe(Effect.provideService(ScientSkillSession.ScientSkillSessionPlanner, input.skillPlanner));

/** Validates a steer's prepared text as current input, falling back to the
 * catalog-marker-free text when the marked text does not fit; `useFallback` receives
 * that text. Filesystem reads remain inside the returned validation effect. */
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
    validateProviderCurrentInput({
      text,
      attachments: input.attachments,
      attachmentsDir: input.attachmentsDir,
    });
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
