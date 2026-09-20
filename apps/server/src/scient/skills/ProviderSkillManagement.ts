import {
  ProviderSkillManagementError,
  type ProviderSkillSetEnabledInput,
  type ProviderSkillSetEnabledResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProviderRegistryShape } from "../../provider/Services/ProviderRegistry.ts";

export interface ProviderSkillManagementShape {
  readonly setEnabled: (
    input: ProviderSkillSetEnabledInput,
  ) => Effect.Effect<ProviderSkillSetEnabledResult, ProviderSkillManagementError>;
}

const failure = (input: {
  readonly instanceId: ProviderSkillSetEnabledInput["instanceId"];
  readonly reason: ProviderSkillManagementError["reason"];
  readonly message: string;
}) => new ProviderSkillManagementError(input);

export function makeProviderSkillManagement(
  providerRegistry: ProviderRegistryShape,
): ProviderSkillManagementShape {
  const setEnabled: ProviderSkillManagementShape["setEnabled"] = Effect.fn(
    "ProviderSkillManagement.setEnabled",
  )(function* (input) {
    const providers = yield* providerRegistry.getProviders;
    const provider = providers.find((candidate) => candidate.instanceId === input.instanceId);
    if (!provider) {
      return yield* failure({
        instanceId: input.instanceId,
        reason: "provider_not_found",
        message: "This provider instance is no longer available.",
      });
    }

    const skill = provider.skills.find(
      (candidate) => candidate.path === input.path && candidate.name === input.name,
    );
    if (!skill) {
      return yield* failure({
        instanceId: input.instanceId,
        reason: "skill_not_found",
        message: "This provider skill is no longer available.",
      });
    }

    const actions = yield* providerRegistry.getProviderSkillActionsForInstance(input.instanceId);
    if (!actions || skill.canSetEnabled !== true) {
      return yield* failure({
        instanceId: input.instanceId,
        reason: "unsupported_provider",
        message: "This provider reports skills as read-only.",
      });
    }

    yield* actions
      .setEnabled({
        name: skill.name,
        path: skill.path,
        ...(skill.scope ? { scope: skill.scope } : {}),
        enabled: input.enabled,
      })
      .pipe(
        Effect.mapError((cause) =>
          failure({
            instanceId: input.instanceId,
            reason: "provider_rejected",
            message: cause.message.trim() || "The provider rejected this skill change.",
          }),
        ),
      );
    const refreshedProviders = yield* providerRegistry.refreshInstance(input.instanceId);
    const refreshedSkill = refreshedProviders
      .find((candidate) => candidate.instanceId === input.instanceId)
      ?.skills.find((candidate) => candidate.path === skill.path && candidate.name === skill.name);
    if (!refreshedSkill) {
      return yield* failure({
        instanceId: input.instanceId,
        reason: "provider_rejected",
        message: `Scient could not verify '${skill.name}' after the provider refresh.`,
      });
    }
    const effectiveEnabled = refreshedSkill.enabled;
    if (effectiveEnabled !== input.enabled) {
      return yield* failure({
        instanceId: input.instanceId,
        reason: "provider_rejected",
        message: `The provider kept '${skill.name}' ${effectiveEnabled ? "enabled" : "disabled"}.`,
      });
    }
    return {
      effectiveEnabled,
      providers: refreshedProviders,
    };
  });

  return { setEnabled };
}
