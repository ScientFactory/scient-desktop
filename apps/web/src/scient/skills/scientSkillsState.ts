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

export const scientSkillDocument = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:skills:document",
  tag: WS_METHODS.skillsReadDocument,
  staleTimeMs: 60_000,
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

export const providerSkillDocument = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:provider-skills:document",
  tag: WS_METHODS.providerSkillsReadDocument,
  staleTimeMs: 60_000,
  idleTtlMs: 60_000,
});

/** What a file, folder, web address or pasted text holds: skills, material, or nothing. */
export const inspectPersonalSkills = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:skills:personal-inspect",
  tag: WS_METHODS.skillsPersonalInspect,
});

export const addPersonalSkills = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:skills:personal-add",
  tag: WS_METHODS.skillsPersonalAdd,
  concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
  onSuccess: ({ environmentId }, registry) =>
    Effect.sync(() => registry.refresh(scientSkillsInventory({ environmentId, input: {} }))),
});

export const removePersonalSkill = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:skills:personal-remove",
  tag: WS_METHODS.skillsPersonalRemove,
  concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
  onSuccess: ({ environmentId }, registry) =>
    Effect.sync(() => registry.refresh(scientSkillsInventory({ environmentId, input: {} }))),
});

export const undoPersonalSkill = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:skills:personal-undo",
  tag: WS_METHODS.skillsPersonalUndo,
  concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
  onSuccess: ({ environmentId }, registry) =>
    Effect.sync(() => registry.refresh(scientSkillsInventory({ environmentId, input: {} }))),
});

export const exportPersonalSkill = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:skills:personal-export",
  tag: WS_METHODS.skillsPersonalExport,
});

/** Skills other agents on that computer have, which Scient can copy in. */
export const listImportableSkills = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:skills:personal-importable",
  tag: WS_METHODS.skillsPersonalImportable,
});
