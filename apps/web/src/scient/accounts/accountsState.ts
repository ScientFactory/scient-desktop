import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import * as Effect from "effect/Effect";
import { connectionAtomRuntime } from "~/connection/runtime";
import type { SavedAccount } from "./accountsView";

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

/** Accounts saved here since the snapshot shown was read, each with the snapshot it was saved over. */
const savedAccounts = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make<ReadonlyArray<SavedAccount>>([]).pipe(Atom.keepAlive),
);

export const accountsState = {
  snapshot,
  passwordStore: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:passwordStore",
    tag: WS_METHODS.accountsPasswordStore,
    ...lane,
  }),
  /** The current snapshot on demand, for actions that outlive the Accounts page. */
  readSnapshot: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:read-snapshot",
    tag: WS_METHODS.accountsSnapshot,
  }),
  websiteSnapshot: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "accounts:website-snapshot",
    tag: WS_METHODS.accountsSnapshot,
    staleTimeMs: 0,
    idleTtlMs: 0,
  }),
  savedAccounts,
  save: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:save",
    tag: WS_METHODS.accountsSave,
    ...lane,
    // Shown at once, so a form closes onto the new counts; the refresh then replaces it.
    onSuccess: ({ environmentId }, registry, { account }) =>
      Effect.sync(() => {
        const current = snapshot({ environmentId, input: {} });
        if (account) {
          const shown = AsyncResult.getOrElse(registry.get(current), () => null);
          const saved = savedAccounts(environmentId);
          registry.set(saved, [
            ...registry.get(saved).filter((entry) => entry.before === shown),
            { before: shown, account },
          ]);
        }
        registry.refresh(current);
      }),
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
  check: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:check",
    tag: WS_METHODS.accountsCheck,
  }),
  signInSeen: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:signInSeen",
    tag: WS_METHODS.accountsSignInSeen,
    ...lane,
  }),
  googleSessionsSeen: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:googleSessionsSeen",
    tag: WS_METHODS.accountsGoogleSessionsSeen,
    ...lane,
  }),
  sessionsSeen: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:sessionsSeen",
    tag: WS_METHODS.accountsSessionsSeen,
    ...lane,
  }),
  keepTyped: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:keepTyped",
    tag: WS_METHODS.accountsKeepTyped,
  }),
  sessionEnded: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:sessionEnded",
    tag: WS_METHODS.accountsSessionEnded,
    ...lane,
  }),
  setCodeSources: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:setCodeSources",
    tag: WS_METHODS.accountsSetCodeSources,
    ...lane,
  }),
  paperForSource: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:paperForSource",
    tag: WS_METHODS.accountsPaperForSource,
  }),
  requestPapers: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:requestPapers",
    tag: WS_METHODS.accountsPapersRequest,
  }),
  listPapers: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:listPapers",
    tag: WS_METHODS.accountsPapersList,
  }),
  continuePapers: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:continuePapers",
    tag: WS_METHODS.accountsPapersContinue,
  }),
  universitySignIn: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:universitySignIn",
    tag: WS_METHODS.accountsUniversitySignIn,
  }),
  universityBrowse: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:universityBrowse",
    tag: WS_METHODS.accountsUniversityBrowse,
  }),
  searchUniversities: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:searchUniversities",
    tag: WS_METHODS.accountsUniversitySearch,
  }),
  plainKeys: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:plainKeys",
    tag: WS_METHODS.accountsPlainKeys,
  }),
  keepPlainKey: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:keepPlainKey",
    tag: WS_METHODS.accountsKeepPlainKey,
    ...lane,
  }),
  linkKey: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:linkKey",
    tag: WS_METHODS.accountsLinkKey,
    ...lane,
  }),
  unlinkKey: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:unlinkKey",
    tag: WS_METHODS.accountsUnlinkKey,
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
  chooseProfile: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:chooseProfile",
    tag: WS_METHODS.accountsProfileChoose,
    ...lane,
  }),
  mainFilled: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:mainFilled",
    tag: WS_METHODS.accountsMainFilled,
    ...lane,
  }),
  mainSignedOut: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:mainSignedOut",
    tag: WS_METHODS.accountsMainSignedOut,
    ...lane,
  }),
  mainBackfilled: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:mainBackfilled",
    tag: WS_METHODS.accountsMainBackfilled,
    ...lane,
  }),
  showHandoff: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:showHandoff",
    tag: WS_METHODS.accountsHandoffShow,
    ...lane,
  }),
  cancelHandoff: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:cancelHandoff",
    tag: WS_METHODS.accountsHandoffCancel,
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
