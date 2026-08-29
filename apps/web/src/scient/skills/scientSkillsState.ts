import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "../../connection/runtime";

export const scientSkillsInventory = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:skills:list",
  tag: WS_METHODS.skillsList,
  staleTimeMs: 30_000,
  idleTtlMs: 60_000,
});

export const setScientSkillUserActivation = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:skills:set-user-activation",
  tag: WS_METHODS.skillsSetUserActivation,
  concurrency: {
    mode: "serial",
    key: ({ environmentId }) => environmentId,
  },
  onSuccess: ({ environmentId }, registry) =>
    Effect.sync(() => registry.refresh(scientSkillsInventory({ environmentId, input: {} }))),
});

export const setScientSkillProjectPreference = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:skills:set-project-preference",
  tag: WS_METHODS.skillsSetProjectPreference,
  concurrency: {
    mode: "serial",
    key: ({ environmentId, input }) => JSON.stringify([environmentId, input.projectId]),
  },
  onSuccess: ({ environmentId, input }, registry) =>
    Effect.sync(() =>
      registry.refresh(
        scientSkillsInventory({
          environmentId,
          input: { projectId: input.projectId },
        }),
      ),
    ),
});

export const setProviderSkillEnabled = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:provider-skills:set-enabled",
  tag: WS_METHODS.providerSkillsSetEnabled,
  concurrency: {
    mode: "serial",
    key: ({ environmentId, input }) => JSON.stringify([environmentId, input.instanceId]),
  },
});
