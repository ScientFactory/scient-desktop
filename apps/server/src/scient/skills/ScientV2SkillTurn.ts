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
export const prepareScientV2SkillTurn = Effect.fnUntraced(function* (input: {
  readonly threadId: ThreadId;
  readonly driver: ProviderDriverKind;
  readonly projectRoot: string | undefined;
  readonly text: string;
  readonly selectedScientSkillNames: ReadonlyArray<string>;
}) {
  const planner = yield* ScientSkillSession.ScientSkillSessionPlanner;
  // V2 adapters have no `mcpSessionInjection` capability flag. The presence of
  // the host-issued session for this thread is the same observable fact: without
  // it there is no channel to deliver a skill through.
  const mcpSession = readMcpProviderSession(input.threadId);
  const plan = yield* planner.resolve({
    provider: input.driver,
    mcpSessionAvailable: mcpSession !== undefined,
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
  const deliverable = plan.delivery === "mcp";
  const skillTurn = prepareScientSkillTurn(
    input.text,
    deliverable ? plan.skills : [],
    deliverable ? plan.releases : new Map(),
    {
      skillListToolName: tools.name("scient_skills_list"),
      skillLoadToolName: tools.name("scient_skill_load"),
      includeCatalogMarker: deliverable && mcpSession?.capabilities.has("skills:read") === true,
      providerNativeSkillTool: tools.providerNativeSkillTool,
      deferred: tools.deferred,
    },
    input.selectedScientSkillNames,
    plan.catalogStatus,
  );
  if (deliverable) {
    // The bearer token stays stable for the provider process, but its exact
    // skill authority is replaced immediately before this turn.
    yield* McpSessionRegistry.replaceActiveMcpSkillScope(input.threadId, skillTurn.skillScope);
  }
  return skillTurn.input ?? input.text;
});
