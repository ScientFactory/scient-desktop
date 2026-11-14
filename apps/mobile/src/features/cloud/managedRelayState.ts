import { useAtomValue } from "@effect/atom-react";
import {
  createManagedRelayQueryManager,
  // SCIENT-FORK:START account-deletion
  deleteManagedRelayAccount,
  // SCIENT-FORK:END account-deletion
  deregisterManagedRelayEnvironment,
  managedRelaySessionAtom,
  readManagedRelaySnapshotState,
} from "@t3tools/client-runtime/relay";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import { AsyncResult, Atom } from "effect/reactivity";

import * as Runtime from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";

const managedRelayAtomRuntime = Atom.runtime(Runtime.layer);

const managedRelayQueryManager = createManagedRelayQueryManager(managedRelayAtomRuntime);

const managedRelayMutationScheduler = createAtomCommandScheduler();

export const deregisterManagedRelayEnvironmentCommand = createRuntimeCommand(
  managedRelayAtomRuntime,
  {
    label: "mobile:managed-relay:deregister-environment",
    scheduler: managedRelayMutationScheduler,
    concurrency: {
      mode: "serial",
      key: (input: { readonly accountId: string; readonly environmentId: EnvironmentId }) =>
        input.accountId,
    },
    execute: (input, registry) => deregisterManagedRelayEnvironment(registry, input),
  },
);

// SCIENT-FORK:START account-deletion
export const deleteManagedRelayAccountCommand = createRuntimeCommand(managedRelayAtomRuntime, {
  label: "mobile:managed-relay:delete-account",
  scheduler: managedRelayMutationScheduler,
  concurrency: {
    mode: "serial",
    key: (input: Parameters<typeof deleteManagedRelayAccount>[1]) => input.accountId,
  },
  execute: (input, registry) => deleteManagedRelayAccount(registry, input),
});
// SCIENT-FORK:END account-deletion

const EMPTY_ENVIRONMENTS_ATOM = Atom.make(
  AsyncResult.success<ReadonlyArray<RelayClientEnvironmentRecord>>([]),
).pipe(Atom.keepAlive, Atom.withLabel("managed-relay:mobile:environments:null"));

export function useManagedRelayEnvironments() {
  const session = useAtomValue(managedRelaySessionAtom);
  const accountId = session?.accountId ?? null;
  const atom = accountId
    ? managedRelayQueryManager.environmentsAtom(accountId)
    : EMPTY_ENVIRONMENTS_ATOM;
  const result = useAtomValue(atom);
  const snapshot = readManagedRelaySnapshotState(result);
  const refresh = () => {
    if (accountId) {
      managedRelayQueryManager.refreshEnvironments(appAtomRegistry, accountId);
    }
  };

  return {
    ...snapshot,
    accountId,
    refresh,
  };
}

export function refreshManagedRelayEnvironments(): void {
  const session = appAtomRegistry.get(managedRelaySessionAtom);
  if (session) {
    managedRelayQueryManager.refreshEnvironments(appAtomRegistry, session.accountId);
  }
}
