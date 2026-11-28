import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

const changes = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "accounts:changes",
  tag: WS_METHODS.accountsSubscribeChanges,
});

/** Sign-ins waiting for the user, so the phone can answer what the desktop is waiting on. */
export const accountsEnvironment = {
  snapshot: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "accounts:snapshot",
    tag: WS_METHODS.accountsSnapshot,
    staleTimeMs: 30_000,
    idleTtlMs: 60_000,
    refreshTrigger: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      changes({ environmentId, input: {} }),
  }),
  setAgentAccess: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:setAgentAccess",
    tag: WS_METHODS.accountsSetAgentAccess,
  }),
  setRenewAutomatically: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:setRenewAutomatically",
    tag: WS_METHODS.accountsSetRenewAutomatically,
  }),
  setControls: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:setControls",
    tag: WS_METHODS.accountsSetControls,
  }),
  check: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:check",
    tag: WS_METHODS.accountsCheck,
  }),
  test: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:test",
    tag: WS_METHODS.accountsTest,
  }),
  showHandoff: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:showHandoff",
    tag: WS_METHODS.accountsHandoffShow,
  }),
  signInAsPerson: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:signInAsPerson",
    tag: WS_METHODS.accountsSignInAsPerson,
  }),
  continuePapers: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:continuePapers",
    tag: WS_METHODS.accountsPapersContinue,
  }),
  reveal: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:reveal",
    tag: WS_METHODS.accountsReveal,
  }),
  universitySignIn: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:universitySignIn",
    tag: WS_METHODS.accountsUniversitySignIn,
  }),
  respondApproval: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:respondApproval",
    tag: WS_METHODS.accountsApprovalRespond,
  }),
  cancelHandoff: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:cancelHandoff",
    tag: WS_METHODS.accountsHandoffCancel,
  }),
  dismissNeedsYou: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:dismissNeedsYou",
    tag: WS_METHODS.accountsNeedsYouDismiss,
  }),
  insertHandoffCode: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:insertHandoffCode",
    tag: WS_METHODS.accountsHandoffInsertCode,
  }),
  typeSavedInHandoff: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:useSavedInHandoff",
    tag: WS_METHODS.accountsHandoffUseSaved,
  }),
};
