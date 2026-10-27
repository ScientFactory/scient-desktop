import {
  ProviderSkillManagementError,
  type ProviderSkillSetEnabledInput,
  type ProviderSkillReadDocumentInput,
  type ProviderSkillSetEnabledResult,
} from "@t3tools/contracts";
import * as Path from "effect/Path";
import { readContainedPluginText } from "../extensions/LocalPluginContents.ts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import type { ProviderRegistryShape } from "../../provider/ProviderRegistry.ts";

export interface ProviderSkillManagementShape {
  readonly readDocument: (
    input: ProviderSkillReadDocumentInput,
  ) => Effect.Effect<
    { readonly instructions: string; readonly unavailableReason?: string },
    ProviderSkillManagementError,
    Path.Path
  >;
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
  // Different clients and provider instances may write the same native settings
  // file. Keep each read/write/refresh together; client-side queues alone cannot.
  const writePermit = Semaphore.makeUnsafe(1);
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

  const readDocument = Effect.fn("ProviderSkillManagement.readDocument")(function* (
    input: ProviderSkillReadDocumentInput,
  ) {
    const provider = (yield* providerRegistry.getProviders).find(
      (candidate) => candidate.instanceId === input.instanceId,
    );
    if (!provider)
      return yield* failure({
        ...input,
        reason: "provider_not_found",
        message: "This provider instance is no longer available.",
      });
    const skill = provider.skills.find(
      (candidate) => candidate.name === input.name && candidate.path === input.path,
    );
    if (!skill)
      return yield* failure({
        ...input,
        reason: "skill_not_found",
        message: "This skill is no longer reported by the agent.",
      });
    const path = yield* Path.Path;
    if (!path.isAbsolute(skill.path) || path.basename(skill.path).toLowerCase() !== "skill.md")
      return {
        instructions: "",
        unavailableReason:
          provider.driver === "claudeAgent"
            ? "Bundled with Claude Code; its full text isn't available."
            : "This agent doesn't provide the full text of this skill.",
      };
    const text = yield* Effect.tryPromise({
      try: () => readContainedPluginText(path.dirname(skill.path), skill.path),
      catch: () =>
        failure({
          ...input,
          reason: "provider_rejected",
          message:
            "This skill document could not be read. It must be a local file within its skill folder and at most 256 KB.",
        }),
    });
    return { instructions: text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim() };
  });
  return { readDocument, setEnabled: (input) => writePermit.withPermits(1)(setEnabled(input)) };
}
