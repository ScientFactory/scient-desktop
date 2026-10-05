import type { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { readMcpProviderSession } from "../../mcp/McpProviderSession.ts";
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
  const mcpSession = readMcpProviderSession(input.threadId);
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
