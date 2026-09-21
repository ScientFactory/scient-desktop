import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeProviderRegistryMock } from "../../provider/testUtils/providerRegistryMock.ts";
import { makeProviderSkillManagement } from "./ProviderSkillManagement.ts";

const instanceId = ProviderInstanceId.make("codex-main");

function provider(canSetEnabled = true): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-25T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [
      {
        name: "review",
        path: "/Users/test/.codex/skills/review/SKILL.md",
        scope: "user",
        enabled: true,
        canSetEnabled,
      },
    ],
  };
}

describe("provider skill management", () => {
  it.effect("preserves concurrent skill changes that share native settings", () =>
    Effect.gen(function* () {
      const base = provider();
      let snapshot: ServerProvider = {
        ...base,
        skills: [
          ...base.skills,
          ...base.skills.map((skill) => ({
            ...skill,
            name: "second",
            path: "/skills/second/SKILL.md",
          })),
        ],
      };
      const management = makeProviderSkillManagement({
        ...makeProviderRegistryMock([snapshot]),
        getProviders: Effect.sync(() => [snapshot]),
        getProviderSkillActionsForInstance: () =>
          Effect.succeed({
            setEnabled: (input: { name: string; enabled: boolean }) =>
              Effect.gen(function* () {
                const skills = snapshot.skills;
                yield* Effect.yieldNow;
                snapshot = {
                  ...snapshot,
                  skills: skills.map((skill) =>
                    skill.name === input.name ? { ...skill, enabled: input.enabled } : skill,
                  ),
                };
                return { effectiveEnabled: input.enabled };
              }),
          }),
        refreshInstance: () => Effect.sync(() => [snapshot]),
      });

      yield* Effect.all(
        snapshot.skills.map((skill) =>
          management.setEnabled({ instanceId, name: skill.name, path: skill.path, enabled: false }),
        ),
        { concurrency: "unbounded" },
      );

      expect(snapshot.skills.map((skill) => skill.enabled)).toEqual([false, false]);
    }),
  );

  it.effect("validates the snapshot, delegates to the provider, and refreshes", () =>
    Effect.gen(function* () {
      const snapshot = provider();
      let actionInput:
        | { name: string; path: string; scope?: string | undefined; enabled: boolean }
        | undefined;
      let refreshCount = 0;
      const registry = {
        ...makeProviderRegistryMock([snapshot]),
        getProviderSkillActionsForInstance: () =>
          Effect.succeed({
            setEnabled: (input: {
              name: string;
              path: string;
              scope?: string | undefined;
              enabled: boolean;
            }) =>
              Effect.sync(() => {
                actionInput = input;
                return { effectiveEnabled: false };
              }),
          }),
        refreshInstance: () =>
          Effect.sync(() => {
            refreshCount += 1;
            return [
              {
                ...snapshot,
                skills: snapshot.skills.map((skill) => ({ ...skill, enabled: false })),
              },
            ];
          }),
      };

      const result = yield* makeProviderSkillManagement(registry).setEnabled({
        instanceId,
        name: "review",
        path: "/Users/test/.codex/skills/review/SKILL.md",
        enabled: false,
      });

      expect(actionInput).toEqual({
        name: "review",
        path: "/Users/test/.codex/skills/review/SKILL.md",
        scope: "user",
        enabled: false,
      });
      expect(refreshCount).toBe(1);
      expect(result.effectiveEnabled).toBe(false);
    }),
  );

  it.effect("rejects a change when refreshed provider state does not confirm it", () =>
    Effect.gen(function* () {
      const snapshot = provider();
      const registry = {
        ...makeProviderRegistryMock([snapshot]),
        getProviderSkillActionsForInstance: () =>
          Effect.succeed({
            setEnabled: () => Effect.succeed({ effectiveEnabled: false }),
          }),
        refreshInstance: () => Effect.succeed([snapshot]),
      };

      const error = yield* Effect.flip(
        makeProviderSkillManagement(registry).setEnabled({
          instanceId,
          name: "review",
          path: "/Users/test/.codex/skills/review/SKILL.md",
          enabled: false,
        }),
      );

      expect(error.reason).toBe("provider_rejected");
      expect(error.message).toBe("The provider kept 'review' enabled.");
    }),
  );

  it.effect("keeps unsupported providers read-only", () =>
    Effect.gen(function* () {
      const management = makeProviderSkillManagement(makeProviderRegistryMock([provider(false)]));
      const error = yield* Effect.flip(
        management.setEnabled({
          instanceId,
          name: "review",
          path: "/Users/test/.codex/skills/review/SKILL.md",
          enabled: false,
        }),
      );
      expect(error.reason).toBe("unsupported_provider");
    }),
  );

  it.effect("rejects provider instances that disappeared", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        makeProviderSkillManagement(makeProviderRegistryMock()).setEnabled({
          instanceId,
          name: "review",
          path: "/Users/test/.codex/skills/review/SKILL.md",
          enabled: false,
        }),
      );
      expect(error.reason).toBe("provider_not_found");
    }),
  );

  it.effect("rejects stale skill identities before calling a provider", () =>
    Effect.gen(function* () {
      const management = makeProviderSkillManagement(makeProviderRegistryMock([provider()]));
      const error = yield* Effect.flip(
        management.setEnabled({
          instanceId,
          name: "review",
          path: "/tmp/not-the-current-skill/SKILL.md",
          enabled: false,
        }),
      );
      expect(error.reason).toBe("skill_not_found");
    }),
  );

  it.effect("maps provider failures without refreshing stale state", () =>
    Effect.gen(function* () {
      let refreshCount = 0;
      const registry = {
        ...makeProviderRegistryMock([provider()]),
        getProviderSkillActionsForInstance: () =>
          Effect.succeed({
            setEnabled: () => Effect.fail({ message: "Codex rejected the request." }),
          }),
        refreshInstance: () =>
          Effect.sync(() => {
            refreshCount += 1;
            return [provider()];
          }),
      };
      const error = yield* Effect.flip(
        makeProviderSkillManagement(registry).setEnabled({
          instanceId,
          name: "review",
          path: "/Users/test/.codex/skills/review/SKILL.md",
          enabled: false,
        }),
      );
      expect(error.reason).toBe("provider_rejected");
      expect(error.message).toBe("Codex rejected the request.");
      expect(refreshCount).toBe(0);
    }),
  );
});
