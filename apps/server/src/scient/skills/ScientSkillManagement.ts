import {
  skillReleaseKey,
  toSkillReleaseRef,
  type SkillInvocationPolicy,
} from "@scientfactory/scient-skills";
import {
  ProviderDriverKind,
  ScientSkillManagementError,
  type ScientSkillInventory,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ScientSkillPolicy from "./ScientSkillPolicy.ts";
import * as ScientSkillRegistry from "./ScientSkillRegistry.ts";
import { SCIENT_SKILL_DELIVERY } from "./ScientSkillSession.ts";

export interface ScientSkillManagementShape {
  readonly list: Effect.Effect<ScientSkillInventory>;
  readonly setUserActivation: (input: {
    readonly releaseKey: string;
    readonly active: boolean;
    readonly invocationPolicy: SkillInvocationPolicy;
  }) => Effect.Effect<ScientSkillInventory, ScientSkillManagementError>;
}

const emptyManagement: ScientSkillManagementShape = {
  list: Effect.succeed({ skills: [], supportedProviders: [] }),
  setUserActivation: () =>
    Effect.fail(
      new ScientSkillManagementError({
        operation: "setUserActivation",
        message: "Scient skill management is unavailable in this server composition.",
      }),
    ),
};

/** Inert by default so generic server/test compositions do not acquire product state. */
export class ScientSkillManagement extends Context.Reference<ScientSkillManagementShape>(
  "t3/scient/skills/ScientSkillManagement",
  { defaultValue: () => emptyManagement },
) {}

const supportedProviders = Object.entries(SCIENT_SKILL_DELIVERY)
  .filter(([, delivery]) => delivery === "mcp")
  .map(([provider]) => ProviderDriverKind.make(provider));

const make = Effect.fn("ScientSkillManagement.make")(function* () {
  const registry = yield* ScientSkillRegistry.ScientSkillRegistry;
  const policy = yield* ScientSkillPolicy.ScientSkillPolicy;

  const list = Effect.gen(function* () {
    const snapshot = yield* policy.snapshot;
    const activationByReleaseKey = new Map(
      snapshot.userSkills.map(
        (activation) => [skillReleaseKey(activation.release), activation] as const,
      ),
    );
    return {
      skills: registry.catalog.releases.map((release) => {
        const activation = activationByReleaseKey.get(skillReleaseKey(release));
        return {
          releaseKey: skillReleaseKey(release),
          id: release.id,
          version: release.version,
          name: release.name,
          description: release.description,
          origin: release.origin,
          supportedScopes: [...release.supportedScopes],
          defaultInvocationPolicy: release.defaultInvocationPolicy,
          active: activation !== undefined,
          invocationPolicy: activation?.invocationPolicy ?? release.defaultInvocationPolicy,
        };
      }),
      supportedProviders,
    } satisfies ScientSkillInventory;
  });

  const setUserActivation: ScientSkillManagementShape["setUserActivation"] = Effect.fn(
    "ScientSkillManagement.setUserActivation",
  )(function* (input) {
    const release = registry.resolveReleaseKey(input.releaseKey);
    if (!release) {
      return yield* new ScientSkillManagementError({
        operation: "setUserActivation",
        message: "That exact skill release is not available in this Scient build.",
      });
    }
    if (!release.supportedScopes.includes("user")) {
      return yield* new ScientSkillManagementError({
        operation: "setUserActivation",
        message: "This skill cannot be made available at personal scope.",
      });
    }
    yield* policy
      .setUserSkillActivation(toSkillReleaseRef(release), input.active, input.invocationPolicy)
      .pipe(
        Effect.mapError(
          (error) =>
            new ScientSkillManagementError({
              operation: "setUserActivation",
              message: error.message,
            }),
        ),
      );
    return yield* list;
  });

  return ScientSkillManagement.of({ list, setUserActivation });
});

export const layer = Layer.effect(ScientSkillManagement, make());
