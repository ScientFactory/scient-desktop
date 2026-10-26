import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";
import * as Effect from "effect/Effect";
import { connectionAtomRuntime } from "~/connection/runtime";

const changes = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "accounts:changes",
  tag: WS_METHODS.accountsSubscribeChanges,
});
const snapshot = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "accounts:snapshot",
  tag: WS_METHODS.accountsSnapshot,
  staleTimeMs: 30_000,
  idleTtlMs: 60_000,
  refreshTrigger: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
    changes({ environmentId, input: {} }),
});
const lane = {
  scheduler: createAtomCommandScheduler(),
  concurrency: {
    mode: "serial",
    key: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      `accounts:${environmentId}`,
  },
  onSuccess: (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => registry.refresh(snapshot({ environmentId, input: {} }))),
} as const;

export const accountsState = {
  snapshot,
  save: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:save",
    tag: WS_METHODS.accountsSave,
    ...lane,
  }),
  remove: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:remove",
    tag: WS_METHODS.accountsRemove,
    ...lane,
  }),
  test: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:test",
    tag: WS_METHODS.accountsTest,
    ...lane,
  }),
  setControls: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:setControls",
    tag: WS_METHODS.accountsSetControls,
    ...lane,
  }),
  setAgentAccess: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:setAgentAccess",
    tag: WS_METHODS.accountsSetAgentAccess,
    ...lane,
  }),
  updateProfile: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:updateProfile",
    tag: WS_METHODS.accountsProfileUpdate,
    ...lane,
  }),
  removeProfile: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:removeProfile",
    tag: WS_METHODS.accountsProfileRemove,
    ...lane,
  }),
  respondApproval: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:respondApproval",
    tag: WS_METHODS.accountsApprovalRespond,
    ...lane,
  }),
  connectOnePassword: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:connectOnePassword",
    tag: WS_METHODS.accountsOnePasswordConnect,
    ...lane,
  }),
  disconnectOnePassword: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:disconnectOnePassword",
    tag: WS_METHODS.accountsOnePasswordDisconnect,
    ...lane,
  }),
  importPasswords: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:importPasswords",
    tag: WS_METHODS.accountsImportPasswords,
    ...lane,
  }),
  activity: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:activity",
    tag: WS_METHODS.accountsActivity,
  }),
  keychainCandidates: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:keychainCandidates",
    tag: WS_METHODS.accountsKeychainCandidates,
  }),
  matchSignIn: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:matchSignIn",
    tag: WS_METHODS.accountsMatchSignIn,
  }),
  fillValues: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:fillValues",
    tag: WS_METHODS.accountsFillValues,
  }),
};
export const accountsAvailability = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make(
    (get) =>
      environmentId !== null && get(snapshot({ environmentId, input: {} }))._tag === "Success",
  ),
);
